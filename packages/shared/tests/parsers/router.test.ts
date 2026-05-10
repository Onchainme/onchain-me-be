import { describe, it, expect } from "vitest";
import { routeAndParse } from "../../src/parsers/router.js";

const baseTx = {
  signature: "s1",
  slot: 1,
  timestamp: 1700000000,
  type: "UNKNOWN",
  source: "OTHER",
};

describe("routeAndParse", () => {
  it("returns null normalized and no warning for unknown source/type", () => {
    const result = routeAndParse(baseTx as never, "WAL");
    expect(result.normalized).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("dispatches Jupiter SWAP to jupiter parser", () => {
    // The v2 parser needs at least one identifiable leg belonging to the
    // wallet — provide a minimal native-input leg so the dispatcher succeeds.
    const result = routeAndParse(
      {
        ...baseTx,
        source: "JUPITER",
        type: "SWAP",
        events: {
          swap: {
            nativeInput: { account: "WAL", amount: "100000" },
            tokenOutputs: [
              {
                userAccount: "WAL",
                mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                rawTokenAmount: { tokenAmount: "1000", decimals: 6 },
              },
            ],
          },
        },
      } as never,
      "WAL",
    );
    expect(result.normalized).not.toBeNull();
    expect(result.normalized?.protocol).toBe("jupiter");
  });

  it("dispatches Pump.fun SWAP to pumpfun parser (new protocol)", () => {
    const result = routeAndParse(
      {
        ...baseTx,
        source: "PUMP_FUN",
        type: "SWAP",
        events: {
          swap: {
            nativeInput: { account: "WAL", amount: "5000000" },
            tokenOutputs: [
              {
                userAccount: "WAL",
                mint: "SomePumpfunMint11111111111111111111111111111",
                rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
              },
            ],
          },
        },
      } as never,
      "WAL",
    );
    expect(result.normalized).not.toBeNull();
    expect(result.normalized?.protocol).toBe("pumpfun");
  });

  it("dispatches Magic Eden NFT_SALE to magic_eden parser", () => {
    const result = routeAndParse(
      {
        ...baseTx,
        source: "MAGIC_EDEN",
        type: "NFT_SALE",
        events: { nft: { type: "NFT_SALE", buyer: "WAL", seller: "OTHER" } },
      } as never,
      "WAL",
    );
    expect(result.normalized).not.toBeNull();
    expect(result.normalized?.protocol).toBe("magic_eden");
  });
});
