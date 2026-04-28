import { describe, it, expect, afterAll, beforeEach } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis, connectDb, mongoose } from "@onchainme/shared";

const app = await buildServer();
await connectDb();

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  for (const c of ["users", "txs", "placements", "badgeClaims", "badgeEligibilities", "authNonces"]) {
    await mongoose.connection.collection(c).deleteMany({});
  }
});

const W = "WaLLeTAaaaa1111111111111111111111111111111111";

async function login(): Promise<{ wallet: string; cookie: string }> {
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

describe("GET /api/v1/lands/:wallet", () => {
  it("returns 404 LAND_NOT_FOUND when the wallet has no user row", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/lands/${W}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("LAND_NOT_FOUND");
  });

  it("returns the land payload for an existing wallet", async () => {
    await mongoose.connection.collection("users").insertOne({
      _id: W as never,
      createdAt: new Date(),
      ogImageUrl: "https://example.com/og.png",
    });
    await mongoose.connection.collection("txs").insertMany([
      {
        _id: "s1" as never,
        walletAddress: W,
        blockTime: new Date("2026-01-01"),
        protocol: "jupiter",
        action: "swap",
        amountUsd: null,
        meta: {},
      },
      {
        _id: "s2" as never,
        walletAddress: W,
        blockTime: new Date("2026-02-01"),
        protocol: "magic_eden",
        action: "nft_buy",
        amountUsd: null,
        meta: { mint: "M1" },
      },
    ]);
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: W, badgeId: "first_swap" } as never,
      mintedAt: new Date(),
      mintSignature: "msig",
      assetId: "aid",
      merkleTree: "tree",
    });
    await mongoose.connection.collection("placements").insertOne({
      _id: { walletAddress: W, badgeId: "first_swap" } as never,
      tileX: 4,
      tileY: 7,
      placedAt: new Date(),
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/lands/${W}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("max-age=30");
    const body = JSON.parse(res.body) as {
      wallet: string;
      stats: { protocols: number; transactions: number; score: number };
      placements: { badgeId: string; x: number; y: number }[];
      ogImageUrl: string | null;
    };
    expect(body.wallet).toBe(W);
    expect(body.stats.transactions).toBe(2);
    expect(body.stats.protocols).toBe(2);
    expect(body.stats.score).toBe(10); // first_swap weight
    expect(body.placements).toEqual([{ badgeId: "first_swap", x: 4, y: 7 }]);
    expect(body.ogImageUrl).toBe("https://example.com/og.png");
  });
});

describe("GET /api/v1/lands (home grid)", () => {
  it("returns an empty list when no users exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/lands" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns wallets newest-first with placement count and og preview", async () => {
    const wA = "WALLetA" + "1".repeat(38);
    const wB = "WALLetB" + "2".repeat(38);
    await mongoose.connection.collection("users").insertMany([
      { _id: wA as never, createdAt: new Date("2026-01-01"), ogImageUrl: "ogA" },
      { _id: wB as never, createdAt: new Date("2026-02-01"), ogImageUrl: "ogB" },
    ]);
    await mongoose.connection.collection("placements").insertMany([
      { _id: { walletAddress: wB, badgeId: "first_swap" } as never, tileX: 0, tileY: 0, placedAt: new Date() },
      { _id: { walletAddress: wB, badgeId: "first_nft" } as never, tileX: 1, tileY: 0, placedAt: new Date() },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/v1/lands?limit=10" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      items: { wallet: string; ogImageUrl: string | null; objectsCount: number }[];
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.wallet)).toEqual([wB, wA]);
    expect(body.items[0]?.objectsCount).toBe(2);
    expect(body.items[1]?.objectsCount).toBe(0);
  });

  it("paginates via cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await mongoose.connection.collection("users").insertOne({
        _id: (`Wallet${i}` + "0".repeat(40)).slice(0, 44) as never,
        createdAt: new Date(2026, 0, i + 1),
      });
    }
    const first = await app.inject({ method: "GET", url: "/api/v1/lands?limit=2" });
    const firstBody = JSON.parse(first.body) as { items: { wallet: string }[]; nextCursor: string };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/lands?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    const secondBody = JSON.parse(second.body) as { items: { wallet: string }[] };
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.items.map((i) => i.wallet)).not.toEqual(
      firstBody.items.map((i) => i.wallet),
    );
  });
});

describe("GET /api/v1/lands/:wallet/inventory", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/lands/${W}/inventory` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for someone else's wallet", async () => {
    const { cookie } = await login();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lands/${W}/inventory`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns claimed + eligible for the owner", async () => {
    const { wallet, cookie } = await login();

    await mongoose.connection.collection("badgeEligibilities").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      evaluatedAt: new Date(),
      eligibleSince: new Date("2026-01-01"),
      meta: { count: 5, threshold: 1 },
    });
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_nft" } as never,
      mintedAt: new Date(),
      mintSignature: "msig",
      assetId: "aid",
      merkleTree: "tree",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lands/${wallet}/inventory`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      claimed: { badgeId: string; weight: number; assetId: string }[];
      eligible: { badgeId: string; weight: number; eligibleSince: string; meta: unknown }[];
    };
    expect(body.claimed).toEqual([
      { badgeId: "first_nft", weight: 10, assetId: "aid" },
    ]);
    expect(body.eligible[0]?.badgeId).toBe("first_swap");
    expect(body.eligible[0]?.weight).toBe(10);
    expect(body.eligible[0]?.meta).toMatchObject({ count: 5 });
  });

  it("excludes from eligible anything already claimed", async () => {
    const { wallet, cookie } = await login();
    await mongoose.connection.collection("badgeEligibilities").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      evaluatedAt: new Date(),
      eligibleSince: new Date("2026-01-01"),
      meta: {},
    });
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      mintedAt: new Date(),
      mintSignature: "msig",
      assetId: "aid",
      merkleTree: "tree",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/lands/${wallet}/inventory`,
      headers: { cookie },
    });
    const body = JSON.parse(res.body) as {
      claimed: unknown[];
      eligible: unknown[];
    };
    expect(body.claimed).toHaveLength(1);
    expect(body.eligible).toHaveLength(0);
  });
});
