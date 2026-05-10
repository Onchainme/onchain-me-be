import type { Protocol, TxAction } from "../db/models.js";
import type { HeliusEnhancedTx } from "../helius/schema.js";

export interface NormalizedTx {
  signature: string;
  walletAddress: string;
  blockTime: Date;
  protocol: Protocol;
  action: TxAction;
  amountUsd: number | null;
  /**
   * USD value of this single tx, computed by the worker via Jupiter Price API
   * after parsing. Set to null by parsers; populated later in the scan flow.
   */
  volumeUsd: number | null;
  meta: Record<string, unknown>;
}

export interface ParseResult {
  normalized: NormalizedTx | null;
  warning?: { parser: string; error: string };
}

export type ParserFn = (tx: HeliusEnhancedTx, walletAddress: string) => ParseResult;
