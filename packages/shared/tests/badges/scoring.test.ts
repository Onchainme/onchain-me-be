import { describe, it, expect } from "vitest";
import { score } from "../../src/badges/scoring.js";
import { REGISTRY } from "../../src/badges/registry.js";

describe("score", () => {
  it("returns 0 for empty input", () => {
    expect(score([])).toBe(0);
  });

  it("sums known badge weights from the v2 registry", () => {
    const bronze = REGISTRY.jupiter_volume_bronze.weight; // 100
    const silver = REGISTRY.jupiter_volume_silver.weight; // 250
    const seeker = REGISTRY.seeker_genesis.weight;        // 500
    expect(score(["jupiter_volume_bronze", "jupiter_volume_silver"])).toBe(bronze + silver);
    expect(score(["seeker_genesis"])).toBe(seeker);
  });

  it("ignores unknown badge ids (forward-compatible if registry shrinks)", () => {
    const bronze = REGISTRY.jupiter_volume_bronze.weight;
    expect(score(["jupiter_volume_bronze", "ghost_badge" as never])).toBe(bronze);
  });

  it("counts duplicate ids only once (defensive: claims should be unique by PK anyway)", () => {
    const bronze = REGISTRY.jupiter_volume_bronze.weight;
    expect(score(["jupiter_volume_bronze", "jupiter_volume_bronze"])).toBe(bronze);
  });
});
