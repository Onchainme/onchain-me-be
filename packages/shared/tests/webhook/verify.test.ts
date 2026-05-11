import { describe, it, expect, beforeEach } from "vitest";
import { verifyHeliusSecret } from "../../src/webhook/verify.js";
import { _resetEnvCache } from "../../src/env.js";

const ORIG_ENV = process.env;

function setEnv(secret: string) {
  process.env = { ...ORIG_ENV };
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://example.com/rpc";
  process.env.HELIUS_API_KEY = "key";
  process.env.HELIUS_WEBHOOK_SECRET = secret;
  process.env.MINT_AUTHORITY_PRIVATE_KEY = "x".repeat(88);
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.CREATOR_ADDRESS = "11111111111111111111111111111113";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  _resetEnvCache();
}

describe("verifyHeliusSecret", () => {
  beforeEach(() => setEnv("super-secret-value"));

  it("returns true when the header matches the env secret", () => {
    expect(verifyHeliusSecret("super-secret-value")).toBe(true);
  });

  it("returns false on mismatch", () => {
    expect(verifyHeliusSecret("wrong")).toBe(false);
  });

  it("returns false on undefined / empty", () => {
    expect(verifyHeliusSecret(undefined)).toBe(false);
    expect(verifyHeliusSecret("")).toBe(false);
  });
});
