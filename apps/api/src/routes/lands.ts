import { Buffer } from "node:buffer";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  getRank,
  getRanks,
  models,
  REGISTRY,
  score,
  type BadgeId,
} from "@onchainme/shared";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";

const walletParam = z.object({ wallet: z.string().min(32).max(64) });

const sortParam = z.enum(["recent", "score"]).default("recent");

const landsListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sort: sortParam,
});

interface RecentCursor {
  type: "recent";
  createdAt: string;
  wallet: string;
}

interface ScoreCursor {
  type: "score";
  score: number;
  wallet: string;
}

type Cursor = RecentCursor | ScoreCursor;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(s: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (parsed["type"] === "recent" && typeof parsed["createdAt"] === "string" && typeof parsed["wallet"] === "string") {
      return { type: "recent", createdAt: parsed["createdAt"], wallet: parsed["wallet"] };
    }
    if (parsed["type"] === "score" && typeof parsed["score"] === "number" && typeof parsed["wallet"] === "string") {
      return { type: "score", score: parsed["score"], wallet: parsed["wallet"] };
    }
    return null;
  } catch {
    return null;
  }
}

export const landsRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/lands",
    {
      schema: {
        querystring: landsListQuery,
        response: {
          200: z.object({
            items: z.array(
              z.object({
                wallet: z.string(),
                ogImageUrl: z.string().nullable(),
                objectsCount: z.number(),
                score: z.number(),
                rank: z.number(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const { cursor, limit, sort } = req.query;
      const filter: Record<string, unknown> = {};
      const decoded = cursor ? decodeCursor(cursor) : null;

      // Build sort and filter based on selected mode. Cursor type must match sort,
      // otherwise we ignore the (now-irrelevant) cursor and start from the top.
      let sortSpec: Record<string, 1 | -1>;
      if (sort === "score") {
        sortSpec = { score: -1, _id: 1 };
        if (decoded?.type === "score") {
          filter.$or = [
            { score: { $lt: decoded.score } },
            { score: decoded.score, _id: { $gt: decoded.wallet } },
          ];
        }
      } else {
        sortSpec = { createdAt: -1, _id: -1 };
        if (decoded?.type === "recent") {
          filter.$or = [
            { createdAt: { $lt: new Date(decoded.createdAt) } },
            { createdAt: new Date(decoded.createdAt), _id: { $lt: decoded.wallet } },
          ];
        }
      }

      const users = await models.User.find(filter)
        .sort(sortSpec)
        .limit(limit + 1)
        .lean();

      const page = users.slice(0, limit);
      const wallets = page.map((u) => u._id as unknown as string);

      const placementCounts = wallets.length
        ? await models.Placement.aggregate<{ _id: string; count: number }>([
            { $match: { "_id.walletAddress": { $in: wallets } } },
            { $group: { _id: "$_id.walletAddress", count: { $sum: 1 } } },
          ])
        : [];
      const countByWallet = new Map(placementCounts.map((c) => [c._id, c.count]));

      const scores = page.map((u) => (u["score"] as number | undefined) ?? 0);
      const ranks = await getRanks(scores);

      const items = page.map((u, i) => ({
        wallet: u._id as unknown as string,
        ogImageUrl: u["ogImageUrl"] ?? null,
        objectsCount: countByWallet.get(u._id as unknown as string) ?? 0,
        score: scores[i] ?? 0,
        rank: ranks[i] ?? 0,
      }));

      const last = page.at(-1);
      let nextCursor: string | null = null;
      if (users.length > limit && last) {
        const lastWallet = last._id as unknown as string;
        if (sort === "score") {
          nextCursor = encodeCursor({
            type: "score",
            score: (last["score"] as number | undefined) ?? 0,
            wallet: lastWallet,
          });
        } else {
          nextCursor = encodeCursor({
            type: "recent",
            createdAt: (last["createdAt"] as Date).toISOString(),
            wallet: lastWallet,
          });
        }
      }

      return { items, nextCursor };
    },
  );

  fastify.get(
    "/lands/:wallet",
    {
      schema: {
        params: walletParam,
        response: {
          200: z.object({
            wallet: z.string(),
            stats: z.object({
              protocols: z.number(),
              transactions: z.number(),
              score: z.number(),
              rank: z.number(),
            }),
            placements: z.array(
              z.object({
                badgeId: z.string(),
                x: z.number(),
                y: z.number(),
              }),
            ),
            ogImageUrl: z.string().nullable(),
          }),
          404: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const { wallet } = req.params;

      const user = await models.User.findById(wallet).lean();
      if (!user) {
        throw new AppError({
          code: ErrorCode.LAND_NOT_FOUND,
          message: "This wallet has no land yet",
          statusCode: 404,
        });
      }

      const [placements, claims, txAgg] = await Promise.all([
        models.Placement.find({ "_id.walletAddress": wallet }).lean(),
        models.BadgeClaim.find({ "_id.walletAddress": wallet }, { _id: 1 }).lean(),
        models.Tx.aggregate<{ protocols: string[]; transactions: number }>([
          { $match: { walletAddress: wallet } },
          {
            $group: {
              _id: null,
              protocols: { $addToSet: "$protocol" },
              transactions: { $sum: 1 },
            },
          },
        ]),
      ]);

      const claimedIds = claims.map(
        (c) => (c._id as unknown as { badgeId: BadgeId }).badgeId,
      );

      // Compute score from claims (source of truth) and use the denormalized
      // User.score for ranking. They should match in steady state, but we don't
      // need to trust the cache for the user-facing number.
      const computedScore = score(claimedIds);
      const rank = await getRank(computedScore);

      const stats = {
        protocols: txAgg[0]?.protocols.length ?? 0,
        transactions: txAgg[0]?.transactions ?? 0,
        score: computedScore,
        rank,
      };

      reply.header("Cache-Control", "public, max-age=30");
      return {
        wallet,
        stats,
        placements: placements.map((p) => ({
          badgeId: (p._id as unknown as { badgeId: string }).badgeId,
          x: p.tileX,
          y: p.tileY,
        })),
        ogImageUrl: user["ogImageUrl"] ?? null,
      };
    },
  );

  fastify.get(
    "/lands/:wallet/inventory",
    {
      schema: {
        params: walletParam,
        response: {
          200: z.object({
            claimed: z.array(
              z.object({
                badgeId: z.string(),
                weight: z.number(),
                assetId: z.string(),
              }),
            ),
            eligible: z.array(
              z.object({
                badgeId: z.string(),
                weight: z.number(),
                eligibleSince: z.date(),
                meta: z.record(z.string(), z.unknown()),
              }),
            ),
          }),
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireOwner,
    },
    async (req) => {
      const { wallet } = req.params;

      const [claims, eligibilities] = await Promise.all([
        models.BadgeClaim.find({ "_id.walletAddress": wallet }).lean(),
        models.BadgeEligibility.find({ "_id.walletAddress": wallet }).lean(),
      ]);

      const claimedIds = new Set(
        claims.map((c) => (c._id as unknown as { badgeId: BadgeId }).badgeId),
      );

      const claimed = claims.map((c) => {
        const id = (c._id as unknown as { badgeId: BadgeId }).badgeId;
        return {
          badgeId: id,
          weight: REGISTRY[id]?.weight ?? 0,
          assetId: c["assetId"],
        };
      });

      const eligible = eligibilities
        .filter((e) => !claimedIds.has((e._id as unknown as { badgeId: BadgeId }).badgeId))
        .map((e) => {
          const id = (e._id as unknown as { badgeId: BadgeId }).badgeId;
          return {
            badgeId: id,
            weight: REGISTRY[id]?.weight ?? 0,
            eligibleSince: e["eligibleSince"],
            meta: e["meta"] ?? {},
          };
        });

      return { claimed, eligible };
    },
  );
};
