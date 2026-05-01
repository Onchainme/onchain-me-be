import { closeDb, connectDb } from "./connect.js";
import { BadgeClaim, User } from "./models.js";
import { REGISTRY } from "../badges/registry.js";
import type { BadgeId } from "../badges/types.js";

interface ClaimDoc {
  _id: { walletAddress: string; badgeId: BadgeId };
}

async function main(): Promise<void> {
  console.warn("Connecting to MongoDB...");
  await connectDb();

  console.warn("Recomputing User.score from BadgeClaim...");

  const claims = (await BadgeClaim.find({}, { _id: 1 }).lean()) as unknown as ClaimDoc[];
  const totalsByWallet = new Map<string, number>();
  for (const c of claims) {
    const { walletAddress, badgeId } = c._id;
    const weight = REGISTRY[badgeId]?.weight ?? 0;
    totalsByWallet.set(walletAddress, (totalsByWallet.get(walletAddress) ?? 0) + weight);
  }

  // Reset scores to 0 for users with no claims so old denormalized values don't linger.
  await User.updateMany({}, { $set: { score: 0 } });

  let written = 0;
  for (const [wallet, total] of totalsByWallet) {
    await User.updateOne({ _id: wallet }, { $set: { score: total } });
    written += 1;
  }

  console.warn(`Updated ${written} users (out of ${totalsByWallet.size} with claims).`);
  await closeDb();
}

main().catch(async (err) => {
  console.error("recompute-scores failed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
