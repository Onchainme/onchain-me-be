import { models, type BadgeEvalResult } from "@onchainme/shared";

export interface UpsertEligibilitiesResult {
  upserted: number;
  newBadgeIds: string[];
}

export async function upsertEligibilities(
  walletAddress: string,
  results: BadgeEvalResult[],
): Promise<UpsertEligibilitiesResult> {
  if (results.length === 0) return { upserted: 0, newBadgeIds: [] };

  const existingIds = new Set(
    (
      await models.BadgeEligibility.find(
        { "_id.walletAddress": walletAddress },
        { _id: 1 },
      ).lean()
    ).map((e) => (e._id as { badgeId: string }).badgeId),
  );

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

  const newBadgeIds = results.filter((r) => !existingIds.has(r.badgeId)).map((r) => r.badgeId);
  return { upserted: results.length, newBadgeIds };
}
