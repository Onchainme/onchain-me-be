import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { AppError, ErrorCode, models, createQueue, QUEUE_NAMES } from "@onchainme/shared";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";

const scanQueue = createQueue<{
  walletAddress: string;
  mode: "full" | "incremental";
  scanJobId: string;
}>(QUEUE_NAMES.scan);

const scanParams = z.object({
  wallet: z.string().min(32).max(64),
});

const scanQuery = z.object({
  mode: z.enum(["full", "incremental"]).default("full"),
});

const jobParams = z.object({
  jobId: z.string().regex(/^[a-f0-9]{24}$/, "jobId must be a 24-char hex"),
});

export const scanRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/scan/:wallet",
    {
      schema: {
        params: scanParams,
        querystring: scanQuery,
        response: {
          202: z.object({ jobId: z.string() }),
          400: errorEnvelopeSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireOwner,
      config: {
        rateLimit: {
          max: (req: FastifyRequest) =>
            (req.query as { mode?: string }).mode === "incremental" ? 2 : 1,
          timeWindow: (req: FastifyRequest) =>
            (req.query as { mode?: string }).mode === "incremental" ? 30_000 : 300_000,
          keyGenerator: (req: FastifyRequest) =>
            `scan:${(req.params as { wallet: string }).wallet}`,
        },
      },
    },
    async (req, reply) => {
      const { wallet } = req.params;
      const { mode } = req.query;

      // Server-side dedup: a wallet already has an active scan in BullMQ — return
      // the same jobId instead of spinning up a duplicate. Without this, a double
      // click on "Update inventory" creates two jobs that fight over Helius
      // rate limits and both fail. Stale "running" rows older than 10 minutes
      // are ignored — those are dead jobs awaiting a worker restart cleanup.
      const RUNNING_TTL_MS = 10 * 60 * 1000;
      const existing = await models.ScanJob.findOne({
        walletAddress: wallet,
        status: { $in: ["queued", "running"] },
        startedAt: { $gte: new Date(Date.now() - RUNNING_TTL_MS) },
      })
        .sort({ startedAt: -1 })
        .lean();
      if (existing) {
        return reply.code(202).send({ jobId: existing._id.toString() });
      }

      const scanJobDoc = await models.ScanJob.create({
        _id: new Types.ObjectId(),
        walletAddress: wallet,
        mode,
        status: "queued",
        startedAt: new Date(),
      });

      const scanJobIdStr = scanJobDoc._id.toString();
      await scanQueue.add(
        "scanWallet",
        { walletAddress: wallet, mode, scanJobId: scanJobIdStr },
        {
          jobId: scanJobIdStr,
          // 3 attempts is enough — Helius free-tier 429s typically clear within
          // ~30s of backoff. Longer chains just stretch the failure window
          // without changing the outcome.
          attempts: 3,
          // 30s base × exponential = 30s → 60s → 120s of recovery time before
          // re-attempt. The previous 4-8s base barely outlasted Cloudflare's
          // sliding-window throttle, so retries hit the same wall.
          backoff: { type: "exponential", delay: 30_000 },
        },
      );

      return reply.code(202).send({ jobId: scanJobIdStr });
    },
  );

  fastify.get(
    "/scan/job/:jobId",
    {
      schema: {
        params: jobParams,
        response: {
          200: z.object({
            status: z.string(),
            progress: z.union([
              z.object({
                phase: z.string().optional(),
                processed: z.number().optional(),
                total: z.number().optional(),
              }),
              z.null(),
            ]),
            result: z.union([z.record(z.string(), z.unknown()), z.null()]),
            error: z.union([z.string(), z.null()]),
          }),
          401: errorEnvelopeSchema,
          404: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
    },
    async (req) => {
      const { jobId } = req.params;
      const doc = await models.ScanJob.findById(new Types.ObjectId(jobId)).lean();
      if (!doc) {
        throw new AppError({
          code: ErrorCode.JOB_NOT_FOUND,
          message: "Scan job not found",
          statusCode: 404,
        });
      }
      return {
        status: doc["status"] as string,
        progress: (doc["progress"] as { phase?: string; processed?: number; total?: number } | undefined) ?? null,
        result: (doc["result"] as Record<string, unknown> | undefined) ?? null,
        error: (doc["error"] as string | undefined) ?? null,
      };
    },
  );
};
