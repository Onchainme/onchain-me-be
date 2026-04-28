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
    const result = routeAndParse(
      { ...baseTx, source: "JUPITER", type: "SWAP", events: { swap: {} } } as never,
      "WAL",
    );
    expect(result.normalized).not.toBeNull();
    expect(result.normalized?.protocol).toBe("jupiter");
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
