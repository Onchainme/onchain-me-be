/**
 * Patches an existing Token Metadata collection NFT to carry a sized
 * `collection_details` field. Required because `createNft({ isCollection: true })`
 * in mpl-token-metadata 3.x doesn't actually populate `collection_details` on
 * the metadata account — and without it Bubblegum's mintToCollectionV1 fails
 * with error 6021 ("CollectionNotFound on Metadata").
 *
 * Run once per collection mint, signed by the collection's update authority.
 */
import { Keypair } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  createSignerFromKeypair,
  publicKey,
  signerIdentity,
} from "@metaplex-foundation/umi";
import {
  findMetadataPda,
  mplTokenMetadata,
  setCollectionSize,
} from "@metaplex-foundation/mpl-token-metadata";
import bs58 from "bs58";

const RPC = process.env["SOLANA_RPC_URL"];
const SECRET = process.env["MINT_AUTHORITY_PRIVATE_KEY"];
const COLLECTION_MINT = process.env["COLLECTION_MINT"];

if (!RPC || !SECRET || !COLLECTION_MINT) {
  console.error("Set SOLANA_RPC_URL, MINT_AUTHORITY_PRIVATE_KEY, COLLECTION_MINT");
  process.exit(1);
}

const authorityKp = Keypair.fromSecretKey(bs58.decode(SECRET));
const umi = createUmi(RPC).use(mplTokenMetadata());
const authority = createSignerFromKeypair(
  umi,
  umi.eddsa.createKeypairFromSecretKey(authorityKp.secretKey),
);
umi.use(signerIdentity(authority));

const collectionMint = publicKey(COLLECTION_MINT);
const metadataPda = findMetadataPda(umi, { mint: collectionMint });

console.log("Authority         :", authorityKp.publicKey.toBase58());
console.log("Collection mint   :", COLLECTION_MINT);
console.log("Setting size = 0 …");

const tx = await setCollectionSize(umi, {
  collectionMetadata: metadataPda,
  collectionAuthority: authority,
  collectionMint,
  setCollectionSizeArgs: { size: 0 },
}).sendAndConfirm(umi);

console.log("Tx signature      :", bs58.encode(tx.signature));
console.log("Done. collection_details is now V1(size=0).");
