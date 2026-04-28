import { getRedisConnection } from "../queue/connection.js";

const KEY = "onchainme:mint_disabled";

export async function isMintDegraded(): Promise<boolean> {
  const v = await getRedisConnection().get(KEY);
  return v !== null && v !== "";
}

export async function setMintDegraded(reason: string, ttlSeconds: number): Promise<void> {
  await getRedisConnection().set(KEY, reason, "EX", ttlSeconds);
}

export async function clearMintDegraded(): Promise<void> {
  await getRedisConnection().del(KEY);
}
