/**
 * Create a Metaplex Token Metadata "Collection NFT" on the cluster pointed at
 * by SOLANA_RPC_URL, using MINT_AUTHORITY_PRIVATE_KEY as the signer + holder.
 *
 * Output: prints the new collection mint pubkey. Set this as
 * COLLECTION_ADDRESS in .env.production so future mints go through
 * mintToCollectionV1 instead of plain mintV1.
 *
 * Cost: ~0.01 SOL (mint account + metadata account + master edition account
 * rent), one-time. Recoverable if we ever close the collection.
 */
import { Keypair } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
} from "@metaplex-foundation/umi";
import {
  createNft,
  mplTokenMetadata,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import bs58 from "bs58";

const RPC = process.env["SOLANA_RPC_URL"];
const SECRET = process.env["MINT_AUTHORITY_PRIVATE_KEY"];
const METADATA_URI = process.env["COLLECTION_URI"];
if (!RPC || !SECRET || !METADATA_URI) {
  console.error("Set SOLANA_RPC_URL, MINT_AUTHORITY_PRIVATE_KEY, COLLECTION_URI");
  process.exit(1);
}

const authority = Keypair.fromSecretKey(bs58.decode(SECRET));
const umi = createUmi(RPC).use(mplTokenMetadata());
const umiKeypair = umi.eddsa.createKeypairFromSecretKey(authority.secretKey);
umi.use(keypairIdentity(umiKeypair));

const collectionMint = generateSigner(umi);
console.log("Authority         :", authority.publicKey.toBase58());
console.log("Creating collection at :", collectionMint.publicKey);
console.log("Metadata URI      :", METADATA_URI);

const tx = await createNft(umi, {
  mint: collectionMint,
  name: "OnchainMe Badges",
  symbol: "OCM",
  uri: METADATA_URI,
  sellerFeeBasisPoints: percentAmount(0),
  isCollection: true,
  tokenStandard: TokenStandard.NonFungible,
}).sendAndConfirm(umi);

console.log("Tx signature      :", bs58.encode(tx.signature));
console.log("COLLECTION_ADDRESS=" + collectionMint.publicKey);
