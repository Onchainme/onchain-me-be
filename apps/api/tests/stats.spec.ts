import { describe, it, expect, afterAll, beforeEach } from "vitest";
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
  for (const c of ["users", "badgeClaims", "placements"]) {
    await mongoose.connection.collection(c).deleteMany({});
  }
});

describe("GET /api/v1/stats", () => {
  it("returns zero counters on an empty db", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, number>;
    expect(body.totalMinted).toBe(0);
    expect(body.mintedToday).toBe(0);
    expect(body.totalUsers).toBe(0);
    expect(body.totalPlacements).toBe(0);
  });

  it("counts total mints, today's mints, users and placements", async () => {
    const W = "WaLLeT" + "1".repeat(40);
    const W2 = "WaLLeT" + "2".repeat(40);
    const todayUtc = new Date();
    todayUtc.setUTCHours(12, 0, 0, 0);
    const yesterday = new Date(todayUtc.getTime() - 25 * 60 * 60 * 1000);

    await mongoose.connection.collection("users").insertMany([
      { _id: W as never, createdAt: new Date(), score: 0 },
      { _id: W2 as never, createdAt: new Date(), score: 0 },
    ]);
    await mongoose.connection.collection("badgeClaims").insertMany([
      {
        _id: { walletAddress: W, badgeId: "first_swap" } as never,
        mintedAt: yesterday,
        mintSignature: "s1",
        assetId: "a1",
        merkleTree: "t",
      },
      {
        _id: { walletAddress: W, badgeId: "first_nft" } as never,
        mintedAt: todayUtc,
        mintSignature: "s2",
        assetId: "a2",
        merkleTree: "t",
      },
      {
        _id: { walletAddress: W2, badgeId: "first_swap" } as never,
        mintedAt: todayUtc,
        mintSignature: "s3",
        assetId: "a3",
        merkleTree: "t",
      },
    ]);
    await mongoose.connection.collection("placements").insertMany([
      { _id: { walletAddress: W, badgeId: "first_swap" } as never, tileX: 0, tileY: 0, placedAt: new Date() },
      { _id: { walletAddress: W, badgeId: "first_nft" } as never, tileX: 1, tileY: 0, placedAt: new Date() },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, number>;
    expect(body.totalMinted).toBe(3);
    expect(body.mintedToday).toBe(2);
    expect(body.totalUsers).toBe(2);
    expect(body.totalPlacements).toBe(2);
  });

  it("sets a 30s Cache-Control", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.headers["cache-control"]).toContain("max-age=30");
  });
});
