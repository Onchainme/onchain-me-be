/**
 * Seeker Genesis Token holding check.
 *
 * Single-mint NFT: the wallet either owns ≥1 token of that mint, or not.
 *   mint = HoLpd9pb9AnsvXrDvAdeAJGgxm2Tqs3LGyzNPRrwg7jp
 * Reference: https://docs.solanamobile.com/marketing/engaging-seeker-users
 *
 * We use the public Solana RPC `getTokenAccountsByOwner` filtered by mint,
 * then sum balances. No DAS / Helius needed.
 */

import { loadEnv } from "../env.js";

export const SEEKER_GENESIS_MINT = "HoLpd9pb9AnsvXrDvAdeAJGgxm2Tqs3LGyzNPRrwg7jp";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

interface TokenAccountValue {
  account: {
    data: {
      parsed: {
        info: {
          tokenAmount: { amount: string; uiAmount: number | null };
        };
      };
    };
  };
}

interface GetTokenAccountsResponse {
  result?: { value: TokenAccountValue[] };
  error?: { code: number; message: string };
}

export async function hasSeekerGenesisNft(wallet: string): Promise<boolean> {
  const env = loadEnv();
  const res = await globalThis.fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [
        wallet,
        { mint: SEEKER_GENESIS_MINT },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`getTokenAccountsByOwner failed: ${res.status}`);
  }
  const body = (await res.json()) as GetTokenAccountsResponse;
  if (body.error) {
    throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  }
  const accounts = body.result?.value ?? [];
  for (const acc of accounts) {
    const amount = acc.account.data.parsed.info.tokenAmount.amount;
    // Any non-zero balance counts as "holds the NFT".
    if (amount && amount !== "0") return true;
  }
  return false;
}

// Re-export so other modules don't need to import the constant separately.
export { TOKEN_PROGRAM };
