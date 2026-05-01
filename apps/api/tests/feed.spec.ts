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
  for (const c of ["badgeClaims", "placements"]) {
    await mongoose.connection.collection(c).deleteMany({});
  }
});

const W = "WaLLeTFeeD" + "1".repeat(36);

describe("GET /api/v1/feed", () => {
  it("returns an empty list when there are no events", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/feed" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("merges mint and placement events newest-first", async () => {
    const t1 = new Date("2026-04-01T10:00:00Z");
    const t2 = new Date("2026-04-02T10:00:00Z");
    const t3 = new Date("2026-04-03T10:00:00Z");

    await mongoose.connection.collection("badgeClaims").insertMany([
      {
        _id: { walletAddress: W, badgeId: "first_swap" } as never,
        mintedAt: t1,
        mintSignature: "s",
        assetId: "asset-1",
        merkleTree: "tree",
      },
      {
        _id: { walletAddress: W, badgeId: "first_nft" } as never,
        mintedAt: t3,
        mintSignature: "s",
        assetId: "asset-2",
        merkleTree: "tree",
      },
    ]);
    await mongoose.connection.collection("placements").insertOne({
      _id: { walletAddress: W, badgeId: "first_swap" } as never,
      tileX: 5,
      tileY: 7,
      placedAt: t2,
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/feed?limit=10" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      items: { type: string; at: string; wallet: string; badgeId: string }[];
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.type)).toEqual(["mint", "placement", "mint"]);
    expect(body.items[0]?.badgeId).toBe("first_nft");
    expect(body.items[1]?.type).toBe("placement");
    expect(body.items[2]?.badgeId).toBe("first_swap");
    expect(body.nextCursor).toBeNull();
  });

  it("paginates via cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await mongoose.connection.collection("badgeClaims").insertOne({
        _id: { walletAddress: W, badgeId: `b${i}` } as never,
        mintedAt: new Date(2026, 3, i + 1),
        mintSignature: `s${i}`,
        assetId: `a${i}`,
        merkleTree: "tree",
      });
    }

    const first = await app.inject({ method: "GET", url: "/api/v1/feed?limit=2" });
    const firstBody = JSON.parse(first.body) as {
      items: { badgeId: string }[];
      nextCursor: string;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/feed?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    const secondBody = JSON.parse(second.body) as { items: { badgeId: string }[] };
    expect(secondBody.items).toHaveLength(2);
    const firstIds = firstBody.items.map((i) => i.badgeId);
    const secondIds = secondBody.items.map((i) => i.badgeId);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });
});
