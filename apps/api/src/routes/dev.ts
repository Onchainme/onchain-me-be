import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, ErrorCode, getBadge, loadEnv, models } from "@onchainme/shared";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";

const seedBody = z.object({ badgeId: z.string().min(1).max(64) });

export const devRoute: FastifyPluginAsyncZod = async (fastify) => {
  const env = loadEnv();
  // Exposed when either NODE_ENV is development (local) or the explicit
  // ALLOW_DEV_ROUTES flag is set (alpha/devnet prod). Routes still require
  // a session cookie via fastify.requireAuth.
  if (env.NODE_ENV !== "development" && !env.ALLOW_DEV_ROUTES) return;

  fastify.post(
    "/dev/seed-eligibility",
    {
      schema: {
        body: seedBody,
        response: {
          200: z.object({
            badgeId: z.string(),
            eligibleSince: z.string(),
            created: z.boolean(),
          }),
          400: errorEnvelopeSchema,
          401: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;
      const { badgeId } = req.body;

      if (!getBadge(badgeId)) {
        throw new AppError({
          code: ErrorCode.INVALID_BADGE_ID,
          message: `Unknown badgeId: ${badgeId}`,
          statusCode: 400,
        });
      }

      const eligibleSince = new Date();
      const result = await models.BadgeEligibility.updateOne(
        { _id: { walletAddress: wallet, badgeId } },
        {
          $setOnInsert: {
            _id: { walletAddress: wallet, badgeId },
            eligibleSince,
            meta: { source: "dev-seed" },
          },
        },
        { upsert: true },
      );

      const created = (result.upsertedCount ?? 0) > 0;
      const doc = await models.BadgeEligibility.findOne({
        "_id.walletAddress": wallet,
        "_id.badgeId": badgeId,
      }).lean();
      const since = doc ? new Date(doc.eligibleSince).toISOString() : eligibleSince.toISOString();

      return { badgeId, eligibleSince: since, created };
    },
  );

  fastify.post(
    "/dev/seed-eligibilities-all",
    {
      schema: {
        response: {
          200: z.object({
            badgeIds: z.array(z.string()),
            createdCount: z.number(),
          }),
          401: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;
      const { ALL_BADGE_IDS } = await import("@onchainme/shared");
      const eligibleSince = new Date();
      let createdCount = 0;
      for (const badgeId of ALL_BADGE_IDS) {
        const r = await models.BadgeEligibility.updateOne(
          { _id: { walletAddress: wallet, badgeId } },
          {
            $setOnInsert: {
              _id: { walletAddress: wallet, badgeId },
              eligibleSince,
              meta: { source: "dev-seed" },
            },
          },
          { upsert: true },
        );
        if ((r.upsertedCount ?? 0) > 0) createdCount += 1;
      }
      return { badgeIds: [...ALL_BADGE_IDS], createdCount };
    },
  );
};
