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
  it("returns the full v2 badge catalog (13 protocol-tiered badges)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/badges" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      items: {
        id: string;
        name: string;
        description: string;
        protocol: string;
        tier: string;
        thresholdUsd: number | null;
        weight: number;
        previewFile: string;
        animationFile: string;
      }[];
    };
    expect(body.items).toHaveLength(13);
    for (const it of body.items) {
      expect(it.id.length).toBeGreaterThan(0);
      expect(it.name.length).toBeGreaterThan(0);
      expect(["jupiter", "pumpfun", "orca", "meteora", "seeker"]).toContain(it.protocol);
      expect(["bronze", "silver", "original", "single"]).toContain(it.tier);
      expect(it.previewFile.endsWith(".png")).toBe(true);
      expect(it.animationFile.endsWith(".gif")).toBe(true);
      expect(it.weight).toBeGreaterThan(0);
    }
  });

  it("includes the bronze Jupiter volume badge with $1k threshold", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/badges" });
    const body = JSON.parse(res.body) as {
      items: { id: string; protocol: string; tier: string; thresholdUsd: number | null }[];
    };
    const bronze = body.items.find((b) => b.id === "jupiter_volume_bronze");
    expect(bronze).toBeDefined();
    expect(bronze?.protocol).toBe("jupiter");
    expect(bronze?.tier).toBe("bronze");
    expect(bronze?.thresholdUsd).toBe(1_000);
  });

  it("seeker_genesis has no threshold (single-tier badge)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/badges" });
    const body = JSON.parse(res.body) as {
      items: { id: string; tier: string; thresholdUsd: number | null }[];
    };
    const seeker = body.items.find((b) => b.id === "seeker_genesis");
    expect(seeker).toBeDefined();
    expect(seeker?.tier).toBe("single");
    expect(seeker?.thresholdUsd).toBeNull();
  });

  it("sets a long Cache-Control", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/badges" });
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });
});
