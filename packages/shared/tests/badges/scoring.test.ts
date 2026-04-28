import { describe, it, expect } from "vitest";
import { score } from "../../src/badges/scoring.js";

describe("score", () => {
  it("returns 0 for empty input", () => {
    expect(score([])).toBe(0);
  });

  it("sums known badge weights", () => {
    expect(score(["first_swap", "first_nft"])).toBe(10 + 10);
    expect(score(["multi_protocol", "active_trader"])).toBe(25 + 40);
  });

  it("ignores unknown badge ids (forward-compatible if registry shrinks)", () => {
    expect(score(["first_swap", "ghost_badge" as never])).toBe(10);
  });

  it("counts duplicate ids only once (defensive: claims should be unique by PK anyway)", () => {
    expect(score(["first_swap", "first_swap"])).toBe(10);
  });
});
