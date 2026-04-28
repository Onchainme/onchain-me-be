import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

export const requestIdPlugin = fp(async (fastify) => {
  fastify.addHook("onRequest", async (req, reply) => {
    const incoming = req.headers["x-request-id"];
    const id = typeof incoming === "string" && incoming.length > 0 ? incoming : `req_${randomUUID()}`;
    req.id = id;
    reply.header("x-request-id", id);
  });
});
