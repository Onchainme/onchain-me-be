import { describe, it, expect, afterAll, beforeEach } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildServer } from "../src/server.js";
import { closeDb, connectDb, mongoose, closeRedis } from "@onchainme/shared";

const app = await buildServer();
await connectDb();

beforeEach(async () => {
  await mongoose.connection.collection("authNonces").deleteMany({});
  await mongoose.connection.collection("users").deleteMany({});
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

function makeWallet(): { wallet: string; secret: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { wallet: bs58.encode(kp.publicKey), secret: kp.secretKey };
}

describe("POST /api/v1/auth/nonce", () => {
  it("returns a nonce + message for a valid wallet", async () => {
    const { wallet } = makeWallet();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/nonce",
      payload: { wallet },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { nonce: string; message: string };
    expect(typeof body.nonce).toBe("string");
    expect(body.nonce.length).toBeGreaterThanOrEqual(32);
    expect(body.message).toContain(wallet);
    expect(body.message).toContain(`Nonce: ${body.nonce}`);

    const persisted = await mongoose.connection.collection("authNonces").findOne({ _id: body.nonce });
    expect(persisted).toBeTruthy();
    expect(persisted?.["walletAddress"]).toBe(wallet);
  });

  it("rejects an invalid wallet format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/nonce",
      payload: { wallet: "not-base58-!!!" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/auth/verify", () => {
  it("verifies a valid signature, sets a cookie, upserts a user", async () => {
    const { wallet, secret } = makeWallet();
    const nonceRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/nonce",
      payload: { wallet },
    });
    const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
    const sig = nacl.sign.detached(new TextEncoder().encode(message), secret);

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { wallet, nonce, signature: bs58.encode(sig) },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.cookies.find((c) => c.name === "om_session")).toBeTruthy();

    const user = await mongoose.connection.collection("users").findOne({ _id: wallet });
    expect(user).toBeTruthy();

    const consumed = await mongoose.connection.collection("authNonces").findOne({ _id: nonce });
    expect(consumed?.["consumedAt"]).toBeTruthy();
  });

  it("rejects a reused nonce", async () => {
    const { wallet, secret } = makeWallet();
    const nonceRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/nonce",
      payload: { wallet },
    });
    const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secret));

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { wallet, nonce, signature: sig },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { wallet, nonce, signature: sig },
    });
    expect(second.statusCode).toBe(401);
    expect(JSON.parse(second.body).error.code).toBe("AUTH_NONCE_CONSUMED");
  });

  it("rejects a signature from a different wallet", async () => {
    const a = makeWallet();
    const b = makeWallet();
    const nonceRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/nonce",
      payload: { wallet: a.wallet },
    });
    const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), b.secret));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { wallet: a.wallet, nonce, signature: sig },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("AUTH_SIGNATURE_INVALID");
  });
});

describe("GET /api/v1/auth/me", () => {
  it("returns 401 without a cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the wallet with a valid cookie", async () => {
    const { wallet, secret } = makeWallet();
    const nonceRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/nonce",
      payload: { wallet },
    });
    const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secret));
    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { wallet, nonce, signature: sig },
    });
    const cookie = verifyRes.cookies.find((c) => c.name === "om_session");
    expect(cookie).toBeTruthy();

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `om_session=${cookie?.value}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(JSON.parse(meRes.body).wallet).toBe(wallet);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("clears the cookie", async () => {
    const { wallet, secret } = makeWallet();
    const nonceRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/nonce",
      payload: { wallet },
    });
    const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secret));
    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { wallet, nonce, signature: sig },
    });
    const cookie = verifyRes.cookies.find((c) => c.name === "om_session");

    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: `om_session=${cookie?.value}` },
    });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === "om_session");
    expect(cleared?.value).toBe("");
  });
});
