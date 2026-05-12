import type { ParserFn, ParseResult } from "./types.js";
import type { HeliusEnhancedTx } from "../helius/schema.js";
import { parseJupiterSwap } from "./jupiter.js";
import { parsePumpfunSwap } from "./pumpfun.js";
import { parseMagicEden } from "./magicEden.js";

// Helius classifies DEX-aggregator swaps under several `source` values. From
// the user's perspective they all behave like "I aggregated through Solana
// DEXes" — count them all toward Jupiter-volume tier. The actual on-chain
// event shape (events.swap.tokenInputs/Outputs/native*) is identical, so
// parseJupiterSwap (which routes through the shared swap extractor) handles
// every one of these without changes.
//
// Sample distribution from a real $50k-volume wallet (3000 tx history):
//   JUPITER 82, DFLOW 11, OKX_DEX_ROUTER 3, TITAN 2
// Tagging them all `protocol: "jupiter"` lets the silver/original badge
// thresholds work without inventing a new badge per aggregator.
const PARSERS: Record<string, ParserFn | undefined> = {
  JUPITER: parseJupiterSwap,
  DFLOW: parseJupiterSwap,
  OKX_DEX_ROUTER: parseJupiterSwap,
  TITAN: parseJupiterSwap,
  PUMP_FUN: parsePumpfunSwap,
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
