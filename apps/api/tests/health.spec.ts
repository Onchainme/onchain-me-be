import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis } from "@onchainme/shared";

const app = await buildServer();

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

describe("GET /api/v1/health", () => {
  it("returns 200 with ok=true when db and redis reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(body.redis).toBe("ok");
  });
});
