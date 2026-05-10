import { describe, it, expect } from "vitest";
import { evaluateAll } from "../../src/badges/evaluate.js";
import type { BadgeEvalContext } from "../../src/badges/types.js";

function baseCtx(overrides: Partial<BadgeEvalContext> = {}): BadgeEvalContext {
  return {
    protocolVolumeUsd: { jupiter: 0, pumpfun: 0 },
    positionUsd: { orca: 0, meteora: 0 },
    seekerHeld: false,
    now: new Date("2026-05-10T00:00:00Z"),
    ...overrides,
  };
}

function ids(results: ReturnType<typeof evaluateAll>): Set<string> {
  return new Set(results.map((r) => r.badgeId));
}

describe("evaluateAll (v2: snapshot-based)", () => {
  it("zero state yields no badges", () => {
    expect(evaluateAll(baseCtx())).toEqual([]);
  });

  describe("Jupiter volume tiers", () => {
    it("$999 → none", () => {
      const r = evaluateAll(baseCtx({ protocolVolumeUsd: { jupiter: 999, pumpfun: 0 } }));
      expect(ids(r).size).toBe(0);
    });

    it("$1,000 → bronze only", () => {
      const r = evaluateAll(baseCtx({ protocolVolumeUsd: { jupiter: 1_000, pumpfun: 0 } }));
      expect(ids(r)).toEqual(new Set(["jupiter_volume_bronze"]));
    });

    it("$10,000 → bronze + silver (lower tiers stay earned)", () => {
      const r = evaluateAll(baseCtx({ protocolVolumeUsd: { jupiter: 10_000, pumpfun: 0 } }));
      expect(ids(r)).toEqual(
        new Set(["jupiter_volume_bronze", "jupiter_volume_silver"]),
      );
    });

    it("$250,000 → all 3 Jupiter tiers", () => {
      const r = evaluateAll(baseCtx({ protocolVolumeUsd: { jupiter: 250_000, pumpfun: 0 } }));
      expect(ids(r)).toEqual(
        new Set([
          "jupiter_volume_bronze",
          "jupiter_volume_silver",
          "jupiter_volume_original",
        ]),
      );
    });
  });

  describe("Pump.fun is independent of Jupiter", () => {
    it("only Pump.fun volume → only Pump.fun badges", () => {
      const r = evaluateAll(baseCtx({ protocolVolumeUsd: { jupiter: 0, pumpfun: 50_000 } }));
      expect(ids(r)).toEqual(
        new Set(["pumpfun_volume_bronze", "pumpfun_volume_silver"]),
      );
    });
  });

  describe("LP position tiers", () => {
    it("Orca $5k → Orca bronze only", () => {
      const r = evaluateAll(baseCtx({ positionUsd: { orca: 5_000, meteora: 0 } }));
      expect(ids(r)).toEqual(new Set(["orca_position_bronze"]));
    });

    it("Meteora $200k → all 3 Meteora tiers", () => {
      const r = evaluateAll(baseCtx({ positionUsd: { orca: 0, meteora: 200_000 } }));
      expect(ids(r)).toEqual(
        new Set([
          "meteora_position_bronze",
          "meteora_position_silver",
          "meteora_position_original",
        ]),
      );
    });
  });

  describe("Seeker NFT", () => {
    it("seekerHeld=false → no seeker badge", () => {
      const r = evaluateAll(baseCtx({ seekerHeld: false }));
      expect(ids(r).has("seeker_genesis")).toBe(false);
    });

    it("seekerHeld=true → seeker_genesis present", () => {
      const r = evaluateAll(baseCtx({ seekerHeld: true }));
      expect(ids(r).has("seeker_genesis")).toBe(true);
    });
  });

  it("combined: a power user gets badges from every dimension", () => {
    const r = evaluateAll(
      baseCtx({
        protocolVolumeUsd: { jupiter: 200_000, pumpfun: 5_000 },
        positionUsd: { orca: 12_000, meteora: 800 },
        seekerHeld: true,
      }),
    );
    expect(ids(r)).toEqual(
      new Set([
        "jupiter_volume_bronze",
        "jupiter_volume_silver",
        "jupiter_volume_original",
        "pumpfun_volume_bronze",
        "orca_position_bronze",
        "orca_position_silver",
        // meteora $800 < $1k → none
        "seeker_genesis",
      ]),
    );
  });

  it("eligibleSince uses ctx.now (snapshot semantics)", () => {
    const now = new Date("2026-05-10T12:34:56Z");
    const r = evaluateAll(
      baseCtx({ now, protocolVolumeUsd: { jupiter: 1_000, pumpfun: 0 } }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.eligibleSince.toISOString()).toBe(now.toISOString());
  });
});
