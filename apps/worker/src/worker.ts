import { pino } from "pino";
import { captureException, closeDb, closeRedis, createQueue, createWorker, getRedisConnection, initSentry, loadEnv, QUEUE_NAMES } from "@onchainme/shared";
import { scanWalletProcessor } from "./jobs/scanWallet.js";
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

  const scanWorker = createWorker(QUEUE_NAMES.scan, scanWalletProcessor, 2);
  scanWorker.on("ready", () => log.info("scanWallet worker registered"));
  scanWorker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err }, "scanWallet job failed");
    captureException(err, { jobId: job?.id, queue: "scan" });
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
