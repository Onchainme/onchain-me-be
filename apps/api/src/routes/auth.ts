import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import {
  AppError,
  ErrorCode,
  loadEnv,
  buildSiwsMessage,
  verifySiwsSignature,
  models,
} from "@onchainme/shared";

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_S = 7 * 24 * 60 * 60;

const walletSchema = z.string().refine(
  (v) => {
    try {
      return bs58.decode(v).length === 32;
    } catch {
      return false;
    }
  },
  { message: "wallet must be a base58 32-byte public key" },
);

const nonceBody = z.object({ wallet: walletSchema });
const verifyBody = z.object({
  wallet: walletSchema,
  nonce: z.string().min(1),
  signature: z.string().min(1),
});

export const authRoute: FastifyPluginAsyncZod = async (fastify) => {
  const env = loadEnv();

  fastify.post(
    "/auth/nonce",
    {
      schema: {
        body: nonceBody,
        response: {
          200: z.object({ nonce: z.string(), message: z.string() }),
          400: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const { wallet } = req.body;
      const nonce = randomBytes(32).toString("hex");
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);

      await models.AuthNonce.create({ _id: nonce, walletAddress: wallet, expiresAt });

      const message = buildSiwsMessage({
        wallet,
        nonce,
        issuedAt,
        expiresAt,
        domain: env.COOKIE_DOMAIN === "localhost" ? "onchainme.local" : env.COOKIE_DOMAIN,
      });

      return { nonce, message };
    },
  );

  fastify.post(
    "/auth/verify",
    {
      schema: {
        body: verifyBody,
        response: {
          200: z.object({ wallet: z.string() }),
          400: errorEnvelopeSchema,
          401: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { wallet, nonce, signature } = req.body;

      const stored = await models.AuthNonce.findById(nonce);
      if (!stored) {
        throw new AppError({
          code: ErrorCode.AUTH_NONCE_EXPIRED,
          message: "Nonce not found or expired",
          statusCode: 401,
        });
      }
      if (stored["consumedAt"]) {
        throw new AppError({
          code: ErrorCode.AUTH_NONCE_CONSUMED,
          message: "Nonce already used",
          statusCode: 401,
        });
      }
      if (stored["expiresAt"].getTime() < Date.now()) {
        throw new AppError({
          code: ErrorCode.AUTH_NONCE_EXPIRED,
          message: "Nonce expired",
          statusCode: 401,
        });
      }
      if (stored["walletAddress"] !== wallet) {
        throw new AppError({
          code: ErrorCode.AUTH_SIGNATURE_INVALID,
          message: "Wallet mismatch",
          statusCode: 401,
        });
      }

      const issuedAt = new Date(stored["expiresAt"].getTime() - NONCE_TTL_MS);
      const message = buildSiwsMessage({
        wallet,
        nonce,
        issuedAt,
        expiresAt: stored["expiresAt"],
        domain: env.COOKIE_DOMAIN === "localhost" ? "onchainme.local" : env.COOKIE_DOMAIN,
      });

      if (!verifySiwsSignature({ wallet, message, signatureBase58: signature })) {
        throw new AppError({
          code: ErrorCode.AUTH_SIGNATURE_INVALID,
          message: "Signature verification failed",
          statusCode: 401,
        });
      }

      await models.AuthNonce.updateOne({ _id: nonce }, { $set: { consumedAt: new Date() } });

      await models.User.updateOne(
        { _id: wallet },
        { $set: { lastSeenAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );

      const token = await reply.jwtSign({ wallet }, { expiresIn: `${SESSION_TTL_S}s` });

      const frontendUrl = new URL(env.FRONTEND_ORIGIN);
      const apiHost = req.hostname ?? "localhost";
      // If frontend and api share a registrable domain, "lax" works (browser keeps the cookie on cross-origin POSTs from the frontend).
      // If they don't (e.g. frontend on vercel.app, api on railway.app), browser drops the cookie unless SameSite=None + Secure.
      const crossSite =
        frontendUrl.hostname !== apiHost &&
        !apiHost.endsWith(`.${env.COOKIE_DOMAIN}`) &&
        apiHost !== env.COOKIE_DOMAIN;
      const sameSite: "lax" | "none" = crossSite ? "none" : "lax";
      const secure = sameSite === "none" || env.NODE_ENV === "production";

      reply.setCookie("om_session", token, {
        httpOnly: true,
        secure,
        sameSite,
        path: "/",
        ...(env.COOKIE_DOMAIN !== "localhost" && { domain: env.COOKIE_DOMAIN }),
        maxAge: SESSION_TTL_S,
      });

      return { wallet };
    },
  );

  fastify.get(
    "/auth/me",
    {
      schema: {
        response: {
          200: z.object({ wallet: z.string() }),
          401: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
    },
    async (req) => {
      return { wallet: (req.user as { wallet: string }).wallet };
    },
  );

  fastify.post(
    "/auth/logout",
    {
      schema: {
        response: {
          204: z.null(),
          401: errorEnvelopeSchema,
        },
      },
      preHandler: fastify.requireAuth,
    },
    async (req, reply) => {
      // Browser only deletes a cookie if Set-Cookie attributes (domain + path)
      // match what was used at write time. Without `domain` the clear silently
      // no-ops when the original cookie was set with Domain=<COOKIE_DOMAIN>.
      const apiHost = ((req.headers.host ?? "").split(":")[0]) ?? "";
      const frontendUrl = new URL(env.FRONTEND_ORIGIN);
      const crossSite =
        frontendUrl.hostname !== apiHost &&
        !apiHost.endsWith(`.${env.COOKIE_DOMAIN}`) &&
        apiHost !== env.COOKIE_DOMAIN;
      const sameSite: "lax" | "none" = crossSite ? "none" : "lax";
      const secure = sameSite === "none" || env.NODE_ENV === "production";

      reply.clearCookie("om_session", {
        path: "/",
        secure,
        sameSite,
        ...(env.COOKIE_DOMAIN !== "localhost" && { domain: env.COOKIE_DOMAIN }),
      });
      return reply.code(204).send(null);
    },
  );
};
