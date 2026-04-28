import { describe, it, expect } from "vitest";
import type { NormalizedTx } from "../../src/parsers/types.js";
import { evaluateAll } from "../../src/badges/evaluate.js";

const NOW = new Date("2026-04-27T12:00:00Z");
const WALLET = "WAL";

function tx(overrides: Partial<NormalizedTx>): NormalizedTx {
  return {
    signature: `sig_${Math.random()}`,
    walletAddress: WALLET,
    blockTime: new Date("2026-01-01T00:00:00Z"),
    protocol: "jupiter",
    action: "swap",
    amountUsd: null,
    meta: {},
    ...overrides,
  };
}

function jupSwaps(n: number, baseDate = "2026-01-01T00:00:00Z"): NormalizedTx[] {
  return Array.from({ length: n }, (_, i) =>
    tx({
      signature: `sig_jup_${i}`,
      protocol: "jupiter",
      action: "swap",
      blockTime: new Date(new Date(baseDate).getTime() + i * 60_000),
    }),
  );
}

function nftBuys(n: number, baseDate = "2026-02-01T00:00:00Z"): NormalizedTx[] {
  return Array.from({ length: n }, (_, i) =>
    tx({
      signature: `sig_nft_buy_${i}`,
      protocol: "magic_eden",
      action: "nft_buy",
      blockTime: new Date(new Date(baseDate).getTime() + i * 60_000),
      meta: { mint: `MintA${i}` },
    }),
  );
}

function nftSells(n: number, baseDate = "2026-03-01T00:00:00Z"): NormalizedTx[] {
  return Array.from({ length: n }, (_, i) =>
    tx({
      signature: `sig_nft_sell_${i}`,
      protocol: "magic_eden",
      action: "nft_sell",
      blockTime: new Date(new Date(baseDate).getTime() + i * 60_000),
      meta: { mint: `MintB${i}` },
    }),
  );
}

function evaluate(txs: NormalizedTx[], now = NOW) {
  const out = evaluateAll({ txs, now });
  return new Map(out.map((r) => [r.badgeId, r]));
}

describe("first_swap", () => {
  it("eligible with one jupiter swap", () => {
    const r = evaluate(jupSwaps(1)).get("first_swap");
    expect(r).toBeDefined();
    expect(r?.eligibleSince).toEqual(jupSwaps(1)[0]?.blockTime);
  });

  it("not eligible without jupiter swaps", () => {
    expect(evaluate(nftBuys(3)).get("first_swap")).toBeUndefined();
  });
});

describe("jupiter_explorer (>=10 swaps)", () => {
  it("not eligible at 9", () => {
    expect(evaluate(jupSwaps(9)).get("jupiter_explorer")).toBeUndefined();
  });
  it("eligible at exactly 10", () => {
    const r = evaluate(jupSwaps(10)).get("jupiter_explorer");
    expect(r).toBeDefined();
    expect(r?.meta).toMatchObject({ count: 10 });
  });
  it("eligibleSince is the 10th tx (1-indexed)", () => {
    const ten = jupSwaps(15);
    const r = evaluate(ten).get("jupiter_explorer");
    expect(r?.eligibleSince).toEqual(ten[9]?.blockTime);
  });
});

describe("jupiter_power_user (>=50)", () => {
  it("not eligible at 49", () => {
    expect(evaluate(jupSwaps(49)).get("jupiter_power_user")).toBeUndefined();
  });
  it("eligible at 50", () => {
    expect(evaluate(jupSwaps(50)).get("jupiter_power_user")).toBeDefined();
  });
});

describe("swap_centurion (>=100)", () => {
  it("not eligible at 99", () => {
    expect(evaluate(jupSwaps(99)).get("swap_centurion")).toBeUndefined();
  });
  it("eligible at 100", () => {
    expect(evaluate(jupSwaps(100)).get("swap_centurion")).toBeDefined();
  });
});

describe("first_nft", () => {
  it("eligible with one nft buy", () => {
    expect(evaluate(nftBuys(1)).get("first_nft")).toBeDefined();
  });
  it("not eligible with only sells", () => {
    expect(evaluate(nftSells(3)).get("first_nft")).toBeUndefined();
  });
});

describe("nft_collector (>=10 distinct mints bought)", () => {
  it("not eligible at 9 distinct", () => {
    expect(evaluate(nftBuys(9)).get("nft_collector")).toBeUndefined();
  });
  it("eligible at 10 distinct", () => {
    expect(evaluate(nftBuys(10)).get("nft_collector")).toBeDefined();
  });
  it("does not double-count repeated mints", () => {
    const dup = nftBuys(5).map((t) => ({ ...t, meta: { mint: "SAME" } }));
    expect(evaluate(dup).get("nft_collector")).toBeUndefined();
  });
});

describe("nft_flipper (>=5 buys AND >=5 sells)", () => {
  it("not eligible at 5 buys, 4 sells", () => {
    expect(evaluate([...nftBuys(5), ...nftSells(4)]).get("nft_flipper")).toBeUndefined();
  });
  it("eligible at 5+5", () => {
    expect(evaluate([...nftBuys(5), ...nftSells(5)]).get("nft_flipper")).toBeDefined();
  });
});

describe("multi_protocol (jupiter swap AND magic_eden activity)", () => {
  it("eligible with one swap + one buy", () => {
    expect(evaluate([...jupSwaps(1), ...nftBuys(1)]).get("multi_protocol")).toBeDefined();
  });
  it("eligible with one swap + one sell", () => {
    expect(evaluate([...jupSwaps(1), ...nftSells(1)]).get("multi_protocol")).toBeDefined();
  });
  it("not eligible with only swaps", () => {
    expect(evaluate(jupSwaps(5)).get("multi_protocol")).toBeUndefined();
  });
  it("not eligible with only nft activity", () => {
    expect(evaluate(nftBuys(5)).get("multi_protocol")).toBeUndefined();
  });
});

describe("early_adopter (earliest tx > 365d old)", () => {
  it("eligible when oldest is 400d old", () => {
    const old = tx({ blockTime: new Date(NOW.getTime() - 400 * 86400_000) });
    expect(evaluate([old]).get("early_adopter")).toBeDefined();
  });
  it("not eligible when oldest is 360d old", () => {
    const recent = tx({ blockTime: new Date(NOW.getTime() - 360 * 86400_000) });
    expect(evaluate([recent]).get("early_adopter")).toBeUndefined();
  });
});

describe("active_trader (>=50 total)", () => {
  it("not eligible at 49 mixed", () => {
    expect(evaluate([...jupSwaps(25), ...nftBuys(24)]).get("active_trader")).toBeUndefined();
  });
  it("eligible at 50 mixed", () => {
    expect(evaluate([...jupSwaps(25), ...nftBuys(25)]).get("active_trader")).toBeDefined();
  });
});

describe("evaluateAll smoke", () => {
  it("returns multiple badges in one pass", () => {
    const all = evaluateAll({ txs: [...jupSwaps(50), ...nftBuys(10)], now: NOW });
    const ids = new Set(all.map((r) => r.badgeId));
    expect(ids.has("first_swap")).toBe(true);
    expect(ids.has("jupiter_explorer")).toBe(true);
    expect(ids.has("jupiter_power_user")).toBe(true);
    expect(ids.has("first_nft")).toBe(true);
    expect(ids.has("nft_collector")).toBe(true);
    expect(ids.has("multi_protocol")).toBe(true);
    expect(ids.has("active_trader")).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(evaluateAll({ txs: [], now: NOW })).toEqual([]);
  });
});
