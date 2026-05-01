import { User } from "../db/models.js";
import { REGISTRY } from "./registry.js";
import type { BadgeId } from "./types.js";

export function score(claimedBadgeIds: readonly BadgeId[]): number {
  const unique = new Set(claimedBadgeIds);
  let total = 0;
  for (const id of unique) {
    const def = REGISTRY[id];
    if (def) total += def.weight;
  }
  return total;
}

/**
 * Position in the global leaderboard, 1-based.
 * Wallets tied on score share the same rank (competition / "1224" ranking),
 * so two leaders both get rank 1, the next gets rank 3.
 *
 * Score 0 → rank 0 (sentinel meaning "unranked"). The frontend can hide it
 * to avoid showing rank for wallets that never claimed a badge.
 */
export async function getRank(walletScore: number): Promise<number> {
  if (walletScore <= 0) return 0;
  const ahead = await User.countDocuments({ score: { $gt: walletScore } });
  return ahead + 1;
}

/**
 * Batch version: for an array of scores returns rank for each by deduplicating
 * the unique non-zero values and running one count per distinct score.
 * Useful for the lands listing endpoint where we'd otherwise issue N queries.
 */
export async function getRanks(scores: readonly number[]): Promise<number[]> {
  const uniquePositive = Array.from(new Set(scores.filter((s) => s > 0)));
  const lookup = new Map<number, number>();
  await Promise.all(
    uniquePositive.map(async (s) => {
      const ahead = await User.countDocuments({ score: { $gt: s } });
      lookup.set(s, ahead + 1);
    }),
  );
  return scores.map((s) => (s > 0 ? (lookup.get(s) ?? 0) : 0));
}
