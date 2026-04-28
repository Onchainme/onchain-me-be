import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { loadEnv } from "@onchainme/shared";

export const swaggerPlugin = fp(async (fastify) => {
  const env = loadEnv();
  if (env.NODE_ENV === "production") return;

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "OnchainMe API",
        version: "0.0.0",
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
    transform: jsonSchemaTransform,
  });

  await fastify.register(swaggerUi, { routePrefix: "/docs" });
});
