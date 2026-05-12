import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  disableOnchainBackfill,
  enableOnchainBackfill,
  getOnchainBackfillStatus,
} from "@onchainme/shared";

/**
 * Admin endpoints — basic-auth gated (same credentials as Bull Board, set via
 * ADMIN_BASIC_AUTH env). Currently exposes only the on-chain-backfill toggle
 * that QA needs to re-mint badges whose cNFTs are already live on the merkle
 * tree.
 *
 * Toggle from the terminal:
 *
 *   # disable backfill for 1h so we can re-mint
 *   curl -u admin:PASS -X POST https://api.../api/v1/admin/onchain-backfill \
 *        -H 'Content-Type: application/json' \
 *        -d '{"enabled": false, "reason": "qa", "ttlSeconds": 3600}'
 *
 *   # re-enable immediately
 *   curl -u admin:PASS -X POST https://api.../api/v1/admin/onchain-backfill \
 *        -H 'Content-Type: application/json' \
 *        -d '{"enabled": true}'
 *
 *   # check current state
 *   curl -u admin:PASS https://api.../api/v1/admin/onchain-backfill
 */

const statusSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  ttlSeconds: z.number().nullable(),
});

const postBody = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).max(120).optional(),
  // Max 24h so a forgotten flip auto-restores anti-duplicate-mint protection.
  ttlSeconds: z.number().int().positive().max(86_400).optional(),
});

export const adminRoute: FastifyPluginAsyncZod = async (fastify) => {
  // Gate every /admin/* route with basic auth (decorated by basicAuthPlugin).
  fastify.addHook("onRequest", fastify.basicAuth);

  fastify.get(
    "/admin/onchain-backfill",
    { schema: { response: { 200: statusSchema } } },
    async () => {
      return getOnchainBackfillStatus();
    },
  );

  fastify.post(
    "/admin/onchain-backfill",
    { schema: { body: postBody, response: { 200: statusSchema } } },
    async (req) => {
      const { enabled, reason, ttlSeconds } = req.body;
      if (enabled) {
        await enableOnchainBackfill();
      } else {
        await disableOnchainBackfill(
          reason ?? "manual",
          ttlSeconds ?? 3600,
        );
      }
      return getOnchainBackfillStatus();
    },
  );
};
