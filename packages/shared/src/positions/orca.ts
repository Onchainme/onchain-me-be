/**
 * Orca Whirlpools position value (USD) for a wallet.
 *
 * Orca's Whirlpools program represents each LP position as an NFT. To get the
 * USD value we'd need to:
 *   1. Find position NFTs owned by the wallet,
 *   2. Decode `liquidity`, `tickLower`, `tickUpper` from each,
 *   3. Read the whirlpool state (current tick, token_a, token_b),
 *   4. Compute current underlying token amounts and convert to USD.
 *
 * For v1 we use Orca's hosted REST endpoint when available. It returns a
 * pre-computed total USD value of the wallet's positions. Fail-soft → 0
 * on any error so the surrounding scan job keeps moving.
 *
 * If/when this proves unreliable, the next step is integrating
 * `@orca-so/whirlpools-sdk` directly (heavier, but authoritative).
 */

interface OrcaPositionsResponse {
  // Best-effort shape based on Orca's public position endpoints. We pull
  // the first field that looks like a USD total.
  totalUsd?: number | string;
  total_usd?: number | string;
  totalValueUsd?: number | string;
  positions?: Array<{ value_usd?: number | string; usd?: number | string }>;
}

const ENDPOINTS = [
  (wallet: string) => `https://api.mainnet.orca.so/v1/whirlpool/positions?wallet=${wallet}`,
];

function pickUsd(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

async function fetchEndpointUsd(url: string): Promise<number> {
  try {
    const res = await globalThis.fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return 0;
    const body = (await res.json()) as OrcaPositionsResponse | unknown;
    if (Array.isArray(body)) {
      return (body as Array<{ value_usd?: number | string; usd?: number | string }>).reduce(
        (acc, it) => acc + pickUsd(it.value_usd ?? it.usd),
        0,
      );
    }
    if (body && typeof body === "object") {
      const obj = body as OrcaPositionsResponse;
      const direct = pickUsd(obj.totalUsd ?? obj.total_usd ?? obj.totalValueUsd);
      if (direct > 0) return direct;
      if (Array.isArray(obj.positions)) {
        return obj.positions.reduce((acc, it) => acc + pickUsd(it.value_usd ?? it.usd), 0);
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function getOrcaPositionsUsd(wallet: string): Promise<number> {
  const sums = await Promise.all(ENDPOINTS.map((fn) => fetchEndpointUsd(fn(wallet))));
  return sums.reduce((a, b) => a + b, 0);
}
