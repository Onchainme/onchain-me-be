import fp from "fastify-plugin";
import basicAuth from "@fastify/basic-auth";
import { loadEnv } from "@onchainme/shared";

export const basicAuthPlugin = fp(async (fastify) => {
  const env = loadEnv();
  const [user, pass] = env.ADMIN_BASIC_AUTH.split(":");
  await fastify.register(basicAuth, {
    validate: async (username, password) => {
      if (username !== user || password !== pass) {
        throw new Error("Invalid credentials");
      }
    },
    authenticate: { realm: "OnchainMe Admin" },
  });
});
