import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";

const app = await buildServer();
await app.ready();

afterAll(async () => {
  await app.close();
});

const ROUTES_REQUIRING_RESPONSES = [
  ["GET", "/api/v1/health"],
  ["POST", "/api/v1/auth/nonce"],
  ["POST", "/api/v1/auth/verify"],
  ["GET", "/api/v1/auth/me"],
  ["POST", "/api/v1/auth/logout"],
  ["POST", "/api/v1/scan/{wallet}"],
  ["GET", "/api/v1/scan/job/{jobId}"],
  ["GET", "/api/v1/lands"],
  ["GET", "/api/v1/lands/{wallet}"],
  ["GET", "/api/v1/lands/{wallet}/inventory"],
  ["PUT", "/api/v1/placements/{wallet}"],
  ["POST", "/api/v1/mint/single"],
  ["POST", "/api/v1/mint/all"],
  ["POST", "/api/v1/mint/confirm"],
  ["POST", "/api/v1/webhooks/helius"],
] as const;

describe("OpenAPI document", () => {
  it("declares response schemas for every documented route", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };

    for (const [method, path] of ROUTES_REQUIRING_RESPONSES) {
      const op = doc.paths[path]?.[method.toLowerCase()];
      expect(op, `${method} ${path}`).toBeTruthy();
      // POST /auth/logout returns 204 (no body); POST /scan/:wallet returns 202; all others have 200
      let expectedCode: string;
      if (path === "/api/v1/auth/logout") {
        expectedCode = "204";
      } else if (path === "/api/v1/scan/{wallet}") {
        expectedCode = "202";
      } else {
        expectedCode = "200";
      }
      expect(Object.keys(op!.responses), `${method} ${path} responses`).toContain(expectedCode);
    }
  });

  it("declares 401/422 envelope for protected mint route", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const doc = res.json() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    const op = doc.paths["/api/v1/mint/single"]?.["post"];
    expect(Object.keys(op!.responses).sort()).toEqual(
      expect.arrayContaining(["200", "401", "409", "422", "503"]),
    );
  });
});
