import { loadEnv } from "../env.js";

export type ConfirmedTxStatus =
  | { status: "success"; signature: string; slot: number; assetId: string | null }
  | { status: "failed"; signature: string; err: unknown }
  | { status: "not_found"; signature: string };

// Bubblegum's MintV1 emits a program log of the form:
//   "Program log: Leaf asset ID: <base58 pubkey>"
// (note: spaced & lowercase). We also keep the legacy "AssetId:" form as a
// fallback in case a future Bubblegum version changes the wording back.
const ASSET_ID_LOG_RE =
  /(?:Leaf\s+asset\s+ID|asset\s*ID|AssetId):\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i;

/**
 * Fetch a transaction's status and parse the AssetId from program logs.
 *
 * NOTE: We intentionally bypass `web3.js` Connection here and hand-roll the
 * JSON-RPC call via `globalThis.fetch`. The reason is the same as in
 * prepare.ts: `@solana/web3.js` captures `globalThis.fetch` at *module load
 * time* into a private `fetchImpl` variable, so MSW's interceptor — which
 * patches `globalThis.fetch` at runtime in `beforeAll` — cannot intercept
 * calls made through `Connection`. Using `globalThis.fetch` directly ensures
 * MSW can intercept the request in test environments.
 */
export async function fetchTransactionStatus(signature: string): Promise<ConfirmedTxStatus> {
  const env = loadEnv();

  const response = await globalThis.fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          commitment: "confirmed",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `getTransaction RPC call failed: ${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }

  const json = (await response.json()) as {
    result: {
      slot: number;
      meta: {
        err: unknown;
        logMessages: string[] | null;
      } | null;
    } | null;
  };

  const tx = json.result;

  if (!tx) return { status: "not_found", signature };
  if (tx.meta?.err) return { status: "failed", signature, err: tx.meta.err };

  const logs = tx.meta?.logMessages ?? [];
  let assetId: string | null = null;
  for (const line of logs) {
    const m = ASSET_ID_LOG_RE.exec(line);
    if (m && m[1]) {
      assetId = m[1];
      break;
    }
  }

  return {
    status: "success",
    signature,
    slot: tx.slot,
    assetId,
  };
}
