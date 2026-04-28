import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";
import {
  addMintAudit,
  AppError,
  ErrorCode,
  buildMintTransaction,
  fetchTransactionStatus,
  isMintDegraded,
  loadEnv,
  models,
} from "@onchainme/shared";

const singleBody = z.object({ badgeId: z.string().min(1).max(64) });
const allBody = z.object({}).strict();
const confirmBody = z.object({
  signature: z.string().min(1).max(128),
  badgeId: z.string().min(1).max(64),
});

async function ensureClaimable(wallet: string, badgeId: string): Promise<void> {
  const eligible = await models.BadgeEligibility.findOne({
    "_id.walletAddress": wallet,
    "_id.badgeId": badgeId,
  });
  if (!eligible) {
    throw new AppError({
      code: ErrorCode.BADGE_NOT_ELIGIBLE,
      message: `Wallet has not earned ${badgeId}`,
      statusCode: 422,
    });
  }
  const claim = await models.BadgeClaim.findOne({
    "_id.walletAddress": wallet,
    "_id.badgeId": badgeId,
  });
  if (claim) {
    throw new AppError({
      code: ErrorCode.BADGE_ALREADY_CLAIMED,
      message: `${badgeId} is already claimed`,
      statusCode: 409,
    });
  }
}

async function ensureMintAvailable(): Promise<void> {
  if (await isMintDegraded()) {
    throw new AppError({
      code: ErrorCode.MINT_AUTHORITY_OUT_OF_FUNDS,
      message: "Minting is temporarily disabled",
      statusCode: 503,
    });
  }
}

export const mintRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/mint/single",
    {
      schema: {
        body: singleBody,
        response: {
          200: z.object({
            transaction: z.string(),
            badgeId: z.string(),
            expiresAt: z.string(),
          }),
          401: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;
      const { badgeId } = req.body;

      await ensureMintAvailable();
      await ensureClaimable(wallet, badgeId);

      const result = await buildMintTransaction({ leafOwner: wallet, badgeId });
      addMintAudit({ wallet, badgeId, action: "partial_sign" });
      return {
        transaction: result.transactionBase64,
        badgeId: result.badgeId,
        expiresAt: result.expiresAt,
      };
    },
  );

  fastify.post(
    "/mint/all",
    {
      schema: {
        body: allBody,
        response: {
          200: z.object({
            transactions: z.array(
              z.object({
                badgeId: z.string(),
                transaction: z.string(),
                expiresAt: z.string(),
              }),
            ),
          }),
          401: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;

      await ensureMintAvailable();

      const [eligibilities, claims] = await Promise.all([
        models.BadgeEligibility.find({ "_id.walletAddress": wallet }, { _id: 1 }).lean(),
        models.BadgeClaim.find({ "_id.walletAddress": wallet }, { _id: 1 }).lean(),
      ]);
      const claimed = new Set(
        claims.map((c) => (c._id as unknown as { badgeId: string }).badgeId),
      );
      const toMint = eligibilities
        .map((e) => (e._id as unknown as { badgeId: string }).badgeId)
        .filter((id) => !claimed.has(id));

      const transactions: { badgeId: string; transaction: string; expiresAt: string }[] = [];
      for (const badgeId of toMint) {
        const r = await buildMintTransaction({ leafOwner: wallet, badgeId });
        addMintAudit({ wallet, badgeId, action: "partial_sign" });
        transactions.push({
          badgeId: r.badgeId,
          transaction: r.transactionBase64,
          expiresAt: r.expiresAt,
        });
      }
      return { transactions };
    },
  );

  fastify.post(
    "/mint/confirm",
    {
      schema: {
        body: confirmBody,
        response: {
          200: z.object({
            badgeId: z.string(),
            mintSignature: z.string(),
            assetId: z.string().nullable(),
            alreadyClaimed: z.boolean(),
          }),
          401: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;
      const { signature, badgeId } = req.body;

      const status = await fetchTransactionStatus(signature);
      if (status.status === "not_found") {
        throw new AppError({
          code: ErrorCode.TX_NOT_FOUND,
          message: "Transaction not yet visible on chain",
          statusCode: 422,
        });
      }
      if (status.status === "failed") {
        throw new AppError({
          code: ErrorCode.TX_FAILED,
          message: "Transaction failed on chain",
          statusCode: 422,
          details: { err: status.err },
        });
      }

      // Portable upsert pattern (Mongoose 8.x safe):
      // Check for existing claim first; if found return alreadyClaimed=true.
      // Otherwise attempt create; catch E11000 for concurrent race conditions.
      const existing = await models.BadgeClaim.findOne({
        "_id.walletAddress": wallet,
        "_id.badgeId": badgeId,
      });
      if (existing) {
        return {
          badgeId,
          mintSignature: existing.mintSignature,
          assetId: existing.assetId,
          alreadyClaimed: true,
        };
      }

      const env = loadEnv();
      try {
        await models.BadgeClaim.create({
          _id: { walletAddress: wallet, badgeId },
          mintSignature: signature,
          assetId: status.assetId ?? "unknown",
          merkleTree: env.MERKLE_TREE_ADDRESS,
          mintedAt: new Date(),
        });
        addMintAudit({ wallet, badgeId, action: "confirm" });
        return {
          badgeId,
          mintSignature: signature,
          assetId: status.assetId ?? "unknown",
          alreadyClaimed: false,
        };
      } catch (err) {
        // E11000 duplicate key — race with a concurrent /mint/confirm or webhook
        if ((err as { code?: number }).code === 11000) {
          const raceExisting = await models.BadgeClaim.findOne({
            "_id.walletAddress": wallet,
            "_id.badgeId": badgeId,
          });
          if (raceExisting) {
            return {
              badgeId,
              mintSignature: raceExisting.mintSignature,
              assetId: raceExisting.assetId,
              alreadyClaimed: true,
            };
          }
        }
        throw err;
      }
    },
  );
};
