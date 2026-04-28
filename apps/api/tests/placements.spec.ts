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
  for (const c of ["users", "authNonces", "badgeClaims", "placements"]) {
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

async function giveClaim(wallet: string, badgeId: string) {
  await mongoose.connection.collection("badgeClaims").insertOne({
    _id: { walletAddress: wallet, badgeId } as never,
    mintedAt: new Date(),
    mintSignature: "msig",
    assetId: `aid_${badgeId}`,
    merkleTree: "tree",
  });
}

describe("PUT /api/v1/placements/:wallet", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/placements/${"X".repeat(43)}`,
      payload: { placements: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a different wallet", async () => {
    const { cookie } = await loggedInWallet();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/placements/${"Y".repeat(43)}`,
      headers: { cookie },
      payload: { placements: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 422 PLACEMENT_FOR_UNCLAIMED if requested badge has no claim", async () => {
    const { wallet, cookie } = await loggedInWallet();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/placements/${wallet}`,
      headers: { cookie },
      payload: { placements: [{ badgeId: "first_swap", x: 0, y: 0 }] },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("PLACEMENT_FOR_UNCLAIMED");
  });

  it("replaces placements atomically (delete + insert) when all badges are claimed", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await giveClaim(wallet, "first_swap");
    await giveClaim(wallet, "first_nft");

    // pre-existing placement that should be wiped by the replace
    await mongoose.connection.collection("placements").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      tileX: 9,
      tileY: 9,
      placedAt: new Date(),
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/placements/${wallet}`,
      headers: { cookie },
      payload: {
        placements: [
          { badgeId: "first_swap", x: 0, y: 0 },
          { badgeId: "first_nft", x: 1, y: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const after = await mongoose.connection
      .collection("placements")
      .find({ "_id.walletAddress": wallet })
      .toArray();
    expect(after).toHaveLength(2);
    const keyed = new Map(
      after.map((p) => [(p._id as { badgeId: string }).badgeId, { x: p["tileX"], y: p["tileY"] }]),
    );
    expect(keyed.get("first_swap")).toEqual({ x: 0, y: 0 });
    expect(keyed.get("first_nft")).toEqual({ x: 1, y: 1 });
  });

  it("returns 422 INVALID_TILE_COORDINATE on duplicate tile in payload", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await giveClaim(wallet, "first_swap");
    await giveClaim(wallet, "first_nft");
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/placements/${wallet}`,
      headers: { cookie },
      payload: {
        placements: [
          { badgeId: "first_swap", x: 0, y: 0 },
          { badgeId: "first_nft", x: 0, y: 0 },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_TILE_COORDINATE");
  });

  it("returns 422 INVALID_TILE_COORDINATE on out-of-range coords", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await giveClaim(wallet, "first_swap");
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/placements/${wallet}`,
      headers: { cookie },
      payload: {
        placements: [{ badgeId: "first_swap", x: -1, y: 0 }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_TILE_COORDINATE");
  });

  it("preserves prior placements when a write fails mid-transaction (rollback)", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await giveClaim(wallet, "first_swap");
    await giveClaim(wallet, "first_nft");

    await mongoose.connection.collection("placements").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      tileX: 5,
      tileY: 5,
      placedAt: new Date(),
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/placements/${wallet}`,
      headers: { cookie },
      payload: {
        placements: [{ badgeId: "first_nft", x: 2, y: 2 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const after = await mongoose.connection
      .collection("placements")
      .find({ "_id.walletAddress": wallet })
      .toArray();
    expect(after).toHaveLength(1);
    expect((after[0]?._id as { badgeId: string }).badgeId).toBe("first_nft");
    expect(after[0]?.["tileX"]).toBe(2);
    expect(after[0]?.["tileY"]).toBe(2);
  });
});

describe("DELETE /api/v1/placements/:wallet/:badgeId", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/placements/${"X".repeat(43)}/first_swap`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when nothing to delete", async () => {
    const { wallet, cookie } = await loggedInWallet();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/placements/${wallet}/first_swap`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("removes a single placement", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await giveClaim(wallet, "first_swap");
    await mongoose.connection.collection("placements").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      tileX: 0,
      tileY: 0,
      placedAt: new Date(),
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/placements/${wallet}/first_swap`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);

    const remaining = await mongoose.connection
      .collection("placements")
      .find({ "_id.walletAddress": wallet })
      .toArray();
    expect(remaining).toHaveLength(0);
  });
});
