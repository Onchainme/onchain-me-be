import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { connectDb, mongoose, getRedisConnection } from "@onchainme/shared";

const healthStatus = z.enum(["ok", "fail"]);

export const healthRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get("/health", {
    schema: {
      response: {
        200: z.object({ ok: z.literal(true), db: healthStatus, redis: healthStatus }),
        503: z.object({ ok: z.literal(false), db: healthStatus, redis: healthStatus }),
      },
    },
  }, async (_req, reply) => {
    const result: { ok: boolean; db: "ok" | "fail"; redis: "ok" | "fail" } = { ok: true, db: "ok", redis: "ok" };

    try {
      await connectDb();
      const adminDb = mongoose.connection.db;
      if (!adminDb) throw new Error("mongoose connection has no db handle");
      const pingResult = await adminDb.admin().ping();
      if (pingResult["ok"] !== 1) {
        result.db = "fail";
        result.ok = false;
      }
    } catch (err) {
      fastify.log.error({ err }, "health: db check failed");
      result.db = "fail";
      result.ok = false;
    }

    try {
      const ping = await getRedisConnection().ping();
      if (ping !== "PONG") {
        result.redis = "fail";
        result.ok = false;
      }
    } catch (err) {
      fastify.log.error({ err }, "health: redis check failed");
      result.redis = "fail";
      result.ok = false;
    }

    return reply.code(result.ok ? 200 : 503).send(result);
  });
};
