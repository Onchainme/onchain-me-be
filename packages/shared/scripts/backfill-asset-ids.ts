/**
 * Backfill BadgeClaim.assetId for rows where it equals "unknown".
 *
 * Cause: an older fetchTransactionStatus regex ("AssetId:") didn't match the
 * actual Bubblegum log line ("Leaf asset ID: ..."), so /mint/confirm wrote
 * "unknown" instead of the real pubkey. The regex is fixed; this script
 * recovers historical rows.
 *
 * Strategy: for each affected claim, re-fetch the tx and parse its logs
 * with the new regex. Idempotent — if the parse still fails (devnet RPC may
 * forget old confirmed slots), the row stays "unknown" and is skipped on
 * the next run too.
 *
 * Usage (from packages/shared):
 *   pnpm tsx scripts/backfill-asset-ids.ts
 * Reads env via dotenv (.env.local in repo root).
 */
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
loadDotenv({ path: path.join(repoRoot, ".env.local") });

const { connectDb, closeDb, models, fetchTransactionStatus } = await import("../src/index.js");

await connectDb();

const claims = await models.BadgeClaim.find({ assetId: "unknown" }).lean();
console.log(`found ${claims.length} claims with assetId='unknown'`);

let fixed = 0;
let stillUnknown = 0;
for (const c of claims) {
  const id = c._id as unknown as { walletAddress: string; badgeId: string };
  const sig = c.mintSignature;
  if (!sig || sig.startsWith("imported:")) {
    stillUnknown += 1;
    continue;
  }
  try {
    const r = await fetchTransactionStatus(sig);
    if (r.status === "success" && r.assetId) {
      await models.BadgeClaim.updateOne(
        { _id: { walletAddress: id.walletAddress, badgeId: id.badgeId } },
        { $set: { assetId: r.assetId } },
      );
      fixed += 1;
      console.log(`  ✓ ${id.walletAddress.slice(0, 4)}…/${id.badgeId} → ${r.assetId}`);
    } else {
      stillUnknown += 1;
    }
  } catch (err) {
    stillUnknown += 1;
    console.warn(`  ! ${sig.slice(0, 12)}…: ${(err as Error).message}`);
  }
}

console.log(`\ndone. fixed=${fixed}, still unknown=${stillUnknown}`);
await closeDb();
process.exit(0);
