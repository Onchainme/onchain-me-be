import { loadEnv } from "../env.js";
import { AppError, ErrorCode } from "../errors.js";
import { heliusEnhancedTxArraySchema, type HeliusEnhancedTx } from "./schema.js";

const BASE = "https://api.helius.xyz/v0";

export interface FetchTxsOpts {
  wallet: string;
  before?: string;
  until?: string;
  limit?: number;
}

/**
 * Sentinel class used so withRetry can distinguish "don't retry, propagate"
 * from transient errors. Currently used for 429s — burning local retries
 * against a rate-limit response just makes the limit worse, and BullMQ's
 * outer `attempts`+`backoff` (4-8s exponential delay) is the right place to
 * pace re-attempts.
 */
class NonRetryableHeliusError extends AppError {}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 429 means we're hitting Helius too hard right now — local retries
      // would just compound the problem. Bubble up to BullMQ immediately.
      if (err instanceof NonRetryableHeliusError) throw err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

export async function fetchEnhancedTransactions(opts: FetchTxsOpts): Promise<HeliusEnhancedTx[]> {
  const env = loadEnv();
  const url = new URL(`${BASE}/addresses/${opts.wallet}/transactions`);
  url.searchParams.set("api-key", env.HELIUS_API_KEY);
  url.searchParams.set("limit", String(opts.limit ?? 100));
  if (opts.before) url.searchParams.set("before", opts.before);
  if (opts.until) url.searchParams.set("until", opts.until);

  const json = await withRetry(async () => {
    const res = await fetch(url.toString(), { method: "GET" });
    if (res.status === 429) {
      // NonRetryableHeliusError skips withRetry's exp-backoff and lets BullMQ's
      // job-level attempts:3/5 + 4-8s exponential backoff pace the retry.
      throw new NonRetryableHeliusError({
        code: ErrorCode.HELIUS_UNAVAILABLE,
        message: "Helius rate-limited (429)",
        statusCode: 503,
      });
    }
    if (!res.ok) {
      throw new AppError({
        code: ErrorCode.HELIUS_UNAVAILABLE,
        message: `Helius returned ${res.status}: ${await res.text()}`,
        statusCode: 503,
      });
    }
    return res.json();
  });

  const parsed = heliusEnhancedTxArraySchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError({
      code: ErrorCode.HELIUS_UNAVAILABLE,
      message: `Helius response did not match schema: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      statusCode: 502,
      details: { issues: parsed.error.issues.slice(0, 5) },
    });
  }
  return parsed.data;
}

/**
 * Pause between paginated Helius requests. Helius free tier advertises 10 RPS,
 * but Cloudflare's burst detection trips at much lower rates if requests come
 * from the same TCP connection (which Node's fetch reuses via undici). 250ms
 * caps us at 4 RPS, well under the burst threshold, and adds at most 12 seconds
 * to a full 5000-tx scan — acceptable for a once-per-user-click flow.
 */
const HELIUS_PAGINATION_DELAY_MS = 250;

export async function fetchAllTransactionsCappedAt(
  wallet: string,
  cap: number,
  until?: string,
): Promise<HeliusEnhancedTx[]> {
  const out: HeliusEnhancedTx[] = [];
  let before: string | undefined = undefined;
  let isFirstPage = true;

  while (out.length < cap) {
    // Throttle between pages, but skip the delay before the very first request
    // so a 1-page scan stays snappy.
    if (!isFirstPage) {
      await new Promise((r) => setTimeout(r, HELIUS_PAGINATION_DELAY_MS));
    }
    isFirstPage = false;

    const batch = await fetchEnhancedTransactions({
      wallet,
      ...(before !== undefined ? { before } : {}),
      ...(until !== undefined ? { until } : {}),
      limit: Math.min(100, cap - out.length),
    });
    if (batch.length === 0) break;
    out.push(...batch);
    const last = batch.at(-1);
    if (!last) break;
    before = last.signature;
    if (batch.length < 100) break;
  }

  return out;
}
