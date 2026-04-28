import type { Job } from "bullmq";
import {
  addParserWarning,
  connectDb,
  evaluateAll,
  fetchAllTransactionsCappedAt,
  models,
  routeAndParse,
  type NormalizedTx,
} from "@onchainme/shared";
import { persistRawAndNormalized } from "./helpers/persist.js";
import { upsertEligibilities } from "./helpers/eligibilities.js";

export interface ScanWalletJobData {
  walletAddress: string;
  mode: "full" | "incremental";
  scanJobId: string;
}

const SCAN_CAP = 5_000;

export async function scanWalletProcessor(job: Job<ScanWalletJobData>): Promise<{ totalTxs: number }> {
  await connectDb();
  const { walletAddress, mode, scanJobId } = job.data;

  await job.updateProgress({ phase: "fetching_signatures", processed: 0, total: 0 });
  await models.ScanJob.updateOne(
    { _id: scanJobId },
    { $set: { status: "running", progress: { phase: "fetching_signatures" } } },
  );

  let until: string | undefined;
  if (mode === "incremental") {
    const user = await models.User.findById(walletAddress);
    until = user?.["lastScanCursor"] ?? undefined;
  }

  const raw = await fetchAllTransactionsCappedAt(walletAddress, SCAN_CAP, until);

  await job.updateProgress({ phase: "parsing", processed: 0, total: raw.length });
  await models.ScanJob.updateOne(
    { _id: scanJobId },
    { $set: { progress: { phase: "parsing", processed: 0, total: raw.length } } },
  );

  const normalized: NormalizedTx[] = [];
  const warnings: { signature: string; parser: string; error: string }[] = [];
  for (const tx of raw) {
    const r = routeAndParse(tx, walletAddress);
    if (r.normalized) normalized.push(r.normalized);
    if (r.warning) {
      warnings.push({ signature: tx.signature, parser: r.warning.parser, error: r.warning.error });
      addParserWarning({ wallet: walletAddress, parser: r.warning.parser, signature: tx.signature, error: r.warning.error });
    }
  }

  await job.updateProgress({ phase: "persisting", processed: 0, total: normalized.length });
  await models.ScanJob.updateOne(
    { _id: scanJobId },
    { $set: { progress: { phase: "persisting", processed: 0, total: normalized.length } } },
  );

  await persistRawAndNormalized(walletAddress, raw, normalized);

  // --- evaluating phase ---
  await job.updateProgress({ phase: "evaluating", processed: 0, total: 0 });
  await models.ScanJob.updateOne(
    { _id: scanJobId },
    { $set: { progress: { phase: "evaluating", processed: 0, total: 0 } } },
  );

  // Re-evaluate against the FULL set of normalized txs for this wallet
  // (not just the new batch), because count-threshold + multi-protocol
  // rules need history.
  const allTxs = await models.Tx.find({ walletAddress }).lean();
  const normalizedAll: NormalizedTx[] = allTxs.map((t) => ({
    signature: t._id as unknown as string,
    walletAddress: t.walletAddress,
    blockTime: t.blockTime,
    protocol: t.protocol,
    action: t.action,
    amountUsd: t.amountUsd ?? null,
    meta: (t.meta as Record<string, unknown>) ?? {},
  }));

  const evalResults = evaluateAll({ txs: normalizedAll, now: new Date() });
  const { newBadgeIds } = await upsertEligibilities(walletAddress, evalResults);

  const newestSig = raw[0]?.signature;
  await models.User.updateOne(
    { _id: walletAddress },
    {
      $set: {
        lastScanAt: new Date(),
        ...(newestSig ? { lastScanCursor: newestSig } : {}),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  await models.ScanJob.updateOne(
    { _id: scanJobId },
    {
      $set: {
        status: "done",
        finishedAt: new Date(),
        progress: { phase: "done", processed: normalized.length, total: normalized.length },
        result: {
          totalBadges: evalResults.length,
          newBadges: newBadgeIds,
          warnings,
        },
      },
    },
  );

  return { totalTxs: normalized.length };
}
