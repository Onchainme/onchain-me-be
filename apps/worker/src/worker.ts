import { pino } from "pino";
import { captureException, closeDb, closeRedis, connectDb, createQueue, createWorker, getRedisConnection, initSentry, loadEnv, models, QUEUE_NAMES } from "@onchainme/shared";
import { scanWalletProcessor, type ScanWalletJobData } from "./jobs/scanWallet.js";
import { checkBalanceProcessor } from "./jobs/checkBalance.js";

async function main(): Promise<void> {
  const env = loadEnv();
  initSentry({ component: "worker" });
  const log = pino({
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss" },
          },
        }
      : {}),
  });

  log.info("worker starting");

  // Verify Redis connectivity at startup; fail fast if it cannot connect.
  const redis = getRedisConnection();
  const ping = await redis.ping();
  if (ping !== "PONG") {
    log.error({ ping }, "redis ping did not return PONG");
    process.exit(1);
  }
  log.info("redis ready");

  // Concurrency 1: two scans in parallel both hit the same Helius API key
  // and on the free tier (10 req/s, ~100k credits/mo) any burst trips a 429
  // that snowballs through BullMQ retries. Serializing scans cuts the burst
  // surface in half — combined with the non-retryable 429 path in
  // packages/shared/src/helius/client.ts, this keeps us inside free-tier
  // limits even when 5+ users mash "Update inventory" at once.
  const scanWorker = createWorker(QUEUE_NAMES.scan, scanWalletProcessor, 1);
  scanWorker.on("ready", () => log.info("scanWallet worker registered"));
  scanWorker.on("failed", async (job, err) => {
    log.error({ jobId: job?.id, err }, "scanWallet job failed");
    captureException(err, { jobId: job?.id, queue: "scan" });
    // BullMQ fires "failed" both for intermediate attempt failures AND for
    // the final give-up. Only flip Mongo to "failed" on the final one — if
    // attemptsMade < attempts there's still a retry coming and we'd lie to
    // the frontend by saying it's done.
    const finished =
      !!job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (finished) {
      const data = job?.data as ScanWalletJobData | undefined;
      if (data?.scanJobId) {
        try {
          await connectDb();
          await models.ScanJob.updateOne(
            { _id: data.scanJobId, status: "running" },
            {
              $set: {
                status: "failed",
                finishedAt: new Date(),
                error: err.message,
              },
            },
          );
          log.info({ jobId: job?.id, scanJobId: data.scanJobId }, "scanJob marked failed");
        } catch (markErr) {
          log.error({ markErr, jobId: job?.id }, "failed to mark scanJob as failed");
        }
      }
    }
  });
  log.info("worker ready (scanWallet + checkBalance processors registered)");

  const balanceWorker = createWorker(QUEUE_NAMES.checkBalance, checkBalanceProcessor, 1);
  balanceWorker.on("ready", () => log.info("checkBalance worker registered"));
  balanceWorker.on("completed", (job, result) => log.info({ jobId: job.id, result }, "checkBalance completed"));
  balanceWorker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err }, "checkBalance failed");
    captureException(err, { jobId: job?.id, queue: "checkBalance" });
  });

  const balanceQueue = createQueue(QUEUE_NAMES.checkBalance);
  await balanceQueue.add(
    "checkBalance",
    {},
    {
      jobId: "checkBalance:repeatable",
      repeat: { pattern: "*/10 * * * *" },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );
  log.info("checkBalance repeatable job scheduled (every 10 min)");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      log.info({ signal }, "shutting down");
      await scanWorker.close();
      await balanceWorker.close();
      await closeRedis();
      await closeDb();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("worker crashed at startup:", err);
  process.exit(1);
});
