import { Buffer } from "node:buffer";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { models } from "@onchainme/shared";

const feedQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const feedItemSchema = z.union([
  z.object({
    type: z.literal("mint"),
    at: z.string(),
    wallet: z.string(),
    badgeId: z.string(),
    assetId: z.string(),
  }),
  z.object({
    type: z.literal("placement"),
    at: z.string(),
    wallet: z.string(),
    badgeId: z.string(),
    x: z.number(),
    y: z.number(),
  }),
]);

interface FeedCursor {
  at: string;
  // tiebreaker key: deterministic ordering when two events share the same timestamp.
  key: string;
}

function encodeCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(s: string): FeedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (typeof parsed["at"] !== "string" || typeof parsed["key"] !== "string") return null;
    return { at: parsed["at"], key: parsed["key"] };
  } catch {
    return null;
  }
}

type FeedItem = z.infer<typeof feedItemSchema>;

function itemKey(it: FeedItem): string {
  if (it.type === "mint") return `mint:${it.wallet}:${it.badgeId}`;
  return `placement:${it.wallet}:${it.badgeId}`;
}

export const feedRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/feed",
    {
      schema: {
        querystring: feedQuery,
        response: {
          200: z.object({
            items: z.array(feedItemSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (req, reply) => {
      const { cursor, limit } = req.query;
      const decoded = cursor ? decodeCursor(cursor) : null;
      const cursorAt = decoded ? new Date(decoded.at) : null;

      // Over-fetch from each source so we can merge and still fill `limit` items.
      const fetchSize = limit + 1;

      const claimFilter = cursorAt ? { mintedAt: { $lt: cursorAt } } : {};
      const placementFilter = cursorAt ? { placedAt: { $lt: cursorAt } } : {};

      const [claims, placements] = await Promise.all([
        models.BadgeClaim.find(claimFilter)
          .sort({ mintedAt: -1 })
          .limit(fetchSize)
          .lean(),
        models.Placement.find(placementFilter)
          .sort({ placedAt: -1 })
          .limit(fetchSize)
          .lean(),
      ]);

      const claimItems: FeedItem[] = claims.map((c) => {
        const id = c._id as unknown as { walletAddress: string; badgeId: string };
        return {
          type: "mint" as const,
          at: (c["mintedAt"] as Date).toISOString(),
          wallet: id.walletAddress,
          badgeId: id.badgeId,
          assetId: c["assetId"] as string,
        };
      });

      const placementItems: FeedItem[] = placements.map((p) => {
        const id = p._id as unknown as { walletAddress: string; badgeId: string };
        return {
          type: "placement" as const,
          at: (p["placedAt"] as Date).toISOString(),
          wallet: id.walletAddress,
          badgeId: id.badgeId,
          x: p.tileX,
          y: p.tileY,
        };
      });

      // Merge and sort newest-first; tiebreaker on the synthetic key keeps order
      // deterministic across pages so the cursor never skips/repeats.
      const merged = [...claimItems, ...placementItems].sort((a, b) => {
        const cmp = b.at.localeCompare(a.at);
        if (cmp !== 0) return cmp;
        return itemKey(a).localeCompare(itemKey(b));
      });

      // Drop the cursor anchor itself if present (cursor uses strict `< at` from DB,
      // but two items at exactly the same timestamp may still slip through; use the
      // tiebreaker key to prune).
      const filtered = decoded
        ? merged.filter((it) => {
            if (it.at < decoded.at) return true;
            if (it.at === decoded.at) return itemKey(it) > decoded.key;
            return false;
          })
        : merged;

      const page = filtered.slice(0, limit);
      const last = page.at(-1);
      const hasMore = filtered.length > limit;
      const nextCursor =
        hasMore && last ? encodeCursor({ at: last.at, key: itemKey(last) }) : null;

      reply.header("Cache-Control", "public, max-age=10");
      return { items: page, nextCursor };
    },
  );
};
