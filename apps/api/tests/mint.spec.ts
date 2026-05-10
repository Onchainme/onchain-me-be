import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { buildServer } from "../src/server.js";
import {
  closeDb,
  closeRedis,
  connectDb,
  mongoose,
  clearMintDegraded,
  setMintDegraded,
} from "@onchainme/shared";

const TREE = "11111111111111111111111111111112";

beforeAll(() => {
  // Ensure the env has all the mint-related vars before buildServer reads loadEnv.
  // The env loader caches; tests rely on setup.ts or .env.local providing these.
  // If your local .env.local is missing them, the api will fail to start.
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));

const app = await buildServer();
await connectDb();

afterAll(async () => {
  server.close();
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  server.resetHandlers();
  await clearMintDegraded();
  for (const c of ["users", "authNonces", "badgeClaims", "badgeEligibilities", "heliusWebhookEvents"]) {
    await mongoose.connection.collection(c).deleteMany({});
  }
});

async function loggedInWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const nonceRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/nonce",
    payload: { wallet },
  });
  const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  const verifyRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    payload: { wallet, nonce, signature: sig },
  });
  const cookie = verifyRes.cookies.find((c) => c.name === "om_session");
  return { wallet, cookie: `om_session=${cookie?.value}` };
}

async function makeEligible(wallet: string, badgeId: string) {
  await mongoose.connection.collection("badgeEligibilities").insertOne({
    _id: { walletAddress: wallet, badgeId } as never,
    evaluatedAt: new Date(),
    eligibleSince: new Date("2026-01-01"),
    meta: {},
  });
}

describe("POST /api/v1/mint/single", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      payload: { badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 422 BADGE_NOT_ELIGIBLE if no eligibility row exists", async () => {
    const { cookie } = await loggedInWallet();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("BADGE_NOT_ELIGIBLE");
  });

  it("returns 409 BADGE_ALREADY_CLAIMED if a claim row exists", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "jupiter_volume_bronze");
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "jupiter_volume_bronze" } as never,
      mintedAt: new Date(),
      mintSignature: "old",
      assetId: "old_aid",
      merkleTree: TREE,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("BADGE_ALREADY_CLAIMED");
  });

  it("returns 503 MINT_AUTHORITY_OUT_OF_FUNDS when degraded flag is set", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "jupiter_volume_bronze");
    await setMintDegraded("test forced", 60);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("MINT_AUTHORITY_OUT_OF_FUNDS");
  });

  it("returns a base64 transaction when eligible and not claimed", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "jupiter_volume_bronze");

    // Mock the Solana RPC blockhash call that buildMintTransaction triggers.
    server.use(
      http.post(/.*/, async ({ request }) => {
        const body = (await request.json()) as { method: string };
        if (body.method === "getLatestBlockhash") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 1 },
              value: {
                blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
                lastValidBlockHeight: 1000,
              },
            },
          });
        }
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null });
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      transaction: string;
      badgeId: string;
      expiresAt: string;
    };
    expect(body.badgeId).toBe("jupiter_volume_bronze");
    expect(body.transaction.length).toBeGreaterThan(100);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("POST /api/v1/mint/confirm", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      payload: { signature: "sigX", badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("writes a claim and returns alreadyClaimed=false on a successful tx", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "jupiter_volume_bronze");

    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sigOK"] },
            meta: {
              err: null,
              logMessages: ["Program log: AssetId: ABC1111111111111111111111111111111111111111"],
            },
          },
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigOK", badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      badgeId: string;
      mintSignature: string;
      assetId: string;
      alreadyClaimed: boolean;
    };
    expect(body.alreadyClaimed).toBe(false);
    expect(body.assetId).toBe("ABC1111111111111111111111111111111111111111");

    const row = await mongoose.connection
      .collection("badgeClaims")
      .findOne({ "_id.walletAddress": wallet, "_id.badgeId": "jupiter_volume_bronze" });
    expect(row?.["mintSignature"]).toBe("sigOK");

    // The denormalized User.score should have been bumped by jupiter_volume_bronze.weight (100).
    const userRow = await mongoose.connection
      .collection("users")
      .findOne({ _id: wallet as never });
    expect(userRow?.["score"]).toBe(100);
  });

  it("is idempotent — second call returns alreadyClaimed=true and does not overwrite", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "jupiter_volume_bronze");
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "jupiter_volume_bronze" } as never,
      mintedAt: new Date("2026-01-01"),
      mintSignature: "sigOriginal",
      assetId: "AID_ORIG",
      merkleTree: TREE,
    });

    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sigSecond"] },
            meta: {
              err: null,
              logMessages: ["Program log: AssetId: NEWASSET11111111111111111111111111111111111"],
            },
          },
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigSecond", badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { alreadyClaimed: boolean; assetId: string };
    expect(body.alreadyClaimed).toBe(true);
    expect(body.assetId).toBe("AID_ORIG");
  });

  it("returns 422 TX_FAILED when meta.err is set", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "jupiter_volume_bronze");

    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sigFail"] },
            meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [] },
          },
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigFail", badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("TX_FAILED");
    void wallet;
  });

  it("returns 422 TX_NOT_FOUND when the tx is not on chain", async () => {
    const { cookie } = await loggedInWallet();
    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null }),
      ),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigGhost", badgeId: "jupiter_volume_bronze" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("TX_NOT_FOUND");
  });
});

describe("POST /api/v1/mint/all", () => {
  it("returns one transaction per eligible-but-unclaimed badge", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "jupiter_volume_bronze");
    await makeEligible(wallet, "first_nft");
    // Already claimed — should not appear in the response
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "jupiter_volume_bronze" } as never,
      mintedAt: new Date(),
      mintSignature: "old",
      assetId: "old_aid",
      merkleTree: TREE,
    });

    server.use(
      http.post(/.*/, async ({ request }) => {
        const body = (await request.json()) as { method: string };
        if (body.method === "getLatestBlockhash") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 1 },
              value: {
                blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
                lastValidBlockHeight: 1000,
              },
            },
          });
        }
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null });
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/all",
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      transactions: { badgeId: string; transaction: string }[];
    };
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0]?.badgeId).toBe("first_nft");
  });
});
