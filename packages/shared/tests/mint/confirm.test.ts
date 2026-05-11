import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  fetchTransactionStatus,
  type ConfirmedTxStatus,
} from "../../src/mint/confirm.js";
import { _resetEnvCache } from "../../src/env.js";
import { _resetMintAuthorityCache } from "../../src/solana/keypair.js";
import { _resetConnectionCache } from "../../src/solana/connection.js";

const ORIG_ENV = process.env;

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
  process.env.SOLANA_RPC_URL = "https://rpc.test";
  process.env.HELIUS_API_KEY = "key";
  process.env.HELIUS_WEBHOOK_SECRET = "sec";
  process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.CREATOR_ADDRESS = "11111111111111111111111111111113";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  _resetEnvCache();
  _resetMintAuthorityCache();
  _resetConnectionCache();
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  server.resetHandlers();
  setEnv();
});

describe("fetchTransactionStatus", () => {
  it("returns status='success' with a parsed assetId on a successful tx", async () => {
    server.use(
      http.post("https://rpc.test/", async () => {
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sig1"] },
            meta: {
              err: null,
              logMessages: [
                "Program BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY invoke [1]",
                "Program log: AssetId: ABC1111111111111111111111111111111111111111",
                "Program BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY success",
              ],
            },
          },
        });
      }),
    );

    const result = await fetchTransactionStatus("sig1");
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.assetId).toBe("ABC1111111111111111111111111111111111111111");
    }
  });

  it("returns status='failed' with err when meta.err is set", async () => {
    server.use(
      http.post("https://rpc.test/", () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sig2"] },
            meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [] },
          },
        }),
      ),
    );

    const r: ConfirmedTxStatus = await fetchTransactionStatus("sig2");
    expect(r.status).toBe("failed");
  });

  it("returns status='not_found' when the tx is not yet on chain", async () => {
    server.use(
      http.post("https://rpc.test/", () =>
        HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null }),
      ),
    );

    const r = await fetchTransactionStatus("sigX");
    expect(r.status).toBe("not_found");
  });

  it("returns status='success' but assetId=null when logs lack the AssetId line", async () => {
    server.use(
      http.post("https://rpc.test/", () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sig3"] },
            meta: { err: null, logMessages: ["Program log: not the right log"] },
          },
        }),
      ),
    );

    const r = await fetchTransactionStatus("sig3");
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.assetId).toBeNull();
    }
  });
});
