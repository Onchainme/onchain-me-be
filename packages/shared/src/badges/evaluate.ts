import { definitionsArray } from "./registry.js";
import type { BadgeEvalContext, BadgeEvalResult } from "./types.js";

export function evaluateAll(ctx: BadgeEvalContext): BadgeEvalResult[] {
  const out: BadgeEvalResult[] = [];
  for (const def of definitionsArray()) {
    const r = def.evaluate(ctx);
    if (r) out.push(r);
  }
  return out;
}
