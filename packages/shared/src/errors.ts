export const ErrorCode = {
  // 400 validation
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_WALLET_FORMAT: "INVALID_WALLET_FORMAT",
  INVALID_BADGE_ID: "INVALID_BADGE_ID",
  INVALID_TILE_COORDINATE: "INVALID_TILE_COORDINATE",

  // 401 auth
  AUTH_NONCE_EXPIRED: "AUTH_NONCE_EXPIRED",
  AUTH_NONCE_CONSUMED: "AUTH_NONCE_CONSUMED",
  AUTH_SIGNATURE_INVALID: "AUTH_SIGNATURE_INVALID",
  AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",

  // 403 authorization
  FORBIDDEN_RESOURCE_OWNER: "FORBIDDEN_RESOURCE_OWNER",

  // 404 not found
  LAND_NOT_FOUND: "LAND_NOT_FOUND",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",

  // 409 conflict
  TILE_OCCUPIED: "TILE_OCCUPIED",
  BADGE_ALREADY_CLAIMED: "BADGE_ALREADY_CLAIMED",
  SCAN_ALREADY_RUNNING: "SCAN_ALREADY_RUNNING",

  // 422 business logic
  BADGE_NOT_ELIGIBLE: "BADGE_NOT_ELIGIBLE",
  TX_BLOCKHASH_EXPIRED: "TX_BLOCKHASH_EXPIRED",
  PLACEMENT_FOR_UNCLAIMED: "PLACEMENT_FOR_UNCLAIMED",
  TX_FAILED: "TX_FAILED",
  TX_NOT_FOUND: "TX_NOT_FOUND",

  // 429 rate limit
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // 5xx infra
  INTERNAL_ERROR: "INTERNAL_ERROR",
  HELIUS_UNAVAILABLE: "HELIUS_UNAVAILABLE",
  SOLANA_RPC_UNAVAILABLE: "SOLANA_RPC_UNAVAILABLE",
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  REDIS_UNAVAILABLE: "REDIS_UNAVAILABLE",
  MINT_AUTHORITY_OUT_OF_FUNDS: "MINT_AUTHORITY_OUT_OF_FUNDS",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  code: ErrorCodeValue;
  message: string;
  statusCode: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: ErrorCodeValue;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(opts: AppErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    if (opts.details !== undefined) {
      this.details = opts.details;
    }
  }

  toJSON(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    const payload: { code: string; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) payload.details = this.details;
    return { error: payload };
  }
}
