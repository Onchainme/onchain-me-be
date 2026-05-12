import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ALL_BADGE_IDS,
  getAssetsByOwner,
  isOnchainBackfillDisabled,
  loadEnv,
  models,
  REGISTRY,
  type BadgeId,
} from "@onchainme/shared";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";

/**
 * Extract the badgeId from a DAS asset.
 *
 * On-chain `metadata.name` is too short to carry the full id (Metaplex limit
 * is 32 bytes; "OnchainMe — meteora_position_original" overflows), so we now
 * embed the display name there ("Jupiter $10k", etc.) and recover the id from
 * the off-chain `json_uri` instead. Our URIs look like:
 *
 *   https://api.<DOMAIN>/api/v1/metadata/<badgeId>.json
 *   https://api.<DOMAIN>/api/v1/metadata/<badgeId>            (no .json suffix)
 *
 * As a fallback for old cNFTs minted before this change, we also try to
 * match the legacy `OnchainMe — <badgeId>` name format.
 */
const LEGACY_NAME_PREFIX = "OnchainMe — ";

function badgeIdFromUri(uri: string | undefined): BadgeId | null {
  if (!uri) return null;
  try {
    const { pathname } = new URL(uri);
    const segments = pathname.split("/").filter(Boolean);
    let last = segments[segments.length - 1];
    if (!last) return null;
    if (last.endsWith(".json")) last = last.slice(0, -".json".length);
    if ((ALL_BADGE_IDS as readonly string[]).includes(last)) {
      return last as BadgeId;
    }
    return null;
  } catch {
    return null;
  }
}

function badgeIdFromLegacyName(name: string | undefined): BadgeId | null {
  if (!name) return null;
  if (!name.startsWith(LEGACY_NAME_PREFIX)) return null;
  const candidate = name.slice(LEGACY_NAME_PREFIX.length).trim();
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

      // Same toggle that ungates duplicate mints during QA also ungates this
      // import endpoint. Otherwise the frontend's auto-call on connect would
      // immediately re-create BadgeClaim rows from on-chain cNFTs, defeating
      // the toggle and putting the user right back into "already claimed".
      if (await isOnchainBackfillDisabled()) {
        return {
          imported: 0,
          badgeIds: [],
          skipped: 0,
          assetsScanned: 0,
          scoreDelta: 0,
        };
      }

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
        const badgeId =
          badgeIdFromUri(asset.content?.json_uri) ??
          badgeIdFromLegacyName(asset.content?.metadata?.name);
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
