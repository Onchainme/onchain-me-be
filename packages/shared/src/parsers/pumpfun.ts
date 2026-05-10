import type { ParserFn } from "./types.js";
import { parseSwap } from "./swap.js";

/**
 * Pump.fun (`source: "PUMP_FUN"`) swap parser. Pump.fun txs come through
 * Helius enhanced API with the same swap shape as Jupiter, so we reuse the
 * shared extractor and tag with `protocol: "pumpfun"`. Volume is computed
 * later from input/output amounts via the Jupiter Price API.
 */
export const parsePumpfunSwap: ParserFn = (tx, wallet) => parseSwap(tx, wallet, "pumpfun");
