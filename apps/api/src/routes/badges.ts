import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { definitionsArray } from "@onchainme/shared";

const badgeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  iconUrl: z.string(),
  tier: z.enum(["common", "rare", "epic", "legendary"]),
  weight: z.number(),
});

export const badgesRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/badges",
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(badgeSchema),
          }),
        },
      },
    },
    async (_req, reply) => {
      // Catalog is fully derived from the in-memory REGISTRY — long cache is safe.
      reply.header("Cache-Control", "public, max-age=300");
      const items = definitionsArray().map((def) => ({
        id: def.id,
        name: def.name,
        description: def.description,
        iconUrl: def.iconUrl,
        tier: def.tier,
        weight: def.weight,
      }));
      return { items };
    },
  );
};
