import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { models } from "@onchainme/shared";

function startOfTodayUtc(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export const statsRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/stats",
    {
      schema: {
        response: {
          200: z.object({
            totalMinted: z.number(),
            mintedToday: z.number(),
            totalUsers: z.number(),
            totalPlacements: z.number(),
          }),
        },
      },
    },
    async (_req, reply) => {
      const since = startOfTodayUtc();

      const [totalMinted, mintedToday, totalUsers, totalPlacements] = await Promise.all([
        models.BadgeClaim.estimatedDocumentCount(),
        models.BadgeClaim.countDocuments({ mintedAt: { $gte: since } }),
        models.User.estimatedDocumentCount(),
        models.Placement.estimatedDocumentCount(),
      ]);

      // 5-min cache: Hero "LANDS MINTED" + LandingStats are the only consumers
      // and neither needs second-by-second accuracy. Matches the frontend's
      // `next: { revalidate: 300 }` so SSR + edge cache stay in sync.
      // `s-maxage` keeps Caddy/CDN honest if we ever drop one in front.
      reply.header("Cache-Control", "public, max-age=300, s-maxage=300");
      return { totalMinted, mintedToday, totalUsers, totalPlacements };
    },
  );
};
