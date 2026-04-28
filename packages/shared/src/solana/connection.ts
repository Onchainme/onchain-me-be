import { Connection } from "@solana/web3.js";
import { loadEnv } from "../env.js";

let cached: Connection | null = null;

export function getRpcConnection(): Connection {
  if (cached) return cached;
  const env = loadEnv();
  cached = new Connection(env.SOLANA_RPC_URL, { commitment: "confirmed" });
  return cached;
}

export function _resetConnectionCache(): void {
  cached = null;
}
