import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { getRedisConnection, ErrorCode, loadEnv } from "@onchainme/shared";

export const rateLimitPlugin = fp(async (fastify) => {
  const env = loadEnv();

  if (env.NODE_ENV === "test") {
    return; // no-op in test environment
  }

  await fastify.register(rateLimit, {
    redis: getRedisConnection(),
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      error: {
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        message: `Rate limit exceeded. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`,
        details: { retryAfterMs: ctx.ttl },
      },
    }),
  });

  fastify.addHook("onRoute", (route) => {
    if (!route.config?.rateLimit) {
      route.config = {
        ...route.config,
        rateLimit: { max: 100, timeWindow: "1 minute" },
      };
    }
  });
});
