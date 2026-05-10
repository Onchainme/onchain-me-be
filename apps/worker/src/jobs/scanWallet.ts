import type { Job } from "bullmq";
import {
  addParserWarning,
  connectDb,
  evaluateAll,
  fetchAllTransactionsCappedAt,
  getMeteoraPositionsUsd,
  getOrcaPositionsUsd,
  getUsdPrices,
  hasSeekerGenesisNft,
  models,
  routeAndParse,
  usdValue,
  type BadgeEvalContext,
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

type SwapProtocol = "jupiter" | "pumpfun";

interface ProtocolVolumeState {
  usd: number;
  lastTxSig: string | null;
}

interface SwapMeta {
  inputMint?: string | null;
  inputAmount?: string | null;
  inputDecimals?: number | null;
  outputMint?: string | null;
  outputAmount?: string | null;
  outputDecimals?: number | null;
}

/**
 * Pick the bigger USD-valued leg of a swap. Avoids double-counting both
 * sides of e.g. USDC→SOL.
 */
function computeSwapVolumeUsd(meta: SwapMeta, prices: Record<string, number>): number {
  const inUsd =
    meta.inputMint && meta.inputAmount && meta.inputDecimals !== null && meta.inputDecimals !== undefined
      ? usdValue(BigInt(meta.inputAmount), meta.inputDecimals, prices[meta.inputMint])
      : 0;
  const outUsd =
    meta.outputMint && meta.outputAmount && meta.outputDecimals !== null && meta.outputDecimals !== undefined
      ? usdValue(BigInt(meta.outputAmount), meta.outputDecimals, prices[meta.outputMint])
      : 0;
  return Math.max(inUsd, outUsd);
}

function collectMints(txs: NormalizedTx[]): string[] {
  const out = new Set<string>();
  for (const tx of txs) {
    const m = tx.meta as SwapMeta;
    if (m.inputMint) out.add(m.inputMint);
    if (m.outputMint) out.add(m.outputMint);
  }
  return [...out];
}

export async function scanWalletProcessor(job: Job<ScanWalletJobData>): Promise<{ totalTxs: number }> {
  await connectDb();
  const { walletAddress, mode, scanJobId } = job.data;

  await job.updateProgress({ phase: "fetching_signatures", processed: 0, total: 0 });
  await models.ScanJob.updateOne(
    { _id: scanJobId },
    { $set: { status: "running", progress: { phase: "fetching_signatures" } } },
  );

  // Read existing per-protocol checkpoints. Incremental mode resumes from the
  // last counted signature; full mode starts from scratch (rare manual reset).
  const userDoc = await models.User.findById(walletAddress).lean();
  const initial: Record<SwapProtocol, ProtocolVolumeState> = {
    jupiter: { usd: 0, lastTxSig: null },
    pumpfun: { usd: 0, lastTxSig: null },
  };
  if (mode === "incremental" && userDoc?.["protocolVolume"]) {
    const pv = userDoc["protocolVolume"] as Partial<typeof initial>;
    if (pv.jupiter)
      initial.jupiter = { usd: pv.jupiter.usd ?? 0, lastTxSig: pv.jupiter.lastTxSig ?? null };
    if (pv.pumpfun)
      initial.pumpfun = { usd: pv.pumpfun.usd ?? 0, lastTxSig: pv.pumpfun.lastTxSig ?? null };
  }

  // Fetch new txs since the *oldest* per-protocol checkpoint. We dedupe per
  // protocol below by signature. One Helius pull covers both Jupiter & Pump.fun
  // since they live in the same wallet history.
  const oldestSig = initial.jupiter.lastTxSig ?? initial.pumpfun.lastTxSig ?? undefined;
  const until = mode === "incremental" ? oldestSig : undefined;
  const raw = await fetchAllTransactionsCappedAt(walletAddress, SCAN_CAP, until ?? undefined);

  await job.updateProgress({ phase: "parsing", processed: 0, total: raw.length });

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

  // Enrich swap txs with USD volume. Batch all unique mints into one Jupiter
  // Price API call so a wallet with 100 swaps only triggers 1 outbound HTTP.
  const swapTxs = normalized.filter((t) => t.action === "swap");
  const mints = collectMints(swapTxs);
  const prices = mints.length ? await getUsdPrices(mints) : {};
  for (const tx of swapTxs) {
    tx.volumeUsd = computeSwapVolumeUsd(tx.meta as SwapMeta, prices);
  }

  await job.updateProgress({ phase: "persisting", processed: 0, total: normalized.length });
  await persistRawAndNormalized(walletAddress, raw, normalized);

  // Update per-protocol cumulative volume + checkpoint.
  // Helius returns txs newest-first, so iterate reversed to accumulate in
  // chronological order. The newest signature in each protocol is the new
  // checkpoint we save.
  const next = structuredClone(initial);
  const newestSigPerProtocol: Partial<Record<SwapProtocol, string>> = {};
  for (let i = swapTxs.length - 1; i >= 0; i--) {
    const tx = swapTxs[i]!;
    const proto = tx.protocol;
    if (proto !== "jupiter" && proto !== "pumpfun") continue;
    // Skip if this sig is already at or before the checkpoint (defensive — fetcher
    // should have respected `until`, but Helius can return the boundary tx itself).
    if (initial[proto].lastTxSig === tx.signature) continue;
    next[proto].usd += tx.volumeUsd ?? 0;
    if (!newestSigPerProtocol[proto]) newestSigPerProtocol[proto] = tx.signature;
  }
  for (const p of Object.keys(newestSigPerProtocol) as SwapProtocol[]) {
    next[p].lastTxSig = newestSigPerProtocol[p] ?? next[p].lastTxSig;
  }

  // Point-in-time position scan. Run in parallel, fail-soft on individual
  // services (orca/meteora/RPC).
  await job.updateProgress({ phase: "fetching_positions", processed: 0, total: 0 });
  const [orcaUsd, meteoraUsd, seekerHeld] = await Promise.all([
    getOrcaPositionsUsd(walletAddress).catch(() => 0),
    getMeteoraPositionsUsd(walletAddress).catch(() => 0),
    hasSeekerGenesisNft(walletAddress).catch(() => false),
  ]);

  // Evaluate the 13 badges from the new in-memory snapshot.
  const ctx: BadgeEvalContext = {
    protocolVolumeUsd: { jupiter: next.jupiter.usd, pumpfun: next.pumpfun.usd },
    positionUsd: { orca: orcaUsd, meteora: meteoraUsd },
    seekerHeld,
    now: new Date(),
  };
  const evalResults = evaluateAll(ctx);
  const { newBadgeIds } = await upsertEligibilities(walletAddress, evalResults);

  const newestSig = raw[0]?.signature;
  await models.User.updateOne(
    { _id: walletAddress },
    {
      $set: {
        lastScanAt: new Date(),
        ...(newestSig ? { lastScanCursor: newestSig } : {}),
        "protocolVolume.jupiter.usd": next.jupiter.usd,
        "protocolVolume.jupiter.lastTxSig": next.jupiter.lastTxSig,
        "protocolVolume.pumpfun.usd": next.pumpfun.usd,
        "protocolVolume.pumpfun.lastTxSig": next.pumpfun.lastTxSig,
        "positionSnapshot.orcaUsd": orcaUsd,
        "positionSnapshot.meteoraUsd": meteoraUsd,
        "positionSnapshot.seekerHeld": seekerHeld,
        "positionSnapshot.takenAt": new Date(),
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
