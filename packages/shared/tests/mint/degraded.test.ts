import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { isMintDegraded, setMintDegraded, clearMintDegraded } from "../../src/mint/degraded.js";
import { closeRedis, getRedisConnection } from "../../src/queue/connection.js";
import { _resetEnvCache } from "../../src/env.js";

const ORIG_ENV = process.env;

function setEnv() {
  process.env = { ...ORIG_ENV };
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://rpc.test";
  process.env.HELIUS_API_KEY = "key";
  process.env.HELIUS_WEBHOOK_SECRET = "sec";
  process.env.MINT_AUTHORITY_PRIVATE_KEY = "x".repeat(44);
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  _resetEnvCache();
}

beforeEach(async () => {
  setEnv();
  await getRedisConnection().del("onchainme:mint_disabled");
});

afterAll(async () => {
  await closeRedis();
});

describe("mint-degraded flag", () => {
  it("isMintDegraded returns false by default", async () => {
    expect(await isMintDegraded()).toBe(false);
  });

  it("setMintDegraded then isMintDegraded returns true", async () => {
    await setMintDegraded("balance below 0.1 SOL", 60);
    expect(await isMintDegraded()).toBe(true);
  });

  it("clearMintDegraded turns it back off", async () => {
    await setMintDegraded("test", 60);
    expect(await isMintDegraded()).toBe(true);
    await clearMintDegraded();
    expect(await isMintDegraded()).toBe(false);
  });

  it("expires after the TTL", async () => {
    await setMintDegraded("ttl test", 1);
    expect(await isMintDegraded()).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await isMintDegraded()).toBe(false);
  });
});
