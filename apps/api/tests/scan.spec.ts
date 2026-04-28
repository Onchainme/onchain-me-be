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
  await mongoose.connection.collection("users").deleteMany({});
  await mongoose.connection.collection("authNonces").deleteMany({});
  await mongoose.connection.collection("scanJobs").deleteMany({});
});

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

describe("POST /api/v1/scan/:wallet", () => {
  it("returns 401 without auth", async () => {
    // Use a real-shaped wallet (32-byte base58) so Zod param validation passes
    const realWallet = bs58.encode(nacl.sign.keyPair().publicKey);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/scan/${realWallet}?mode=full`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when wallet param differs from token wallet", async () => {
    const { cookie } = await login();
    // Use a real-shaped but different wallet so Zod param validation passes
    const otherWallet = bs58.encode(nacl.sign.keyPair().publicKey);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/scan/${otherWallet}?mode=full`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("enqueues a scan job and returns jobId", async () => {
    const { wallet, cookie } = await login();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/scan/${wallet}?mode=full`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { jobId: string };
    expect(typeof body.jobId).toBe("string");

    const job = await mongoose.connection.collection("scanJobs").findOne({});
    expect(job).toBeTruthy();
  });
});

describe("GET /api/v1/scan/job/:jobId", () => {
  it("returns 404 for unknown jobId", async () => {
    const { cookie } = await login();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scan/job/000000000000000000000000",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns the job state for a known jobId", async () => {
    const { wallet, cookie } = await login();
    const enqueueRes = await app.inject({
      method: "POST",
      url: `/api/v1/scan/${wallet}?mode=full`,
      headers: { cookie },
    });
    const { jobId } = JSON.parse(enqueueRes.body) as { jobId: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/scan/job/${jobId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(["queued", "running", "done", "failed"]).toContain(body.status);
  });
});
