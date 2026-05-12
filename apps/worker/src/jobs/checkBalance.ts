import {
  clearMintDegraded,
  getRpcConnection,
  loadEnv,
  mintAuthorityPublicKey,
  setMintDegraded,
} from "@onchainme/shared";

const LAMPORTS_PER_SOL = 1_000_000_000;
const WARN_BELOW_SOL = 0.5;
const DEGRADE_BELOW_SOL = 0.1;
const DEGRADE_TTL_S = 15 * 60;

export interface CheckBalanceResult {
  balanceSol: number;
  degraded: boolean;
}

export async function checkBalanceProcessor(): Promise<CheckBalanceResult> {
  const conn = getRpcConnection();
  const pubkey = mintAuthorityPublicKey();
  const lamports = await conn.getBalance(pubkey, "confirmed");
  const balanceSol = lamports / LAMPORTS_PER_SOL;

  // Paid-mint mode: the mint authority's only on-chain job is signing the
  // Bubblegum tree-authority check, which costs nothing. We deliberately leave
  // it nearly empty after tree creation (0.677 SOL burned on rent, ~0.02 SOL
  // dust remaining). Reporting balance is still useful for ops dashboards;
  // never flag degraded.
  const env = loadEnv();
  if (env.MINT_PRICE_LAMPORTS > 0) {
    await clearMintDegraded();
    return { balanceSol, degraded: false };
  }

  if (balanceSol < DEGRADE_BELOW_SOL) {
    await setMintDegraded(`balance ${balanceSol.toFixed(4)} SOL`, DEGRADE_TTL_S);
    return { balanceSol, degraded: true };
  }
  if (balanceSol < WARN_BELOW_SOL) {
    await clearMintDegraded();
    return { balanceSol, degraded: false };
  }
  await clearMintDegraded();
  return { balanceSol, degraded: false };
}
