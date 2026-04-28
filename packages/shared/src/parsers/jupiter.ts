import type { ParserFn } from "./types.js";

const SOL_MINT = "SOL";

export const parseJupiterSwap: ParserFn = (tx, wallet) => {
  if (tx.type !== "SWAP") return { normalized: null };
  if (tx.transactionError !== null && tx.transactionError !== undefined) return { normalized: null };

  const swap = tx.events?.swap;
  if (!swap) return { normalized: null };

  const userTokenOut = (swap.tokenOutputs ?? []).find(
    (o): o is { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } } =>
      typeof o === "object" && o !== null && (o as Record<string, unknown>)["userAccount"] === wallet,
  );
  const userTokenIn = (swap.tokenInputs ?? []).find(
    (i): i is { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } } =>
      typeof i === "object" && i !== null && (i as Record<string, unknown>)["userAccount"] === wallet,
  );

  const nativeInForUser =
    swap.nativeInput && swap.nativeInput.account === wallet ? swap.nativeInput.amount : null;

  const inputMint = userTokenIn?.mint ?? (nativeInForUser ? SOL_MINT : "unknown");
  const outputMint = userTokenOut?.mint ?? "unknown";
  const outputAmount = userTokenOut?.rawTokenAmount.tokenAmount ?? null;
  const outputDecimals = userTokenOut?.rawTokenAmount.decimals ?? null;

  return {
    normalized: {
      signature: tx.signature,
      walletAddress: wallet,
      blockTime: new Date(tx.timestamp * 1000),
      protocol: "jupiter",
      action: "swap",
      amountUsd: null,
      meta: {
        inputMint,
        outputMint,
        outputAmount,
        outputDecimals,
        nativeInput: nativeInForUser,
      },
    },
  };
};
