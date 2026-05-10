import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis, connectDb } from "@onchainme/shared";

const app = await buildServer();
await connectDb();

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

describe("GET /admin/queues", () => {
  it("returns 401 without basic auth", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/queues" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with wrong credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/queues",
      headers: { authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with correct credentials", async () => {
    // Read whatever ADMIN_BASIC_AUTH the test process inherited from
    // .env.local (or env.ts's default "admin:change_me"). Reading from env
    // instead of hardcoding lets the test pass on any local config.
    const auth = process.env.ADMIN_BASIC_AUTH ?? "admin:change_me";
    const res = await app.inject({
      method: "GET",
      url: "/admin/queues",
      headers: { authorization: "Basic " + Buffer.from(auth).toString("base64") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>"); // Bull-Board renders an HTML page
  });
});
