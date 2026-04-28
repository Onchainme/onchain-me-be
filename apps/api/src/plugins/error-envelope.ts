import fp from "fastify-plugin";
import { AppError, captureException, ErrorCode } from "@onchainme/shared";
import { ZodError } from "zod";

interface HttpLikeError {
  statusCode: number;
  message: string;
}

function isHttpLikeError(err: unknown): err is HttpLikeError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as Record<string, unknown>)["statusCode"] === "number" &&
    typeof (err as Record<string, unknown>)["message"] === "string"
  );
}

export const errorEnvelopePlugin = fp(async (fastify) => {
  fastify.setErrorHandler((err, req, reply) => {
    const requestId = req.id;

    if (err instanceof AppError) {
      req.log.warn({ code: err.code, requestId }, err.message);
      if (err.statusCode >= 500) {
        captureException(err, {
          requestId,
          route: req.routeOptions?.url ?? req.url,
          method: req.method,
          code: err.code,
        });
      }
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
      });
    }

    if (err instanceof ZodError) {
      req.log.warn({ issues: err.issues, requestId }, "validation failed");
      return reply.code(400).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: "Request validation failed",
          details: { issues: err.issues },
          requestId,
        },
      });
    }

    if (isHttpLikeError(err) && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: err.message,
          requestId,
        },
      });
    }

    req.log.error({ err, requestId }, "unhandled error");
    captureException(err, {
      requestId,
      route: req.routeOptions?.url ?? req.url,
      method: req.method,
    });
    return reply.code(500).send({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: "Internal server error",
        requestId,
      },
    });
  });
});
