import fp from "fastify-plugin";
import cors from "@fastify/cors";
import { loadEnv } from "@onchainme/shared";

export const corsPlugin = fp(async (fastify) => {
  const env = loadEnv();
  const allowed = new URL(env.FRONTEND_ORIGIN);

  // In production, also allow any subdomain of the frontend origin's hostname.
  const subdomainPattern = new RegExp(
    `^${allowed.protocol}//([a-z0-9-]+\\.)?${allowed.hostname.replace(/\./g, "\\.")}$`,
  );

  await fastify.register(cors, {
    origin: env.NODE_ENV === "production"
      ? subdomainPattern
      : [env.FRONTEND_ORIGIN, "http://localhost:3000"],
    credentials: true,
  });
});
