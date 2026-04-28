import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadMintAuthority, mintAuthorityPublicKey, _resetMintAuthorityCache } from "../../src/solana/keypair.js";

const ORIG_ENV = process.env;

function setBaseEnv(extras: Record<string, string> = {}) {
  process.env = { ...ORIG_ENV };
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test";
  process.env.HELIUS_API_KEY = "test-key";
  process.env.HELIUS_WEBHOOK_SECRET = "secret";
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  Object.assign(process.env, extras);
}

describe("loadMintAuthority", () => {
  beforeEach(() => {
    setBaseEnv();
    _resetMintAuthorityCache();
  });

  it("decodes a base58 secret key into a Solana Keypair", () => {
    const real = Keypair.generate();
    process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(real.secretKey);

    const loaded = loadMintAuthority();
    expect(loaded.publicKey.toBase58()).toBe(real.publicKey.toBase58());
  });

  it("throws when MINT_AUTHORITY_PRIVATE_KEY is absent", () => {
    delete process.env.MINT_AUTHORITY_PRIVATE_KEY;
    expect(() => loadMintAuthority()).toThrow(/MINT_AUTHORITY_PRIVATE_KEY is not set/);
  });

  it("throws when the secret key is malformed base58", () => {
    process.env.MINT_AUTHORITY_PRIVATE_KEY = "not-base58-!!!";
    expect(() => loadMintAuthority()).toThrow(/not valid base58/);
  });

  it("throws when the decoded key is the wrong length", () => {
    process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(new Uint8Array(32));
    expect(() => loadMintAuthority()).toThrow(/must decode to 64 bytes/);
  });
});

describe("mintAuthorityPublicKey", () => {
  beforeEach(() => {
    setBaseEnv();
    _resetMintAuthorityCache();
  });

  it("returns the same public key as Keypair.publicKey", () => {
    const real = Keypair.generate();
    process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(real.secretKey);
    expect(mintAuthorityPublicKey().toBase58()).toBe(real.publicKey.toBase58());
  });
});
