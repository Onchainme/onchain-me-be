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
