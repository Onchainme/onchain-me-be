/**
 * Jupiter Price API v3 client.
 *
 * Free, no API key. Returns current USD prices for token mints; we use the
 * scan-time price for historical txs as a pragmatic approximation (perfect
 * historical pricing would need Birdeye, which is rate-limited on free tier).
 *
 *   GET https://lite-api.jup.ag/price/v3?ids=<mint1,mint2,...>
 *
 * Up to ~100 mints per call. We cache responses for 60s in-memory to avoid
 * hammering the API when the worker batches a wallet scan.
 *
 * Migration note (2026-05): Jupiter deprecated /price/v2 → 404. The v3 endpoint
 * also changed shape: response is a flat top-level map (no `data` wrapper),
 * price field renamed `price` → `usdPrice`. See:
 *   https://station.jup.ag/docs/apis/price-api
 */

const PRICE_API = "https://lite-api.jup.ag/price/v3";
const CACHE_TTL_MS = 60_000;
const MAX_IDS_PER_CALL = 100;

interface CachedPrice {
  usd: number;
  expiresAt: number;
}

const cache = new Map<string, CachedPrice>();

interface JupPriceV3Entry {
  usdPrice: number;
  decimals: number;
  blockId?: number;
  liquidity?: number;
  priceChange24h?: number;
  createdAt?: string;
}
type JupPriceV3Response = Record<string, JupPriceV3Entry | null>;

async function fetchBatch(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  const url = `${PRICE_API}?ids=${encodeURIComponent(mints.join(","))}`;
  const res = await globalThis.fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Jupiter Price API ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as JupPriceV3Response;
  const out: Record<string, number> = {};
  for (const mint of mints) {
    const entry = body[mint];
    if (!entry) continue;
    const price =
      typeof entry.usdPrice === "number" ? entry.usdPrice : Number(entry.usdPrice);
    if (Number.isFinite(price) && price > 0) out[mint] = price;
  }
  return out;
}

/**
 * Get current USD prices for a list of mints. Returns a map of mint→price.
 * Mints with no available price are simply absent from the result.
 */
export async function getUsdPrices(mints: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  const out: Record<string, number> = {};
  const toFetch: string[] = [];

  for (const mint of mints) {
    if (!mint) continue;
    const cached = cache.get(mint);
    if (cached && cached.expiresAt > now) {
      out[mint] = cached.usd;
    } else {
      toFetch.push(mint);
    }
  }

  if (toFetch.length === 0) return out;

  // Chunk if needed.
  const fetched: Record<string, number> = {};
  for (let i = 0; i < toFetch.length; i += MAX_IDS_PER_CALL) {
    const batch = toFetch.slice(i, i + MAX_IDS_PER_CALL);
    try {
      Object.assign(fetched, await fetchBatch(batch));
    } catch (err) {
      // Don't fail the whole scan because of a price hiccup; just leave the
      // missing mints unpriced (callers must handle missing prices).
      console.warn(`[prices] batch lookup failed for ${batch.length} mints: ${(err as Error).message}`);
    }
  }

  const expiresAt = now + CACHE_TTL_MS;
  for (const [mint, usd] of Object.entries(fetched)) {
    cache.set(mint, { usd, expiresAt });
    out[mint] = usd;
  }
  return out;
}

/** Convenience: USD value for a single (mint, amount, decimals) triple. */
export function usdValue(
  amount: bigint | number,
  decimals: number,
  pricePerUnit: number | undefined,
): number {
  if (!pricePerUnit) return 0;
  const raw = typeof amount === "bigint" ? Number(amount) : amount;
  return (raw / 10 ** decimals) * pricePerUnit;
}

/** Test helper — clears the in-memory cache. */
export function _resetPriceCache(): void {
  cache.clear();
}
