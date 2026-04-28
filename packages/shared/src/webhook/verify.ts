import { timingSafeEqual } from "node:crypto";
import { loadEnv } from "../env.js";

export function verifyHeliusSecret(headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const expected = loadEnv().HELIUS_WEBHOOK_SECRET;
  const a = Buffer.from(headerValue, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
