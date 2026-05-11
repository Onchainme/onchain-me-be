import { describe, it, expect } from "vitest";
import { REGISTRY, ALL_BADGE_IDS } from "../../src/badges/registry.js";

describe("REGISTRY (v2: protocol-tiered)", () => {
  it("has exactly 13 badges (3 Jupiter + 3 Pump.fun + 3 Orca + 3 Meteora + 1 Seeker)", () => {
    expect(ALL_BADGE_IDS).toHaveLength(13);
  });

  it("every badge id matches its key in REGISTRY", () => {
    for (const id of ALL_BADGE_IDS) {
      expect(REGISTRY[id]?.id).toBe(id);
    }
  });

  it("every badge has a positive integer weight", () => {
    for (const id of ALL_BADGE_IDS) {
      const w = REGISTRY[id]?.weight;
      expect(typeof w).toBe("number");
      expect(w).toBeGreaterThan(0);
      expect(Number.isInteger(w)).toBe(true);
    }
  });

  it("volume tiers ($1k/$10k/$100k) have correct thresholds", () => {
    expect(REGISTRY.jupiter_volume_bronze.thresholdUsd).toBe(1_000);
    expect(REGISTRY.jupiter_volume_silver.thresholdUsd).toBe(10_000);
    expect(REGISTRY.jupiter_volume_original.thresholdUsd).toBe(100_000);
    expect(REGISTRY.pumpfun_volume_bronze.thresholdUsd).toBe(1_000);
    expect(REGISTRY.pumpfun_volume_original.thresholdUsd).toBe(100_000);
  });

  it("position tiers have correct thresholds", () => {
    expect(REGISTRY.orca_position_bronze.thresholdUsd).toBe(1_000);
    expect(REGISTRY.orca_position_original.thresholdUsd).toBe(100_000);
    expect(REGISTRY.meteora_position_silver.thresholdUsd).toBe(10_000);
  });

  it("seeker_genesis has no threshold (single tier)", () => {
    expect(REGISTRY.seeker_genesis.thresholdUsd).toBeNull();
    expect(REGISTRY.seeker_genesis.tier).toBe("single");
  });

  it("each badge has plausible image asset paths", () => {
    // After PR #1 we switched from GIF to PNG/WebP. Some animationFile
    // entries are PNG (static), some are WebP (animated). The narrow assertion
    // would force a future re-encode to update this test; instead check the
    // shape: filename is non-empty and ends in a known image extension.
    const ALLOWED = [".png", ".webp", ".jpg", ".jpeg", ".gif"];
    for (const id of ALL_BADGE_IDS) {
      const def = REGISTRY[id];
      expect(ALLOWED.some((ext) => def.previewFile.endsWith(ext))).toBe(true);
      expect(ALLOWED.some((ext) => def.animationFile.endsWith(ext))).toBe(true);
    }
  });

  it("on-chain name (def.name) fits Metaplex 32-byte limit", () => {
    // Metaplex Token Metadata caps name at 32 bytes; our display names are
    // baked into the mint instruction via mint/metadata.ts → shortNameFor().
    for (const id of ALL_BADGE_IDS) {
      expect(REGISTRY[id].name.length).toBeLessThanOrEqual(32);
    }
  });
});
