import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ALL_BADGE_IDS,
  getAssetsByOwner,
  loadEnv,
  models,
  REGISTRY,
  type BadgeId,
} from "@onchainme/shared";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";

const NAME_PREFIX = "OnchainMe — ";

function badgeIdFromName(name: string | undefined): BadgeId | null {
  if (!name) return null;
  if (!name.startsWith(NAME_PREFIX)) return null;
  const candidate = name.slice(NAME_PREFIX.length).trim();
  if ((ALL_BADGE_IDS as readonly string[]).includes(candidate)) {
    return candidate as BadgeId;
  }
  return null;
}

export const importRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/import/scan-cnfts",
    {
      schema: {
        response: {
          200: z.object({
            imported: z.number(),
            badgeIds: z.array(z.string()),
            skipped: z.number(),
            assetsScanned: z.number(),
            scoreDelta: z.number(),
          }),
          401: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const env = loadEnv();
      const wallet = (req.user as { wallet: string }).wallet;

      const assets = await getAssetsByOwner(wallet);

      // Filter to compressed NFTs minted under our merkle tree.
      const ours = assets.filter(
        (a) => a.compression?.compressed === true && a.compression?.tree === env.MERKLE_TREE_ADDRESS,
      );

      // Group by badgeId — one wallet can hold multiple cNFTs of the same badge
      // type after a DB reset. We import the FIRST one we encounter per badgeId
      // (oldest by leaf_id ascending) so the on-chain "original" wins.
      const byBadge = new Map<BadgeId, { assetId: string; leafId: number }>();
      for (const asset of ours) {
        const badgeId = badgeIdFromName(asset.content?.metadata?.name);
        if (!badgeId) continue;
        const leafId = asset.compression?.leaf_id ?? Number.MAX_SAFE_INTEGER;
        const existing = byBadge.get(badgeId);
        if (!existing || leafId < existing.leafId) {
          byBadge.set(badgeId, { assetId: asset.id, leafId });
        }
      }

      // For each badgeId that we found on-chain but don't have in DB, create a
      // BadgeClaim record. Skip ones already in DB. Increment score by weight.
      let imported = 0;
      let skipped = 0;
      let scoreDelta = 0;
      const importedBadgeIds: string[] = [];

      for (const [badgeId, info] of byBadge.entries()) {
        const existing = await models.BadgeClaim.findOne({
          "_id.walletAddress": wallet,
          "_id.badgeId": badgeId,
        });
        if (existing) {
          skipped += 1;
          continue;
        }
        const weight = REGISTRY[badgeId]?.weight ?? 0;
        try {
          await models.BadgeClaim.create({
            _id: { walletAddress: wallet, badgeId },
            mintSignature: `imported:${info.assetId}`,
            assetId: info.assetId,
            merkleTree: env.MERKLE_TREE_ADDRESS,
            mintedAt: new Date(),
          });
          imported += 1;
          scoreDelta += weight;
          importedBadgeIds.push(badgeId);
        } catch (err) {
          // Race with concurrent /mint/confirm or another import call —
          // safe to swallow E11000 and treat as skipped.
          if ((err as { code?: number }).code === 11000) {
            skipped += 1;
            continue;
          }
          throw err;
        }
      }

      if (scoreDelta > 0) {
        await models.User.updateOne(
          { _id: wallet },
          {
            $inc: { score: scoreDelta },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true },
        );
      }

      return {
        imported,
        badgeIds: importedBadgeIds,
        skipped,
        assetsScanned: assets.length,
        scoreDelta,
      };
    },
  );
};
