/**
 * Redis-backed toggle for the on-chain backfill check during /mint/* requests.
 *
 * Why this exists:
 *   Normally `backfillFromOnChain` (in apps/api/src/routes/mint.ts) scans DAS
 *   for any cNFT under our merkle tree that matches the badge id. If found,
 *   it short-circuits the mint with 409 "already claimed" and re-creates the
 *   BadgeClaim row in Mongo — exactly the protection we want for production.
 *
 *   But during testing/QA, after wiping Mongo we sometimes WANT the user to
 *   re-mint the same badge to verify the new mint flow (collection linkage,
 *   tx ordering, etc). On-chain cNFT minted previously stays forever, so
 *   `backfillFromOnChain` keeps rejecting fresh mints.
 *
 *   This toggle lets ops temporarily disable that DAS check (without env
 *   edits + redeploy). Flag has a TTL so it auto-expires — leaving backfill
 *   permanently off would let users double-mint into the same merkle tree,
 *   bloating leaderboard / score.
 *
 * Default state: disabled flag NOT set → backfill RUNS as before. Set the
 * flag via POST /api/v1/admin/onchain-backfill { enabled: false, ... }.
 */
import { getRedisConnection } from "../queue/connection.js";

const KEY = "onchainme:onchain_backfill_disabled";

export async function isOnchainBackfillDisabled(): Promise<boolean> {
  const v = await getRedisConnection().get(KEY);
  return v !== null && v !== "";
}

export async function disableOnchainBackfill(
  reason: string,
  ttlSeconds: number,
): Promise<void> {
  await getRedisConnection().set(KEY, reason, "EX", Math.max(1, Math.floor(ttlSeconds)));
}

export async function enableOnchainBackfill(): Promise<void> {
  await getRedisConnection().del(KEY);
}

export async function getOnchainBackfillStatus(): Promise<{
  enabled: boolean;
  reason: string | null;
  ttlSeconds: number | null;
}> {
  const redis = getRedisConnection();
  const v = await redis.get(KEY);
  if (v === null) {
    return { enabled: true, reason: null, ttlSeconds: null };
  }
  const ttl = await redis.ttl(KEY);
  return {
    enabled: false,
    reason: v,
    ttlSeconds: ttl >= 0 ? ttl : null,
  };
}
