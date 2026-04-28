import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, ErrorCode, mongoose, models } from "@onchainme/shared";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";

const TILE_MIN = 0;
const TILE_MAX = 31;

const placementInput = z.object({
  badgeId: z.string().min(1).max(64),
  x: z.number().int(),
  y: z.number().int(),
});

const putBody = z.object({
  placements: z.array(placementInput).max(64),
});

const walletParam = z.object({ wallet: z.string().min(32).max(64) });
const deleteParam = z.object({
  wallet: z.string().min(32).max(64),
  badgeId: z.string().min(1).max(64),
});

export const placementsRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.put(
    "/placements/:wallet",
    {
      schema: {
        params: walletParam,
        body: putBody,
        response: {
          200: z.object({ ok: z.literal(true), count: z.number() }),
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireOwner,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req) => {
      const { wallet } = req.params;
      const { placements } = req.body;

      // 1. Validate coords and reject duplicates in the payload itself (cheap, before DB)
      const tileKeys = new Set<string>();
      for (const p of placements) {
        if (p.x < TILE_MIN || p.x > TILE_MAX || p.y < TILE_MIN || p.y > TILE_MAX) {
          throw new AppError({
            code: ErrorCode.INVALID_TILE_COORDINATE,
            message: `Tile coordinate out of range: (${p.x}, ${p.y}). Must be ${TILE_MIN}–${TILE_MAX}.`,
            statusCode: 422,
            details: { x: p.x, y: p.y },
          });
        }
        const key = `${p.x}:${p.y}`;
        if (tileKeys.has(key)) {
          throw new AppError({
            code: ErrorCode.INVALID_TILE_COORDINATE,
            message: `Duplicate tile (${p.x}, ${p.y}) in placements`,
            statusCode: 422,
            details: { x: p.x, y: p.y },
          });
        }
        tileKeys.add(key);
      }
      const badgeIds = new Set(placements.map((p) => p.badgeId));
      if (badgeIds.size !== placements.length) {
        throw new AppError({
          code: ErrorCode.INVALID_TILE_COORDINATE,
          message: "Same badge listed twice",
          statusCode: 422,
        });
      }

      // 2. Verify every badge is claimed
      if (placements.length > 0) {
        const claims = await models.BadgeClaim.find(
          { "_id.walletAddress": wallet, "_id.badgeId": { $in: [...badgeIds] } },
          { _id: 1 },
        ).lean();
        const claimed = new Set(
          claims.map((c) => (c._id as unknown as { badgeId: string }).badgeId),
        );
        const missing = [...badgeIds].filter((id) => !claimed.has(id));
        if (missing.length > 0) {
          throw new AppError({
            code: ErrorCode.PLACEMENT_FOR_UNCLAIMED,
            message: "Cannot place a badge that was not claimed",
            statusCode: 422,
            details: { unclaimed: missing },
          });
        }
      }

      // 3. Atomic delete + insert under one transaction
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await models.Placement.deleteMany(
            { "_id.walletAddress": wallet },
            { session },
          );
          if (placements.length > 0) {
            await models.Placement.insertMany(
              placements.map((p) => ({
                _id: { walletAddress: wallet, badgeId: p.badgeId },
                tileX: p.x,
                tileY: p.y,
              })),
              { session, ordered: true },
            );
          }
        });
      } catch (err: unknown) {
        if (err instanceof Error && /duplicate key|E11000/i.test(err.message)) {
          throw new AppError({
            code: ErrorCode.TILE_OCCUPIED,
            message: "A tile is already occupied",
            statusCode: 409,
          });
        }
        throw err;
      } finally {
        await session.endSession();
      }

      return { ok: true as const, count: placements.length };
    },
  );

  fastify.delete(
    "/placements/:wallet/:badgeId",
    {
      schema: { params: deleteParam },
      preHandler: fastify.requireOwner,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { wallet, badgeId } = req.params as z.infer<typeof deleteParam>;
      const result = await models.Placement.deleteOne({
        _id: { walletAddress: wallet, badgeId },
      });
      if (result.deletedCount === 0) {
        throw new AppError({
          code: ErrorCode.LAND_NOT_FOUND,
          message: "Placement not found",
          statusCode: 404,
        });
      }
      return reply.code(204).send();
    },
  );
};
