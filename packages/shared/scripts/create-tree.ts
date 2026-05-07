import { Keypair } from "@solana/web3.js";
import { createTree, mplBubblegum } from "@metaplex-foundation/mpl-bubblegum";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, generateSigner } from "@metaplex-foundation/umi";
import bs58 from "bs58";

const RPC = process.env.SOLANA_RPC_URL;
const SECRET = process.env.MINT_AUTHORITY_PRIVATE_KEY;
if (!RPC || !SECRET) {
  console.error("Set SOLANA_RPC_URL and MINT_AUTHORITY_PRIVATE_KEY");
  process.exit(1);
}

const authority = Keypair.fromSecretKey(bs58.decode(SECRET));
const umi = createUmi(RPC).use(mplBubblegum());
const umiKeypair = umi.eddsa.createKeypairFromSecretKey(authority.secretKey);
umi.use(keypairIdentity(umiKeypair));

const merkleTree = generateSigner(umi);
console.log("Authority:", authority.publicKey.toBase58());
console.log("Creating tree at:", merkleTree.publicKey);

const tx = await createTree(umi, {
  merkleTree,
  maxDepth: 14,
  maxBufferSize: 64,
  canopyDepth: 10,
}).then((b) => b.sendAndConfirm(umi));

console.log("Tree created. Signature:", bs58.encode(tx.signature));
console.log("MERKLE_TREE_ADDRESS=" + merkleTree.publicKey);
