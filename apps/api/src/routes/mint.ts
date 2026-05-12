import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";
import {
  addMintAudit,
  AppError,
  ErrorCode,
  buildMintTransaction,
  fetchTransactionStatus,
  getAssetsByOwner,
  isMintDegraded,
  loadEnv,
  models,
  REGISTRY,
  type BadgeId,
} from "@onchainme/shared";

const singleBody = z.object({ badgeId: z.string().min(1).max(64) });
const allBody = z.object({}).strict();
const confirmBody = z.object({
  signature: z.string().min(1).max(128),
  badgeId: z.string().min(1).max(64),
});

// Legacy on-chain name format used before badge-system v2 (when ids fit in
// 32 bytes). Kept as a fallback so detect-and-import still recognises old
// mints.
const LEGACY_NAME_PREFIX = "OnchainMe — ";

/**
 * DAS-backed sanity check: even when our DB is empty, an on-chain cNFT under
 * our merkle tree with a matching badge id (recovered from the off-chain
 * `json_uri` path) means the wallet already owns this badge. Backfills
 * BadgeClaim and treats the request as already-claimed.
 *
 * Adds ~500ms per mint request, so we only call it AFTER cheap DB checks pass.
 */
async function backfillFromOnChain(
  wallet: string,
  badgeId: string,
  merkleTree: string,
): Promise<boolean> {
  let assets;
  try {
    assets = await getAssetsByOwner(wallet);
  } catch {
    // DAS hiccup shouldn't block a legitimate mint; skip the on-chain check.
    return false;
  }
  const legacyExpectedName = `${LEGACY_NAME_PREFIX}${badgeId}`;
  const match = assets.find((a) => {
    if (a.compression?.compressed !== true) return false;
    if (a.compression?.tree !== merkleTree) return false;
    // v2: recover badgeId from json_uri path (e.g. .../metadata/<id>.json)
    const uri = a.content?.json_uri;
    if (uri) {
      try {
        const { pathname } = new URL(uri);
        const last = pathname.split("/").filter(Boolean).pop() ?? "";
        const candidate = last.endsWith(".json") ? last.slice(0, -".json".length) : last;
        if (candidate === badgeId) return true;
      } catch {
        // fall through to legacy name check
      }
    }
    // v1 legacy fallback
    return a.content?.metadata?.name === legacyExpectedName;
  });
  if (!match) return false;

  try {
    await models.BadgeClaim.create({
      _id: { walletAddress: wallet, badgeId },
      mintSignature: `imported:${match.id}`,
      assetId: match.id,
      merkleTree,
      mintedAt: new Date(),
    });
    const weight = REGISTRY[badgeId as BadgeId]?.weight ?? 0;
    if (weight > 0) {
      await models.User.updateOne(
        { _id: wallet },
        { $inc: { score: weight }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
    }
  } catch (err) {
    // Race with concurrent /import or /mint/confirm — treat as backfilled.
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  return true;
}

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

  // Defense-in-depth: scan on-chain. Catches DB-only resets that would
  // otherwise let a wallet mint duplicates of the same badge.
  const env = loadEnv();
  const onChainHit = await backfillFromOnChain(wallet, badgeId, env.MERKLE_TREE_ADDRESS);
  if (onChainHit) {
    throw new AppError({
      code: ErrorCode.BADGE_ALREADY_CLAIMED,
      message: `${badgeId} already exists on-chain — backfilled`,
      statusCode: 409,
    });
  }
}

async function ensureMintAvailable(): Promise<void> {
  // In paid-mint mode the leafOwner (user) is the fee payer — the mint
  // authority only signs the Bubblegum tree-authority check, which costs
  // nothing. The degraded check exists for sponsored mode where the mint
  // authority paid every tx fee and could literally run out. Skip the gate
  // entirely once MINT_PRICE_LAMPORTS is set, otherwise low post-tree balance
  // (we burn 0.677 SOL on tree creation, leaving ~0.02 SOL of unused dust)
  // permanently disables minting for no real reason.
  const env = loadEnv();
  if (env.MINT_PRICE_LAMPORTS > 0) return;
  if (await isMintDegraded()) {
    throw new AppError({
      code: ErrorCode.MINT_AUTHORITY_OUT_OF_FUNDS,
      message: "Minting is temporarily disabled",
      statusCode: 503,
    });
  }
}

export const mintRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/mint/config",
    {
      schema: {
        response: {
          200: z.object({
            // Lamports the user pays per mint → goes to creatorAddress in the
            // same transaction. 0 = sponsored mint (user pays only the tx fee).
            mintPriceLamports: z.number().int().nonnegative(),
            // Read-only display field; backend remains the source of truth for
            // the transfer destination.
            creatorAddress: z.string(),
          }),
        },
      },
    },
    async (_req, reply) => {
      const env = loadEnv();
      // Price and creator are deploy-time config — long cache is safe. UI
      // refetches on cold load.
      reply.header("Cache-Control", "public, max-age=300");
      return {
        mintPriceLamports: env.MINT_PRICE_LAMPORTS,
        creatorAddress: env.CREATOR_ADDRESS,
      };
    },
  );

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
        // Denormalized score: increment by the badge's weight so the leaderboard
        // doesn't need to aggregate BadgeClaim on every read.
        const weight = REGISTRY[badgeId as BadgeId]?.weight ?? 0;
        if (weight > 0) {
          await models.User.updateOne(
            { _id: wallet },
            { $inc: { score: weight }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
          );
        }
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
