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
    expect(buildMetadataUri("first_swap")).toBe("https://onchainme.xyz/metadata/first_swap.json");
  });

  it("strips a trailing slash on the base url", () => {
    setEnv("https://onchainme.xyz/metadata/");
    expect(buildMetadataUri("nft_collector")).toBe(
      "https://onchainme.xyz/metadata/nft_collector.json",
    );
  });
});

describe("buildMetadataArgs", () => {
  beforeEach(() => {
    setEnv("https://onchainme.xyz/metadata");
  });

  it("produces a MetadataArgs-compatible shape with uri, name, symbol, sellerFeeBasisPoints", () => {
    const m = buildMetadataArgs("first_swap");
    expect(m.uri).toBe("https://onchainme.xyz/metadata/first_swap.json");
    expect(m.name).toBe("OnchainMe — first_swap");
    expect(m.symbol).toBe("OCM");
    expect(m.sellerFeeBasisPoints).toBe(0);
    expect(m.creators).toEqual([]);
    expect(m.isMutable).toBe(false);
  });
});
