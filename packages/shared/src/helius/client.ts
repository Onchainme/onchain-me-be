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

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
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
      throw new AppError({
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

export async function fetchAllTransactionsCappedAt(
  wallet: string,
  cap: number,
  until?: string,
): Promise<HeliusEnhancedTx[]> {
  const out: HeliusEnhancedTx[] = [];
  let before: string | undefined = undefined;

  while (out.length < cap) {
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
