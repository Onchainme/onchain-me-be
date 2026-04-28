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
    // .env.local sets ADMIN_BASIC_AUTH=admin:local (per Task 1 step 2)
    const res = await app.inject({
      method: "GET",
      url: "/admin/queues",
      headers: { authorization: "Basic " + Buffer.from("admin:local").toString("base64") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>"); // Bull-Board renders an HTML page
  });
});
