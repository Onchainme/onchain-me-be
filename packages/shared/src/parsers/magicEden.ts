import type { ParserFn } from "./types.js";

export const parseMagicEden: ParserFn = (tx, wallet) => {
  if (tx.transactionError !== null && tx.transactionError !== undefined) return { normalized: null };
  const ev = tx.events?.nft;
  if (!ev) return { normalized: null };

  const isBuy = ev.buyer === wallet;
  const isSell = ev.seller === wallet;
  if (!isBuy && !isSell) return { normalized: null };

  const counterparty = isBuy ? ev.seller : ev.buyer;
  const mint = ev.nfts?.[0]?.mint;

  return {
    normalized: {
      signature: tx.signature,
      walletAddress: wallet,
      blockTime: new Date(tx.timestamp * 1000),
      protocol: "magic_eden",
      action: isBuy ? "nft_buy" : "nft_sell",
      amountUsd: null,
      meta: {
        mint,
        counterparty,
        amountLamports: ev.amount,
        saleType: ev.saleType,
      },
    },
  };
};
