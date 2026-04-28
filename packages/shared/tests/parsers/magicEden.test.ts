import { describe, it, expect } from "vitest";
import buy from "../fixtures/helius/magic_eden_buy.json" with { type: "json" };
import sell from "../fixtures/helius/magic_eden_sell.json" with { type: "json" };
import { parseMagicEden } from "../../src/parsers/magicEden.js";

const WALLET = "BUYER_WALLET";

describe("parseMagicEden", () => {
  it("classifies the wallet as buyer when buyer === wallet", () => {
    const r = parseMagicEden(buy as never, WALLET);
    expect(r.normalized?.action).toBe("nft_buy");
    expect(r.normalized?.protocol).toBe("magic_eden");
    expect(r.normalized?.meta).toMatchObject({
      mint: "M3T_MINT",
      counterparty: "SELLER_WALLET",
      amountLamports: 2500000000,
    });
  });

  it("classifies the wallet as seller when seller === wallet", () => {
    const r = parseMagicEden(sell as never, WALLET);
    expect(r.normalized?.action).toBe("nft_sell");
    expect(r.normalized?.meta).toMatchObject({
      mint: "M3T_MINT_2",
      counterparty: "OTHER_WALLET",
    });
  });

  it("returns null when wallet is neither buyer nor seller (3rd-party tx leak)", () => {
    const r = parseMagicEden(buy as never, "UNRELATED_WALLET");
    expect(r.normalized).toBeNull();
  });

  it("returns null on transactionError", () => {
    const failed = { ...(buy as object), transactionError: { Some: "err" } };
    const r = parseMagicEden(failed as never, WALLET);
    expect(r.normalized).toBeNull();
  });

  it("returns null when events.nft is absent", () => {
    const noEv = { ...(buy as object), events: {} };
    const r = parseMagicEden(noEv as never, WALLET);
    expect(r.normalized).toBeNull();
  });
});
