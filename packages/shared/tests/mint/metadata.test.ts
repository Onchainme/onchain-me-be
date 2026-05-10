import { describe, it, expect, beforeEach } from "vitest";
import { buildMetadataUri, buildMetadataArgs } from "../../src/mint/metadata.js";
import { _resetEnvCache } from "../../src/env.js";

const ORIG_ENV = process.env;

function setEnv(base: string) {
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
  process.env.HELIUS_WEBHOOK_SECRET = "sec";
  process.env.MINT_AUTHORITY_PRIVATE_KEY = "x".repeat(88);
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = base;
  _resetEnvCache();
}

describe("buildMetadataUri", () => {
  it("appends /<badgeId>.json to the base url", () => {
    setEnv("https://onchainme.xyz/metadata");
    expect(buildMetadataUri("jupiter_volume_bronze")).toBe(
      "https://onchainme.xyz/metadata/jupiter_volume_bronze.json",
    );
  });

  it("strips a trailing slash on the base url", () => {
    setEnv("https://onchainme.xyz/metadata/");
    expect(buildMetadataUri("seeker_genesis")).toBe(
      "https://onchainme.xyz/metadata/seeker_genesis.json",
    );
  });
});

describe("buildMetadataArgs", () => {
  beforeEach(() => {
    setEnv("https://onchainme.xyz/metadata");
  });

  it("uses the registry display name for `name` (≤ 32 bytes, Metaplex limit)", () => {
    // v2: on-chain name is the registry's short display name, not the
    // legacy "OnchainMe — <badgeId>" format (which overflowed 32 bytes
    // for new ids like meteora_position_original).
    const m = buildMetadataArgs("jupiter_volume_bronze");
    expect(m.name).toBe("Jupiter $1k");
    expect(m.name.length).toBeLessThanOrEqual(32);
    expect(m.symbol).toBe("OCM");
    expect(m.uri).toBe("https://onchainme.xyz/metadata/jupiter_volume_bronze.json");
    expect(m.sellerFeeBasisPoints).toBe(0);
    expect(m.creators).toEqual([]);
    expect(m.isMutable).toBe(false);
  });

  it("falls back to the raw badgeId when the registry has no entry", () => {
    // Forward-compat: e.g. legacy cNFT replay or future ids we haven't shipped yet.
    const m = buildMetadataArgs("legacy_or_future_badge");
    expect(m.name).toBe("legacy_or_future_badge");
  });
});
