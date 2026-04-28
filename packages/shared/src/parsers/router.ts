import type { ParserFn, ParseResult } from "./types.js";
import type { HeliusEnhancedTx } from "../helius/schema.js";
import { parseJupiterSwap } from "./jupiter.js";
import { parseMagicEden } from "./magicEden.js";

const PARSERS: Record<string, ParserFn | undefined> = {
  JUPITER: parseJupiterSwap,
  MAGIC_EDEN: parseMagicEden,
};

export function routeAndParse(tx: HeliusEnhancedTx, walletAddress: string): ParseResult {
  const parser = PARSERS[tx.source];
  if (!parser) return { normalized: null };
  try {
    return parser(tx, walletAddress);
  } catch (err) {
    return {
      normalized: null,
      warning: {
        parser: tx.source,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
