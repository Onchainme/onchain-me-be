import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis } from "@onchainme/shared";

const app = await buildServer();

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

describe("GET /api/v1/badges", () => {
  it("returns the full badge catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/badges" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      items: {
        id: string;
        name: string;
        description: string;
        iconUrl: string;
        tier: string;
        weight: number;
      }[];
    };
    expect(body.items).toHaveLength(10);
    for (const it of body.items) {
      expect(it.id.length).toBeGreaterThan(0);
      expect(it.name.length).toBeGreaterThan(0);
      expect(it.description.length).toBeGreaterThan(0);
      expect(it.iconUrl).toMatch(/\.svg$/);
      expect(["common", "rare", "epic", "legendary"]).toContain(it.tier);
      expect(it.weight).toBeGreaterThan(0);
    }
  });

  it("includes the well-known first_swap badge with the expected weight", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/badges" });
    const body = JSON.parse(res.body) as {
      items: { id: string; weight: number; tier: string }[];
    };
    const firstSwap = body.items.find((b) => b.id === "first_swap");
    expect(firstSwap).toBeDefined();
    expect(firstSwap?.weight).toBe(10);
    expect(firstSwap?.tier).toBe("common");
  });

  it("sets a long Cache-Control", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/badges" });
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });
});
