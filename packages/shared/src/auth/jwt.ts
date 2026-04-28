import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface SessionPayload extends JWTPayload {
  wallet: string;
}

function getSecretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

export interface IssueOpts {
  wallet: string;
  ttlSeconds: number;
}

export async function issueSessionJwt(opts: IssueOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ wallet: opts.wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + opts.ttlSeconds)
    .sign(getSecretKey());
}

export async function verifySessionJwt(
  token: string,
): Promise<SessionPayload & { iat: number; exp: number }> {
  const { payload } = await jwtVerify(token, getSecretKey(), {
    algorithms: ["HS256"],
  });
  if (typeof payload.wallet !== "string") {
    throw new Error("invalid session payload: missing wallet claim");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("invalid session payload: missing iat/exp");
  }
  return payload as SessionPayload & { iat: number; exp: number };
}
