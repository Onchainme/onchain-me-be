import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv } from "../src/env.js";

const ORIGINAL_ENV = process.env;

describe("loadEnv", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("parses a complete valid env", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "3001";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "helius_key";
    process.env.HELIUS_WEBHOOK_SECRET = "secret";
    process.env.SOLANA_CLUSTER = "devnet";
    process.env.SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test";
    process.env.MINT_AUTHORITY_PRIVATE_KEY = "placeholder-value";
    process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
    process.env.METADATA_BASE_URL = "https://example.com/metadata";
    process.env.CREATOR_ADDRESS = "11111111111111111111111111111112";

    const env = loadEnv({ reload: true });

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3001);
    expect(env.MONGODB_URI).toBe("mongodb://localhost:27018/onchainme?replicaSet=rs0");
  });

  it("coerces PORT from string to number", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "4000";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "k";
    process.env.HELIUS_WEBHOOK_SECRET = "s";
    process.env.SOLANA_CLUSTER = "devnet";
    process.env.SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test";
    process.env.MINT_AUTHORITY_PRIVATE_KEY = "placeholder-value";
    process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
    process.env.METADATA_BASE_URL = "https://example.com/metadata";
    process.env.CREATOR_ADDRESS = "11111111111111111111111111111112";

    const env = loadEnv({ reload: true });

    expect(env.PORT).toBe(4000);
    expect(typeof env.PORT).toBe("number");
  });

  it("rejects when JWT_SECRET is too short", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "3001";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "tooshort";
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "k";
    process.env.HELIUS_WEBHOOK_SECRET = "s";
    process.env.SOLANA_CLUSTER = "devnet";
    process.env.SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test";
    process.env.MINT_AUTHORITY_PRIVATE_KEY = "placeholder-value";
    process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
    process.env.METADATA_BASE_URL = "https://example.com/metadata";
    process.env.CREATOR_ADDRESS = "11111111111111111111111111111112";

    expect(() => loadEnv({ reload: true })).toThrow(/JWT_SECRET/);
  });

  it("rejects invalid SOLANA_CLUSTER", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "3001";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "k";
    process.env.HELIUS_WEBHOOK_SECRET = "s";
    process.env.SOLANA_CLUSTER = "wrong-cluster";
    process.env.SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test";
    process.env.MINT_AUTHORITY_PRIVATE_KEY = "placeholder-value";
    process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
    process.env.METADATA_BASE_URL = "https://example.com/metadata";
    process.env.CREATOR_ADDRESS = "11111111111111111111111111111112";

    expect(() => loadEnv({ reload: true })).toThrow(/SOLANA_CLUSTER/);
  });
});
