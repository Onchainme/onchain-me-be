import { loadEnv } from "../env.js";

export interface DasAsset {
  id: string;
  interface: string;
  content?: {
    /** Off-chain metadata URI — e.g. https://api.onchainme.to/api/v1/metadata/<badgeId>.json */
    json_uri?: string;
    metadata?: {
      name?: string;
      symbol?: string;
      token_standard?: string;
    };
  };
  compression?: {
    compressed?: boolean;
    tree?: string;
    leaf_id?: number;
  };
}

export interface DasGetAssetsByOwnerResult {
  total: number;
  limit: number;
  cursor?: string;
  items: DasAsset[];
}

/**
 * Fetch all assets owned by `ownerAddress` from the DAS-compatible RPC.
 * Pages through the cursor automatically. Public devnet/mainnet Solana RPCs
 * support DAS now (no Helius key needed for basic getAssetsByOwner).
 */
export async function getAssetsByOwner(ownerAddress: string): Promise<DasAsset[]> {
  const env = loadEnv();
  const all: DasAsset[] = [];
  let cursor: string | undefined;
  // Cap iterations defensively; 10 pages × 1000 limit = 10k assets is enough for our use.
  for (let page = 0; page < 10; page++) {
    const params: Record<string, unknown> = {
      ownerAddress,
      limit: 1000,
    };
    if (cursor) params["cursor"] = cursor;

    const res = await globalThis.fetch(env.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAssetsByOwner",
        params,
      }),
    });
    if (!res.ok) {
      throw new Error(`DAS getAssetsByOwner failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as
      | { result: DasGetAssetsByOwnerResult }
      | { error: { code: number; message: string } };
    if ("error" in json) {
      throw new Error(`DAS error: ${json.error.code} ${json.error.message}`);
    }
    const result = json.result;
    all.push(...result.items);
    if (!result.cursor || result.items.length < result.limit) break;
    cursor = result.cursor;
  }
  return all;
}
