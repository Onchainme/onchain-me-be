import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { type ZodTypeProvider, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { connectDb, initSentry, loadEnv } from "@onchainme/shared";
import { registerRoutes } from "./routes/index.js";
import { requestIdPlugin } from "./plugins/request-id.js";
import { errorEnvelopePlugin } from "./plugins/error-envelope.js";
import { corsPlugin } from "./plugins/cors.js";
import { swaggerPlugin } from "./plugins/swagger.js";
import { authPlugin } from "./plugins/auth.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { basicAuthPlugin } from "./plugins/basic-auth.js";
import { bullBoardPlugin } from "./plugins/bull-board.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer(): Promise<FastifyInstance> {
  const env = loadEnv();
  initSentry({ component: "api" });

  const loggerOpts =
    env.NODE_ENV === "development"
      ? {
          level: env.LOG_LEVEL,
          transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
        }
      : { level: env.LOG_LEVEL };

  const app = Fastify({ logger: loggerOpts }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(requestIdPlugin);
  await app.register(errorEnvelopePlugin);
  await app.register(corsPlugin);

  // Serve badge GIF/PNG assets directly from disk. In dev tsc emits to
  // apps/api/dist/, so the public dir sits one level up at apps/api/public.
  // In Docker we COPY the same public/ tree into /app/apps/api/public.
  const publicRoot = path.resolve(__dirname, "..", "public");
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",                 // serves /badges/<name>.gif
    decorateReply: false,
    cacheControl: true,
    maxAge: "1h",
    setHeaders(res) {
      // Public, credential-less static art. The global corsPlugin echoes the
      // request Origin + sets `credentials: true` + `Vary: Origin`, which
      // makes a `public, max-age=1h` response per-origin and fragile: a copy
      // cached for one origin (or for a no-Origin prefetch) replays with the
      // wrong / missing ACAO and the browser blocks the canvas texture load
      // ("CORS Allow Origin Not Matching Origin"). Badge images need no
      // cookies, so override with a wildcard: identical for every origin →
      // safely cacheable, immune to the Origin/cache-key mismatch. Strip the
      // credentials header (illegal alongside `*`) and the now-pointless Vary.
      // @fastify/static's SetHeadersResponse type only exposes setHeader, but
      // the runtime object is a Node ServerResponse — cast for removeHeader.
      const raw = res as unknown as import("node:http").ServerResponse;
      raw.setHeader("Access-Control-Allow-Origin", "*");
      raw.removeHeader("Access-Control-Allow-Credentials");
      raw.removeHeader("Vary");
    },
  });

  await app.register(authPlugin);
  await app.register(rateLimitPlugin);
  await app.register(basicAuthPlugin);
  await app.register(bullBoardPlugin);
  await app.register(swaggerPlugin);
  await app.register(registerRoutes);

  return app;
}

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildServer();
  try {
    await connectDb();
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info({ signal }, "shutting down");
      await app.close();
      process.exit(0);
    });
  }
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  void start();
}
