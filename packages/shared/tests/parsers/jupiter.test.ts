import { describe, it, expect } from "vitest";
import jupiterFixture from "../fixtures/helius/jupiter_swap.json" with { type: "json" };
import { parseJupiterSwap } from "../../src/parsers/jupiter.js";

const WALLET = "WALLET_ADDRESS_PLACEHOLDER";

describe("parseJupiterSwap", () => {
  it("normalizes a SWAP tx into protocol=jupiter, action=swap", () => {
    const r = parseJupiterSwap(jupiterFixture as never, WALLET);
    expect(r.normalized).not.toBeNull();
    expect(r.normalized?.signature).toBe("5xQpkX...JupiterSwap");
    expect(r.normalized?.protocol).toBe("jupiter");
    expect(r.normalized?.action).toBe("swap");
    expect(r.normalized?.walletAddress).toBe(WALLET);
    expect(r.normalized?.blockTime.getTime()).toBe(1714000000 * 1000);
  });

  it("captures input/output mints and amounts in meta", () => {
    const r = parseJupiterSwap(jupiterFixture as never, WALLET);
    expect(r.normalized?.meta).toMatchObject({
      inputMint: "SOL",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputAmount: "100000000",
      outputDecimals: 6,
    });
  });

  it("returns normalized=null when type is not SWAP", () => {
    const fakeNonSwap = {
      ...(jupiterFixture as object),
      type: "TRANSFER",
      events: {},
    };
    const r = parseJupiterSwap(fakeNonSwap as never, WALLET);
    expect(r.normalized).toBeNull();
  });

  it("returns normalized=null when transactionError is present", () => {
    const failed = {
      ...(jupiterFixture as object),
      transactionError: { InstructionError: [0, "Custom"] },
    };
    const r = parseJupiterSwap(failed as never, WALLET);
    expect(r.normalized).toBeNull();
  });
});
