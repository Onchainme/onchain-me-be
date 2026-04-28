import { describe, it, expect } from "vitest";
import { AppError, ErrorCode } from "../src/errors.js";

describe("AppError", () => {
  it("stores code, message, statusCode, and details", () => {
    const err = new AppError({
      code: ErrorCode.BADGE_NOT_ELIGIBLE,
      message: "Not eligible",
      statusCode: 422,
      details: { current: 12, required: 50 },
    });

    expect(err.code).toBe(ErrorCode.BADGE_NOT_ELIGIBLE);
    expect(err.message).toBe("Not eligible");
    expect(err.statusCode).toBe(422);
    expect(err.details).toEqual({ current: 12, required: 50 });
    expect(err).toBeInstanceOf(Error);
  });

  it("serializes to the wire envelope shape", () => {
    const err = new AppError({
      code: ErrorCode.TILE_OCCUPIED,
      message: "Tile already occupied",
      statusCode: 409,
      details: { x: 4, y: 7 },
    });

    expect(err.toJSON()).toEqual({
      error: {
        code: "TILE_OCCUPIED",
        message: "Tile already occupied",
        details: { x: 4, y: 7 },
      },
    });
  });

  it("omits details from JSON when not provided", () => {
    const err = new AppError({
      code: ErrorCode.AUTH_TOKEN_MISSING,
      message: "No token",
      statusCode: 401,
    });

    expect(err.toJSON()).toEqual({
      error: {
        code: "AUTH_TOKEN_MISSING",
        message: "No token",
      },
    });
  });
});

describe("ErrorCode", () => {
  it("contains all spec-defined codes", () => {
    const expected = [
      "VALIDATION_ERROR",
      "INVALID_WALLET_FORMAT",
      "INVALID_BADGE_ID",
      "INVALID_TILE_COORDINATE",
      "AUTH_NONCE_EXPIRED",
      "AUTH_NONCE_CONSUMED",
      "AUTH_SIGNATURE_INVALID",
      "AUTH_TOKEN_MISSING",
      "AUTH_TOKEN_INVALID",
      "FORBIDDEN_RESOURCE_OWNER",
      "LAND_NOT_FOUND",
      "JOB_NOT_FOUND",
      "TILE_OCCUPIED",
      "BADGE_ALREADY_CLAIMED",
      "SCAN_ALREADY_RUNNING",
      "BADGE_NOT_ELIGIBLE",
      "TX_BLOCKHASH_EXPIRED",
      "PLACEMENT_FOR_UNCLAIMED",
      "RATE_LIMIT_EXCEEDED",
      "INTERNAL_ERROR",
      "HELIUS_UNAVAILABLE",
      "SOLANA_RPC_UNAVAILABLE",
      "DATABASE_UNAVAILABLE",
      "REDIS_UNAVAILABLE",
      "MINT_AUTHORITY_OUT_OF_FUNDS",
    ];

    for (const code of expected) {
      expect(ErrorCode[code as keyof typeof ErrorCode]).toBe(code);
    }
  });
});
