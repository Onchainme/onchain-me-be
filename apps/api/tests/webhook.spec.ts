import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis, connectDb, mongoose } from "@onchainme/shared";

const SECRET = process.env["HELIUS_WEBHOOK_SECRET"] ?? "test-secret";
const TREE = process.env["MERKLE_TREE_ADDRESS"] ?? "11111111111111111111111111111112";

const app = await buildServer();
await connectDb();

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  for (const c of ["badgeClaims", "heliusWebhookEvents", "badgeEligibilities"]) {
    await mongoose.connection.collection(c).deleteMany({});
  }
});

describe("POST /api/v1/webhooks/helius", () => {
  it("returns 401 when the Authorization header is missing or wrong", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      payload: [],
    });
    expect(res.statusCode).toBe(401);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: "wrong" },
      payload: [],
    });
    expect(res2.statusCode).toBe(401);
  });

  it("returns 200 and writes an event row for a valid signed payload", async () => {
    const wallet = "WaLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";
    const event = {
      signature: "sigW1",
      type: "COMPRESSED_NFT_MINT",
      events: {
        compressed: [
          { assetId: "ASSET11111111111111111111111111111111111111", treeId: TREE, newLeafOwner: wallet, badgeId: "first_swap" },
        ],
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(res.statusCode).toBe(200);

    const row = await mongoose.connection
      .collection("heliusWebhookEvents")
      .findOne({ _id: "sigW1" as never });
    expect(row).toBeTruthy();

    const claim = await mongoose.connection
      .collection("badgeClaims")
      .findOne({ "_id.walletAddress": wallet, "_id.badgeId": "first_swap" });
    expect(claim?.["mintSignature"]).toBe("sigW1");
    expect(claim?.["assetId"]).toBe("ASSET11111111111111111111111111111111111111");
  });

  it("is idempotent — replaying the same signature does NOT create duplicate rows or claims", async () => {
    const wallet = "WaLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";
    const event = {
      signature: "sigDup",
      type: "COMPRESSED_NFT_MINT",
      events: {
        compressed: [
          { assetId: "AID_DUP1111111111111111111111111111111111111", treeId: TREE, newLeafOwner: wallet, badgeId: "first_nft" },
        ],
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(second.statusCode).toBe(200);

    const eventCount = await mongoose.connection
      .collection("heliusWebhookEvents")
      .countDocuments({ _id: "sigDup" as never });
    expect(eventCount).toBe(1);

    const claimCount = await mongoose.connection
      .collection("badgeClaims")
      .countDocuments({ "_id.walletAddress": wallet, "_id.badgeId": "first_nft" });
    expect(claimCount).toBe(1);
  });

  it("ignores events for a different tree", async () => {
    const event = {
      signature: "sigOther",
      type: "COMPRESSED_NFT_MINT",
      events: {
        compressed: [
          { assetId: "AID", treeId: "OtherTree1111111111111111111111111111111111", newLeafOwner: "W", badgeId: "first_swap" },
        ],
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(res.statusCode).toBe(200);
    const claimCount = await mongoose.connection.collection("badgeClaims").countDocuments({});
    expect(claimCount).toBe(0);
    const eventRow = await mongoose.connection
      .collection("heliusWebhookEvents")
      .findOne({ _id: "sigOther" as never });
    expect(eventRow).toBeTruthy();
  });
});
