import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { definitionsArray } from "@onchainme/shared";

const badgeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  protocol: z.enum(["jupiter", "pumpfun", "orca", "meteora", "seeker"]),
  tier: z.enum(["bronze", "silver", "original", "single"]),
  thresholdUsd: z.number().nullable(),
  weight: z.number(),
  previewFile: z.string(),
  animationFile: z.string(),
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
        protocol: def.protocol,
        tier: def.tier,
        thresholdUsd: def.thresholdUsd,
        weight: def.weight,
        previewFile: def.previewFile,
        animationFile: def.animationFile,
      }));
      return { items };
    },
  );
};
