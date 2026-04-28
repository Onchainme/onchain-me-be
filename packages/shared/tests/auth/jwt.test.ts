import { describe, it, expect, beforeEach } from "vitest";
import { issueSessionJwt, verifySessionJwt } from "../../src/auth/jwt.js";

const SECRET = "x".repeat(32);

describe("issueSessionJwt + verifySessionJwt", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  it("issues a token that verifies with the same secret and returns the wallet", async () => {
    const token = await issueSessionJwt({ wallet: "ABC", ttlSeconds: 3600 });
    const payload = await verifySessionJwt(token);
    expect(payload.wallet).toBe("ABC");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await issueSessionJwt({ wallet: "ABC", ttlSeconds: 3600 });
    process.env.JWT_SECRET = "y".repeat(32);
    await expect(verifySessionJwt(token)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const token = await issueSessionJwt({ wallet: "ABC", ttlSeconds: 3600 });
    const tampered = token.slice(0, -2) + "AB";
    await expect(verifySessionJwt(tampered)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await issueSessionJwt({ wallet: "ABC", ttlSeconds: -1 });
    await expect(verifySessionJwt(token)).rejects.toThrow();
  });
});
