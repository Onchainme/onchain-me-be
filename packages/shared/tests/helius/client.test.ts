import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { fetchEnhancedTransactions, fetchAllTransactionsCappedAt } from "../../src/helius/client.js";
import { loadEnv } from "../../src/env.js";

const ORIG_ENV = process.env;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  server.resetHandlers();
  process.env = { ...ORIG_ENV };
  process.env.HELIUS_API_KEY = "test-key";
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.HELIUS_WEBHOOK_SECRET = "x";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test";
  process.env.MINT_AUTHORITY_PRIVATE_KEY = "placeholder-value";
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  // Bust the loadEnv cache so client picks up fresh test env vars
  loadEnv({ reload: true });
});

const fakeTx = {
  signature: "sig1",
  slot: 1,
  timestamp: 1700000000,
  type: "SWAP",
  source: "JUPITER",
};

describe("fetchEnhancedTransactions", () => {
  it("returns the parsed array on 200", async () => {
    server.use(
      http.get("https://api.helius.xyz/v0/addresses/:w/transactions", () => HttpResponse.json([fakeTx])),
    );
    const txs = await fetchEnhancedTransactions({ wallet: "ABC" });
    expect(txs).toHaveLength(1);
    expect(txs[0]?.signature).toBe("sig1");
  });

  it("retries on transient failure and eventually succeeds", async () => {
    let n = 0;
    server.use(
      http.get("https://api.helius.xyz/v0/addresses/:w/transactions", () => {
        n++;
        if (n < 3) return new HttpResponse(null, { status: 502 });
        return HttpResponse.json([fakeTx]);
      }),
    );
    const txs = await fetchEnhancedTransactions({ wallet: "ABC" });
    expect(txs).toHaveLength(1);
    expect(n).toBe(3);
  }, 15_000);

  it("throws AppError on 429", async () => {
    server.use(
      http.get("https://api.helius.xyz/v0/addresses/:w/transactions", () => new HttpResponse(null, { status: 429 })),
    );
    await expect(fetchEnhancedTransactions({ wallet: "ABC" })).rejects.toMatchObject({
      code: "HELIUS_UNAVAILABLE",
    });
  }, 15_000);
});

describe("fetchAllTransactionsCappedAt", () => {
  it("paginates by `before`", async () => {
    let call = 0;
    server.use(
      http.get("https://api.helius.xyz/v0/addresses/:w/transactions", () => {
        call++;
        if (call === 1) {
          return HttpResponse.json(
            Array.from({ length: 100 }, (_, i) => ({ ...fakeTx, signature: `s_p1_${i}` })),
          );
        }
        return HttpResponse.json([{ ...fakeTx, signature: "s_p2_last" }]);
      }),
    );
    const all = await fetchAllTransactionsCappedAt("ABC", 200);
    expect(all.length).toBe(101);
  });

  it("stops at the cap", async () => {
    server.use(
      http.get("https://api.helius.xyz/v0/addresses/:w/transactions", () =>
        HttpResponse.json(Array.from({ length: 100 }, (_, i) => ({ ...fakeTx, signature: `s${i}` }))),
      ),
    );
    const all = await fetchAllTransactionsCappedAt("ABC", 50);
    expect(all.length).toBeLessThanOrEqual(100);
  });
});
