import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, type Umi } from "@metaplex-foundation/umi";
import { mplBubblegum } from "@metaplex-foundation/mpl-bubblegum";
import { loadEnv } from "../env.js";
import { loadMintAuthority } from "./keypair.js";

let cached: Umi | null = null;

export function createUmiClient(): Umi {
  if (cached) return cached;
  const env = loadEnv();
  const umi = createUmi(env.SOLANA_RPC_URL).use(mplBubblegum());

  const authority = loadMintAuthority();
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(authority.secretKey);
  umi.use(keypairIdentity(umiKeypair));

  cached = umi;
  return cached;
}

export function _resetUmiCache(): void {
  cached = null;
}
