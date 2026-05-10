import { models, type BadgeEvalResult } from "@onchainme/shared";

export interface UpsertEligibilitiesResult {
  upserted: number;
  removed: number;
  newBadgeIds: string[];
}

/**
 * Sync the BadgeEligibility table for one wallet to exactly the set of badges
 * the evaluator returned.
 *
 *   • Upsert every result (creates new rows + refreshes meta/evaluatedAt).
 *   • Remove rows for badges the wallet no longer earns (e.g. an LP position
 *     dropped below the tier threshold). BadgeClaim rows are NEVER touched —
 *     on-chain cNFTs are irrevocable.
 *
 * Returns counts + the set of badgeIds that didn't exist as eligibilities
 * before this call (useful for "new badges earned" notifications).
 */
export async function upsertEligibilities(
  walletAddress: string,
  results: BadgeEvalResult[],
): Promise<UpsertEligibilitiesResult> {
  const desiredIds = new Set(results.map((r) => r.badgeId));

  const existing = await models.BadgeEligibility.find(
    { "_id.walletAddress": walletAddress },
    { _id: 1 },
  ).lean();
  const existingIds = new Set(
    existing.map((e) => (e._id as { badgeId: string }).badgeId),
  );

  const toRemove: string[] = [];
  for (const id of existingIds) {
    // `desiredIds` is keyed by the current BadgeId union; bridging via
    // `Set<string>.has` is fine at runtime — we want to surface any stale
    // string that isn't in the live set, including legacy ids.
    if (!(desiredIds as unknown as Set<string>).has(id)) toRemove.push(id);
  }

  let removed = 0;
  if (toRemove.length > 0) {
    // Cast through `unknown` because `_id.badgeId` is typed as the BadgeId
    // union — we explicitly want to be able to remove badgeIds that have
    // since been removed from the registry (e.g. legacy `first_swap`).
    const filter = {
      "_id.walletAddress": walletAddress,
      "_id.badgeId": { $in: toRemove },
    } as unknown as Parameters<typeof models.BadgeEligibility.deleteMany>[0];
    const r = await models.BadgeEligibility.deleteMany(filter);
    removed = r.deletedCount ?? 0;
  }

  if (results.length === 0) {
    return { upserted: 0, removed, newBadgeIds: [] };
  }

  const ops = results.map((r) => ({
    updateOne: {
      filter: { _id: { walletAddress, badgeId: r.badgeId } },
      update: {
        $set: { evaluatedAt: new Date(), meta: r.meta },
        $setOnInsert: { eligibleSince: r.eligibleSince },
      },
      upsert: true,
    },
  }));
  await models.BadgeEligibility.bulkWrite(ops, { ordered: false });

  const newBadgeIds = results
    .map((r) => r.badgeId)
    .filter((id) => !existingIds.has(id));
  return { upserted: results.length, removed, newBadgeIds };
}
