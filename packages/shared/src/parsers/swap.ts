/**
 * Shared swap parser used for both Jupiter and Pump.fun. Helius emits the
 * same `SWAP` shape with `events.swap.{tokenInputs, tokenOutputs, nativeInput}`
 * for these two protocols, so a single extractor returns a NormalizedTx with
 * the right `protocol` tag.
 */

import type { HeliusEnhancedTx } from "../helius/schema.js";
import type { NormalizedTx, ParseResult } from "./types.js";
import type { Protocol } from "../db/models.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface UserTokenLeg {
  mint: string;
  rawAmount: string;
  decimals: number;
}

function pickUserLeg(
  legs: ReadonlyArray<unknown> | null | undefined,
  wallet: string,
): UserTokenLeg | null {
  if (!legs) return null;
  for (const leg of legs) {
    if (typeof leg !== "object" || leg === null) continue;
    const obj = leg as Record<string, unknown>;
    if (obj["userAccount"] !== wallet) continue;
    const raw = (obj["rawTokenAmount"] ?? {}) as Record<string, unknown>;
    const mint = typeof obj["mint"] === "string" ? obj["mint"] : null;
    const amount = typeof raw["tokenAmount"] === "string" ? raw["tokenAmount"] : null;
    const decimals = typeof raw["decimals"] === "number" ? raw["decimals"] : null;
    if (mint && amount && decimals !== null) {
      return { mint, rawAmount: amount, decimals };
    }
  }
  return null;
}

export function parseSwap(
  tx: HeliusEnhancedTx,
  wallet: string,
  protocol: Protocol,
): ParseResult {
  if (tx.type !== "SWAP") return { normalized: null };
  if (tx.transactionError !== null && tx.transactionError !== undefined) {
    return { normalized: null };
  }
  const swap = tx.events?.swap;
  if (!swap) return { normalized: null };

  const userOut = pickUserLeg(swap.tokenOutputs as unknown as ReadonlyArray<unknown>, wallet);
  const userIn = pickUserLeg(swap.tokenInputs as unknown as ReadonlyArray<unknown>, wallet);

  // Native (SOL) legs come on a separate field. When the user sends SOL we
  // treat input as SOL with 9 decimals; when receiving SOL similarly.
  const nativeInForUser =
    swap.nativeInput && swap.nativeInput.account === wallet ? swap.nativeInput.amount : null;
  const nativeOutForUser =
    swap.nativeOutput && swap.nativeOutput.account === wallet ? swap.nativeOutput.amount : null;

  const inputMint = userIn?.mint ?? (nativeInForUser ? SOL_MINT : null);
  const inputAmount = userIn?.rawAmount ?? (nativeInForUser ?? null);
  const inputDecimals = userIn?.decimals ?? (nativeInForUser ? 9 : null);

  const outputMint = userOut?.mint ?? (nativeOutForUser ? SOL_MINT : null);
  const outputAmount = userOut?.rawAmount ?? (nativeOutForUser ?? null);
  const outputDecimals = userOut?.decimals ?? (nativeOutForUser ? 9 : null);

  // If we couldn't identify either side as belonging to the wallet, skip.
  if (!inputMint && !outputMint) return { normalized: null };

  const normalized: NormalizedTx = {
    signature: tx.signature,
    walletAddress: wallet,
    blockTime: new Date(tx.timestamp * 1000),
    protocol,
    action: "swap",
    amountUsd: null,
    volumeUsd: null,
    meta: {
      inputMint,
      inputAmount,
      inputDecimals,
      outputMint,
      outputAmount,
      outputDecimals,
      nativeInput: nativeInForUser,
      nativeOutput: nativeOutForUser,
    },
  };
  return { normalized };
}
