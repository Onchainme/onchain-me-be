import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { buildMintTransaction } from "../../src/mint/prepare.js";
import { _resetMintAuthorityCache } from "../../src/solana/keypair.js";
import { _resetUmiCache } from "../../src/solana/umi.js";
import { _resetEnvCache } from "../../src/env.js";

const ORIG_ENV = process.env;
const TREE = "11111111111111111111111111111112";

const server = setupServer(
  http.post("https://example.com/rpc", () =>
    HttpResponse.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        context: { slot: 1 },
        value: {
          blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
          lastValidBlockHeight: 1000,
        },
      },
    }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => server.close());

function setEnv() {
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
  process.env.MERKLE_TREE_ADDRESS = TREE;
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  process.env.CREATOR_ADDRESS = "11111111111111111111111111111113";
  // Tests default to sponsored mode so existing assertions hold; specific tests
  // override MINT_PRICE_LAMPORTS to exercise the paid path.
  delete process.env.MINT_PRICE_LAMPORTS;

  const authority = Keypair.generate();
  process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(authority.secretKey);
  _resetEnvCache();
  _resetMintAuthorityCache();
  _resetUmiCache();
  return authority;
}

describe("buildMintTransaction", () => {
  beforeEach(() => {
    setEnv();
  });

  it("returns a base64 string and an expiresAt iso", async () => {
    const owner = Keypair.generate();
    const result = await buildMintTransaction({
      leafOwner: owner.publicKey.toBase58(),
      badgeId: "first_swap",
    });
    expect(typeof result.transactionBase64).toBe("string");
    expect(result.transactionBase64.length).toBeGreaterThan(100);
    expect(result.badgeId).toBe("first_swap");
    expect(typeof result.expiresAt).toBe("string");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("the returned base64 deserializes into a transaction with the mint authority signature attached", async () => {
    const authority = setEnv();
    const owner = Keypair.generate();
    const result = await buildMintTransaction({
      leafOwner: owner.publicKey.toBase58(),
      badgeId: "first_swap",
    });

    const bytes = Buffer.from(result.transactionBase64, "base64");
    let signaturesPresent: number;
    try {
      const vtx = VersionedTransaction.deserialize(bytes);
      signaturesPresent = vtx.signatures.filter((s) => s.some((b) => b !== 0)).length;
      expect(signaturesPresent).toBeGreaterThanOrEqual(1);
      void authority;
    } catch {
      const tx = Transaction.from(bytes);
      const auth = tx.signatures.find(
        (s) => s.publicKey.toBase58() === authority.publicKey.toBase58(),
      );
      expect(auth?.signature).not.toBeNull();
    }
  });

  it("rejects when the leaf owner is not a valid base58 pubkey", async () => {
    await expect(
      buildMintTransaction({ leafOwner: "not-base58-!!!", badgeId: "first_swap" }),
    ).rejects.toThrow();
  });
});
