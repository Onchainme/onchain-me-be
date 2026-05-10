import type { ParserFn } from "./types.js";
import { parseSwap } from "./swap.js";

/**
 * Jupiter aggregator (`source: "JUPITER"`) swap parser. Routes through the
 * shared swap extractor and tags the normalized tx with `protocol: "jupiter"`.
 *
 * Output meta carries both input and output legs (mint/amount/decimals) so
 * downstream pricing can compute volumeUsd = max(inputUsd, outputUsd).
 */
export const parseJupiterSwap: ParserFn = (tx, wallet) => parseSwap(tx, wallet, "jupiter");
