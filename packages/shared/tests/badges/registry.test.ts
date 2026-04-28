import { describe, it, expect } from "vitest";
import { REGISTRY, ALL_BADGE_IDS } from "../../src/badges/registry.js";

describe("REGISTRY", () => {
  it("has exactly 10 badges", () => {
    expect(ALL_BADGE_IDS).toHaveLength(10);
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
});
