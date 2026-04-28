import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";
import {
  addMintAudit,
  AppError,
  ErrorCode,
  loadEnv,
  models,
  verifyHeliusSecret,
} from "@onchainme/shared";

const compressedEventSchema = z.object({
  assetId: z.string(),
  treeId: z.string(),
  newLeafOwner: z.string(),
  badgeId: z.string().optional(),
});

const heliusEventSchema = z
  .object({
    signature: z.string().min(1),
    type: z.string().optional(),
    events: z
      .object({
        compressed: z.array(compressedEventSchema).optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

const bodySchema = z.array(heliusEventSchema);

export const webhooksRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/webhooks/helius",
    {
      schema: {
        body: bodySchema,
        response: {
          200: z.object({ ok: z.literal(true), processed: z.number(), skipped: z.number() }),
          401: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const auth = req.headers["authorization"];
      const headerValue = Array.isArray(auth) ? auth[0] : auth;
      if (!verifyHeliusSecret(headerValue?.replace(/^Bearer\s+/i, ""))) {
        throw new AppError({
          code: ErrorCode.AUTH_TOKEN_INVALID,
          message: "Invalid webhook secret",
          statusCode: 401,
        });
      }

      const env = loadEnv();
      const events = req.body;

      let processed = 0;
      let skipped = 0;
      for (const event of events) {
        const existing = await models.HeliusWebhookEvent.findById(event.signature);
        if (existing) {
          skipped += 1;
          continue;
        }

        await models.HeliusWebhookEvent.create({
          _id: event.signature,
          payload: event,
          processedAt: new Date(),
        });
        processed += 1;

        const compressed = event.events?.compressed ?? [];
        for (const c of compressed) {
          if (c.treeId !== env.MERKLE_TREE_ADDRESS) continue;
          if (!c.badgeId) continue;
          await models.BadgeClaim.findOneAndUpdate(
            { _id: { walletAddress: c.newLeafOwner, badgeId: c.badgeId } },
            {
              $setOnInsert: {
                mintSignature: event.signature,
                assetId: c.assetId,
                merkleTree: c.treeId,
                mintedAt: new Date(),
              },
            },
            { upsert: true },
          );
          addMintAudit({ wallet: c.newLeafOwner, badgeId: c.badgeId, action: "webhook_claim" });
        }
      }

      return reply.code(200).send({ ok: true, processed, skipped });
    },
  );
};
