import {
  mintToCollectionV1,
  mintV1,
  TokenProgramVersion,
} from "@metaplex-foundation/mpl-bubblegum";
import {
  createNoopSigner,
  lamports as umiLamports,
  publicKey,
  type Umi,
} from "@metaplex-foundation/umi";
import { base64 } from "@metaplex-foundation/umi/serializers";
import { transferSol } from "@metaplex-foundation/mpl-toolbox";
import { loadEnv } from "../env.js";
import { createUmiClient } from "../solana/umi.js";
import { mintAuthorityPublicKey } from "../solana/keypair.js";
import { buildMetadataArgs } from "./metadata.js";
import type { MetadataArgsArgs } from "@metaplex-foundation/mpl-bubblegum";

const TX_TTL_MS = 5 * 60 * 1000;

export interface BuildMintInput {
  leafOwner: string;
  badgeId: string;
}

export interface BuildMintResult {
  transactionBase64: string;
  badgeId: string;
  expiresAt: string;
}

/**
 * Adapts the Task-3 MetadataArgs (which uses string literals like "NonFungible",
 * "Original") to the Bubblegum v5 MetadataArgsArgs shape (which needs numeric
 * enums from TokenStandard / TokenProgramVersion).
 *
 * We intentionally do NOT modify metadata.ts — the adaptation lives here.
 */
function toMetadataArgsArgs(badgeId: string): MetadataArgsArgs {
  const m = buildMetadataArgs(badgeId);
  return {
    name: m.name,
    symbol: m.symbol,
    uri: m.uri,
    sellerFeeBasisPoints: m.sellerFeeBasisPoints,
    primarySaleHappened: m.primarySaleHappened,
    isMutable: m.isMutable,
    // MetadataArgsArgs accepts OptionOrNullable<number> → null is fine for editionNonce
    editionNonce: null,
    // MetadataArgsArgs accepts OptionOrNullable<TokenStandardArgs> → null = no standard
    tokenStandard: null,
    // MetadataArgsArgs accepts OptionOrNullable<CollectionArgs> → null = no collection
    collection: null,
    // MetadataArgsArgs accepts OptionOrNullable<UsesArgs> → null = no uses
    uses: null,
    // TokenProgramVersion enum: Original = 0
    tokenProgramVersion: TokenProgramVersion.Original,
    creators: [],
  };
}

/**
 * Fetch the latest blockhash via `globalThis.fetch` (not web3.js Connection).
 *
 * Background: `@solana/web3.js` captures `globalThis.fetch` at module-load time
 * into a private `fetchImpl` variable (before MSW can patch it in tests). Using
 * `globalThis.fetch` directly here lets MSW's `FetchInterceptor` intercept the
 * call in test environments without needing to restart the process or alter the
 * import order.
 */
async function fetchLatestBlockhash(
  rpcUrl: string,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const response = await globalThis.fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestBlockhash",
      params: [{ commitment: "finalized" }],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `failed to get recent blockhash: Error: ${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }

  const json = (await response.json()) as {
    result: { value: { blockhash: string; lastValidBlockHeight: number } };
  };
  return json.result.value;
}

async function buildAndPartialSign(
  umi: Umi,
  leafOwnerB58: string,
  badgeId: string,
  rpcUrl: string,
): Promise<Uint8Array> {
  const env = loadEnv();
  const tree = publicKey(env.MERKLE_TREE_ADDRESS);
  const leafOwner = publicKey(leafOwnerB58);
  const metadata = toMetadataArgsArgs(badgeId);

  // Paid-mint pattern:
  //   - The leafOwner (user) is BOTH the tx-level fee payer AND the
  //     instruction-level `payer` for Bubblegum. The latter matters: mintV1's
  //     `payer` slot defaults to umi.identity (= mint authority), so without
  //     this explicit override the mint authority would still bleed lamports
  //     for any rent/compute reimbursement the program triggers.
  //   - umi.identity (mint authority) only co-signs as treeCreatorOrDelegate;
  //     no SOL leaves it. This makes minting a revenue stream rather than a
  //     recurring expense.
  // When MINT_PRICE_LAMPORTS=0 we skip the transfer ix entirely. We still
  // route `payer: userSigner` so behavior is uniform: user always pays gas.
  const userSigner = createNoopSigner(leafOwner);

  const collection = env.COLLECTION_ADDRESS;
  const mintBuilder = collection
    ? mintToCollectionV1(umi, {
        leafOwner,
        merkleTree: tree,
        collectionMint: publicKey(collection),
        metadata,
        payer: userSigner,
      })
    : mintV1(umi, {
        leafOwner,
        merkleTree: tree,
        metadata,
        payer: userSigner,
      });

  // Order instructions [mintV1, transferSol]:
  //   - Solscan/Solscan-like explorers classify the tx by the first
  //     "interesting" instruction. With transfer first you get "Send" in the
  //     history; with mint first you get "Mint" / "NFT Mint", which is what
  //     users expect to see.
  //   - Phantom's transaction history uses the same heuristic, so leading
  //     with mintV1 also improves how the activity shows up in-wallet.
  //   - Atomicity is unchanged — both ix in one tx, either both succeed or
  //     neither does. The transfer can't be skipped after a successful mint.
  const combined =
    env.MINT_PRICE_LAMPORTS > 0
      ? mintBuilder.add(
          transferSol(umi, {
            source: userSigner,
            destination: publicKey(env.CREATOR_ADDRESS),
            amount: umiLamports(env.MINT_PRICE_LAMPORTS),
          }),
        )
      : mintBuilder;

  // Fetch blockhash via globalThis.fetch so MSW can intercept it in tests
  // (web3.js captures globalThis.fetch at module-load time, before MSW patches it).
  const { blockhash, lastValidBlockHeight } = await fetchLatestBlockhash(rpcUrl);
  const builtTx = combined
    .setFeePayer(userSigner)
    .setBlockhash({ blockhash, lastValidBlockHeight })
    .build(umi);

  const signed = await umi.identity.signTransaction(builtTx);
  return umi.transactions.serialize(signed);
}

export async function buildMintTransaction(input: BuildMintInput): Promise<BuildMintResult> {
  // Validate leafOwner early — throws on invalid base58 / wrong length
  try {
    publicKey(input.leafOwner);
  } catch (err) {
    throw new Error(
      `Invalid leafOwner base58 pubkey: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Ensure mint authority env is configured (throws if MINT_AUTHORITY_PRIVATE_KEY missing)
  mintAuthorityPublicKey();

  const env = loadEnv();
  const umi = createUmiClient();
  const serialized = await buildAndPartialSign(umi, input.leafOwner, input.badgeId, env.SOLANA_RPC_URL);

  // base64.deserialize converts Uint8Array bytes → base64 string; returns [value, offset]
  const transactionBase64 = base64.deserialize(serialized)[0];

  return {
    transactionBase64,
    badgeId: input.badgeId,
    expiresAt: new Date(Date.now() + TX_TTL_MS).toISOString(),
  };
}
