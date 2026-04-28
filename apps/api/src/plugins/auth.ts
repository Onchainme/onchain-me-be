import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { loadEnv, AppError, ErrorCode } from "@onchainme/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwner: (
      req: FastifyRequest<{ Params: { wallet: string } }>,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { wallet: string };
    user: { wallet: string };
  }
}

export const authPlugin = fp(async (fastify) => {
  const env = loadEnv();

  await fastify.register(cookie);

  await fastify.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: { cookieName: "om_session", signed: false },
    sign: { algorithm: "HS256" },
    verify: { algorithms: ["HS256"] },
  });

  fastify.decorate(
    "requireAuth",
    async (req: FastifyRequest, _reply: FastifyReply) => {
      try {
        await req.jwtVerify();
        req.user = { wallet: (req.user as { wallet: string }).wallet };
      } catch {
        throw new AppError({
          code: ErrorCode.AUTH_TOKEN_INVALID,
          message: "Authentication required",
          statusCode: 401,
        });
      }
    },
  );

  fastify.decorate(
    "requireOwner",
    async (
      req: FastifyRequest<{ Params: { wallet: string } }>,
      _reply: FastifyReply,
    ) => {
      try {
        await req.jwtVerify();
      } catch {
        throw new AppError({
          code: ErrorCode.AUTH_TOKEN_INVALID,
          message: "Authentication required",
          statusCode: 401,
        });
      }
      if ((req.user as { wallet: string }).wallet !== req.params.wallet) {
        throw new AppError({
          code: ErrorCode.FORBIDDEN_RESOURCE_OWNER,
          message: "You can only access your own wallet's resources",
          statusCode: 403,
        });
      }
    },
  );
});
