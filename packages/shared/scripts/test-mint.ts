import { Connection, VersionedTransaction } from "@solana/web3.js";
import { buildMintTransaction } from "../src/mint/prepare.js";

const RECIPIENT = process.env.LEAF_OWNER ?? "GUiWgUUUhgqwP3ik6dWLrT2th8R6EXwruzMhFdNm5yxm";
const BADGE = process.env.BADGE_ID ?? "first_swap";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

console.log(`Building mint tx: leafOwner=${RECIPIENT} badge=${BADGE}`);
const built = await buildMintTransaction({ leafOwner: RECIPIENT, badgeId: BADGE });
console.log(`Got tx: ${built.transactionBase64.length} chars b64, expiresAt=${built.expiresAt}`);

const bytes = Buffer.from(built.transactionBase64, "base64");
const tx = VersionedTransaction.deserialize(bytes);
console.log(`Tx version=${tx.version}, signatures=${tx.signatures.length}`);
console.log(`Static account keys (${tx.message.staticAccountKeys.length}):`);
for (const k of tx.message.staticAccountKeys) console.log("  -", k.toBase58());
console.log(`Header: required=${tx.message.header.numRequiredSignatures}, ro_signed=${tx.message.header.numReadonlySignedAccounts}, ro_unsigned=${tx.message.header.numReadonlyUnsignedAccounts}`);

const conn = new Connection(RPC, "confirmed");
console.log("\nSimulating...");
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
console.log("Logs:");
for (const l of sim.value.logs ?? []) console.log("  ", l);
console.log("Err:", JSON.stringify(sim.value.err));
console.log("UnitsConsumed:", sim.value.unitsConsumed);

if (!sim.value.err) {
  console.log("\nSubmitting (mint authority is fee payer + only signer)...");
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("Signature:", sig);
}
