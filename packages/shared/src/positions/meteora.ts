/**
 * Meteora LP positions — total USD value across all pool types (DAMM v1/v2,
 * DLMM, dynamic vaults).
 *
 * Meteora exposes a wallet-positions endpoint that already returns USD
 * valuations, so we don't need to crack open the on-chain layout:
 *   https://docs.meteora.ag/api-reference/home
 *
 * Endpoint discovery: the docs list a few base hosts depending on pool type.
 * For an aggregate wallet view we query the unified `/positions` endpoint
 * on each known service and sum.
 *
 * If a host is down we skip it — partial 0 is better than a hard failure.
 */

interface PositionResponse {
  // Different endpoints return different shapes; we accept any with a usd
  // field per item. Each entry that we recognise contributes to the sum.
  positions?: Array<{ value_usd?: number | string; usd?: number | string }>;
  data?: Array<{ value_usd?: number | string; usd?: number | string }>;
}

const ENDPOINTS = [
  // DAMM v2 (Dynamic AMM)
  (wallet: string) => `https://amm-v2.meteora.ag/positions/${wallet}`,
  // Dynamic vaults
  (wallet: string) => `https://amm.meteora.ag/wallets/${wallet}/positions`,
  // DLMM (concentrated liquidity)
  (wallet: string) => `https://dlmm-api.meteora.ag/positions/${wallet}`,
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
    const body = (await res.json()) as PositionResponse | unknown;
    const items: Array<{ value_usd?: number | string; usd?: number | string }> = [];
    if (Array.isArray(body)) {
      items.push(...(body as Array<{ value_usd?: number | string; usd?: number | string }>));
    } else if (body && typeof body === "object") {
      const obj = body as PositionResponse;
      if (Array.isArray(obj.positions)) items.push(...obj.positions);
      if (Array.isArray(obj.data)) items.push(...obj.data);
    }
    return items.reduce((acc, it) => acc + pickUsd(it.value_usd ?? it.usd), 0);
  } catch {
    return 0;
  }
}

export async function getMeteoraPositionsUsd(wallet: string): Promise<number> {
  const sums = await Promise.all(ENDPOINTS.map((fn) => fetchEndpointUsd(fn(wallet))));
  return sums.reduce((a, b) => a + b, 0);
}
