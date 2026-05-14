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
                // Nested stats mirror /lands/:wallet exactly so the frontend
                // can render the same card layout in the grid as in the
                // single-land view (transactions, distinct protocols, etc.)
                // without a second per-card fetch. `score` + `rank` are also
                // exposed as flat sibling fields above for backwards
                // compatibility with the existing toLandSummary mapping —
                // we'll consolidate once the frontend has fully migrated.
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
        // Exclude unranked users from the leaderboard sort. Without this every
        // freshly-logged-in wallet with score=0 shows up in the grid, gets a
        // rank=0 sentinel (frontend hides the badge), and looks like a broken
        // entry. They're still visible under sort=recent which is the right
        // place for them.
        filter.score = { $gt: 0 };
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

      // Fan-out all per-wallet aggregations in parallel. Placements + tx
      // aggregate are both indexed by walletAddress so each is a single
      // query for the whole page, not N queries.
      const placementDocs = wallets.length
        ? await models.Placement.find({ "_id.walletAddress": { $in: wallets } }).lean()
        : [];
      const txAggDocs = wallets.length
        ? await models.Tx.aggregate<{
            _id: string;
            protocols: string[];
            transactions: number;
          }>([
            { $match: { walletAddress: { $in: wallets } } },
            {
              $group: {
                _id: "$walletAddress",
                protocols: { $addToSet: "$protocol" },
                transactions: { $sum: 1 },
              },
            },
          ])
        : [];

      const placementsByWallet = new Map<
        string,
        Array<{ badgeId: string; x: number; y: number }>
      >();
      for (const p of placementDocs) {
        const id = p._id as unknown as { walletAddress: string; badgeId: string };
        const list = placementsByWallet.get(id.walletAddress) ?? [];
        list.push({ badgeId: id.badgeId, x: p.tileX, y: p.tileY });
        placementsByWallet.set(id.walletAddress, list);
      }

      // Same shape as /lands/:wallet's stats block. Wallets with no Tx
      // documents (e.g. fresh users who haven't been scanned yet) get
      // protocols=0 / transactions=0 implicitly.
      const statsByWallet = new Map<string, { protocols: number; transactions: number }>();
      for (const row of txAggDocs) {
        statsByWallet.set(row._id, {
          protocols: row.protocols.length,
          transactions: row.transactions,
        });
      }

      const scores = page.map((u) => (u["score"] as number | undefined) ?? 0);
      const ranks = await getRanks(scores);

      const items = page.map((u, i) => {
        const wallet = u._id as unknown as string;
        const placements = placementsByWallet.get(wallet) ?? [];
        const txStats = statsByWallet.get(wallet) ?? { protocols: 0, transactions: 0 };
        const score = scores[i] ?? 0;
        const rank = ranks[i] ?? 0;
        return {
          wallet,
          ogImageUrl: u["ogImageUrl"] ?? null,
          objectsCount: placements.length,
          score,
          rank,
          stats: {
            protocols: txStats.protocols,
            transactions: txStats.transactions,
            score,
            rank,
          },
          placements,
        };
      });

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
            // When the worker last finished a scan for this wallet. null if
            // the user has never been scanned (fresh signup). Frontend uses
            // it to render a "Last scanned X ago" indicator.
            lastScanAt: z.date().nullable(),
            // When position-snapshot (Orca / Meteora / Seeker) data was
            // refreshed. May lag lastScanAt by a few seconds — but in normal
            // flow they're equal because both are written at the end of one
            // scan job.
            positionsTakenAt: z.date().nullable(),
          }),
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireOwner,
    },
    async (req) => {
      const { wallet } = req.params;

      const [claims, eligibilities, user] = await Promise.all([
        models.BadgeClaim.find({ "_id.walletAddress": wallet }).lean(),
        models.BadgeEligibility.find({ "_id.walletAddress": wallet }).lean(),
        models.User.findById(wallet).lean(),
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

      const lastScanAt = (user?.["lastScanAt"] as Date | null | undefined) ?? null;
      const positionSnapshot = user?.["positionSnapshot"] as
        | { takenAt?: Date | null }
        | undefined;
      const positionsTakenAt = positionSnapshot?.takenAt ?? null;

      return { claimed, eligible, lastScanAt, positionsTakenAt };
    },
  );
};
