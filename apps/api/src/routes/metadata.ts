import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getBadge, REGISTRY } from "@onchainme/shared";

const params = z.object({
  badgeId: z.string().min(1).max(80),
});

const metadataSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  description: z.string(),
  image: z.string(),
  external_url: z.string().optional(),
  attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) })),
  properties: z.object({
    files: z.array(z.object({ uri: z.string(), type: z.string() })),
    category: z.string(),
  }),
});

export const metadataRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/metadata/:badgeId",
    {
      schema: {
        params,
        response: {
          200: metadataSchema,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const raw = req.params.badgeId;
      const badgeId = raw.endsWith(".json") ? raw.slice(0, -".json".length) : raw;
      const def = getBadge(badgeId) ?? REGISTRY[badgeId as keyof typeof REGISTRY];
      if (!def) {
        return reply.code(404).send({ error: `Unknown badgeId: ${badgeId}` });
      }

      const proto = req.headers["x-forwarded-proto"] ?? (req.protocol as string);
      const host = req.headers["x-forwarded-host"] ?? req.headers.host;
      const baseImage = `${proto}://${host}${def.iconUrl}`;

      reply.header("Cache-Control", "public, max-age=300");
      return {
        name: def.name,
        symbol: "OCM",
        description: def.description,
        image: baseImage,
        external_url: `https://onchain.me/badge/${badgeId}`,
        attributes: [
          { trait_type: "Tier", value: def.tier },
          { trait_type: "Weight", value: def.weight },
        ],
        properties: {
          files: [{ uri: baseImage, type: "image/svg+xml" }],
          category: "image",
        },
      };
    },
  );
};
