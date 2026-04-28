import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import fixture from "../../../packages/shared/tests/fixtures/wallets/pinned_wallet_a.json" with { type: "json" };
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis, connectDb, mongoose, QUEUE_NAMES, createWorker, createQueue } from "@onchainme/shared";
import { scanWalletProcessor } from "../../worker/src/jobs/scanWallet.js";

const server = setupServer(
  http.get("https://api.helius.xyz/v0/addresses/:wallet/transactions", () =>
    HttpResponse.json((fixture as { transactions: unknown[] }).transactions),
  ),
);

const app = await buildServer();
await connectDb();
const worker = createWorker(QUEUE_NAMES.scan, scanWalletProcessor, 1);
const scanQueue = createQueue(QUEUE_NAMES.scan);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(async () => {
  server.close();
  await scanQueue.close();
  await worker.close();
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  // Drain any leftover BullMQ jobs from prior runs (Redis persists between test runs)
  await scanQueue.obliterate({ force: true });
  await mongoose.connection.collection("users").deleteMany({});
  await mongoose.connection.collection("authNonces").deleteMany({});
  await mongoose.connection.collection("scanJobs").deleteMany({});
  await mongoose.connection.collection("txs").deleteMany({});
  await mongoose.connection.collection("txRawCache").deleteMany({});
  await mongoose.connection.collection("badgeEligibilities").deleteMany({});
});

async function login(realKeypair: nacl.SignKeyPair): Promise<string> {
  const wallet = bs58.encode(realKeypair.publicKey);
  const nonceRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/nonce",
    payload: { wallet },
  });
  const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), realKeypair.secretKey));
  const verifyRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    payload: { wallet, nonce, signature: sig },
  });
  const cookie = verifyRes.cookies.find((c) => c.name === "om_session");
  return `om_session=${cookie?.value}`;
}

async function pollUntilDone(
  jobId: string,
  cookie: string,
  timeoutMs = 30_000,
): Promise<{ status: string; result: unknown }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/scan/job/${jobId}`,
      headers: { cookie },
    });
    const body = JSON.parse(res.body) as { status: string; result: unknown };
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`scan job ${jobId} did not finish within ${timeoutMs}ms`);
}

describe("pinned wallet end-to-end scan", () => {
  it("scans the fixture and lands 2 normalized txs (jupiter + magic_eden) in the DB", async () => {
    const kp = nacl.sign.keyPair();
    const realWallet = bs58.encode(kp.publicKey);

    server.use(
      http.get("https://api.helius.xyz/v0/addresses/:wallet/transactions", () => {
        const txs = JSON.parse(JSON.stringify(fixture.transactions)).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (t: any) =>
            JSON.parse(
              JSON.stringify(t).replace(
                /PinnedWalletA1111111111111111111111111111111/g,
                realWallet,
              ),
            ),
        );
        return HttpResponse.json(txs);
      }),
    );

    const cookie = await login(kp);

    const enqueueRes = await app.inject({
      method: "POST",
      url: `/api/v1/scan/${realWallet}?mode=full`,
      headers: { cookie },
    });
    expect(enqueueRes.statusCode).toBe(202);
    const { jobId } = JSON.parse(enqueueRes.body) as { jobId: string };

    const final = await pollUntilDone(jobId, cookie, 30_000);
    expect(final.status).toBe("done");

    const txCount = await mongoose.connection
      .collection("txs")
      .countDocuments({ walletAddress: realWallet });
    expect(txCount).toBe(2);

    const protocols = await mongoose.connection
      .collection("txs")
      .distinct("protocol", { walletAddress: realWallet });
    expect(protocols.sort()).toEqual(["jupiter", "magic_eden"]);

    const user = await mongoose.connection.collection("users").findOne({ _id: realWallet });
    expect(user?.["lastScanCursor"]).toBeTruthy();

    const eligibilityRows = await mongoose.connection
      .collection("badgeEligibilities")
      .find({ "_id.walletAddress": realWallet })
      .toArray();
    const eligibleIds = eligibilityRows.map((r) => (r._id as { badgeId: string }).badgeId).sort();

    // Pinned fixture has 1 jupiter swap + 1 magic_eden buy + 1 unknown.
    // blockTime is April 2024 -> "early_adopter" qualifies if NOW > April 2025.
    expect(eligibleIds).toEqual(
      ["early_adopter", "first_nft", "first_swap", "multi_protocol"].sort(),
    );

    const finalResult = final.result as { newBadges: string[]; totalBadges: number };
    expect(finalResult.totalBadges).toBe(4);
    expect(finalResult.newBadges.sort()).toEqual(
      ["early_adopter", "first_nft", "first_swap", "multi_protocol"].sort(),
    );
  }, 45_000);
});
