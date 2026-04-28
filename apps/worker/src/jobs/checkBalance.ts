import {
  clearMintDegraded,
  getRpcConnection,
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
