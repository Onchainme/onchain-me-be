import { Keypair } from "@solana/web3.js";
import type { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

let cached: Keypair | null = null;

function readSecretKey(): Uint8Array {
  const raw = process.env["MINT_AUTHORITY_PRIVATE_KEY"];
  if (!raw) throw new Error("MINT_AUTHORITY_PRIVATE_KEY is not set");
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(raw);
  } catch (err) {
    throw new Error(
      `MINT_AUTHORITY_PRIVATE_KEY is not valid base58: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (decoded.length !== 64) {
    throw new Error(
      `MINT_AUTHORITY_PRIVATE_KEY must decode to 64 bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

export function loadMintAuthority(): Keypair {
  if (cached) return cached;
  cached = Keypair.fromSecretKey(readSecretKey());
  return cached;
}

export function mintAuthorityPublicKey(): PublicKey {
  return loadMintAuthority().publicKey;
}

// Test-only: clears the cached keypair so subsequent calls re-read env
export function _resetMintAuthorityCache(): void {
  cached = null;
}
