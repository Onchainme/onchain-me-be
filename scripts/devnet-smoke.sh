#!/usr/bin/env bash
set -euo pipefail

# OnchainMe devnet smoke test
# Exercises SIWS auth + scan + (mint+confirm if eligible) end-to-end against a running api+worker.
# Pre-requisites: api on :3001, worker running, mongo+redis up, .env.local has real Helius key
# + funded MINT_AUTHORITY_PRIVATE_KEY + valid MERKLE_TREE_ADDRESS.

API="${API:-http://localhost:3001/api/v1}"
COOKIES=$(mktemp)
KEYFILE="${KEYFILE:-}"
trap 'rm -f "$COOKIES"' EXIT

echo "=== devnet smoke test — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. Generate (or reuse) test wallet
if [ -z "$KEYFILE" ]; then
  KEYFILE=$(mktemp --suffix=.json 2>/dev/null || mktemp -t smoke.XXXXXX.json)
  solana-keygen new -o "$KEYFILE" --no-bip39-passphrase --force --silent > /dev/null
fi
WALLET=$(solana-keygen pubkey "$KEYFILE")
echo "Test wallet: $WALLET"

# 2. SIWS nonce
NONCE_RES=$(curl -sf -X POST "$API/auth/nonce" -H 'content-type: application/json' \
  -d "{\"wallet\":\"$WALLET\"}")
NONCE=$(echo "$NONCE_RES" | jq -r .nonce)
MESSAGE=$(echo "$NONCE_RES" | jq -r .message)
echo "Got nonce: ${NONCE:0:8}..."

# 3. Sign with test keypair
SIG=$(node -e "
  const fs=require('fs'), bs58=require('bs58').default, nacl=require('tweetnacl');
  const secret=Uint8Array.from(JSON.parse(fs.readFileSync('$KEYFILE')));
  const sig=nacl.sign.detached(new TextEncoder().encode(\`$MESSAGE\`), secret);
  console.log(bs58.encode(sig));
")

# 4. Verify → cookie
curl -sf -X POST "$API/auth/verify" -H 'content-type: application/json' \
  -c "$COOKIES" \
  -d "{\"wallet\":\"$WALLET\",\"nonce\":\"$NONCE\",\"signature\":\"$SIG\"}" > /dev/null
echo "Authenticated."

# 5. Trigger scan
SCAN_RES=$(curl -sf -X POST "$API/scan/$WALLET?mode=full" -b "$COOKIES")
JOB_ID=$(echo "$SCAN_RES" | jq -r .jobId)
echo "Scan enqueued: $JOB_ID"

# Poll until done (max 60s)
for _ in $(seq 1 30); do
  STATUS=$(curl -sf "$API/scan/job/$JOB_ID" -b "$COOKIES" | jq -r .status)
  [ "$STATUS" = "done" ] && break
  [ "$STATUS" = "failed" ] && { echo "Scan failed."; exit 1; }
  sleep 2
done
echo "Scan complete."

# 6. List eligibilities
ELIG=$(curl -sf "$API/lands/$WALLET/inventory" -b "$COOKIES" | jq '.eligibilities | length')
echo "Eligibilities: $ELIG"

if [ "$ELIG" -eq 0 ]; then
  echo "Fresh wallet has no eligibilities — exercising the 422 path..."
  RC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/mint/single" \
    -H 'content-type: application/json' -b "$COOKIES" \
    -d '{"badgeId":"first_swap"}')
  if [ "$RC" = "422" ]; then
    echo "  ✓ 422 BADGE_NOT_ELIGIBLE"
  else
    echo "  ✗ Expected 422 got $RC"; exit 1
  fi
else
  # 7. /mint/single → base64 tx
  BADGE=$(curl -sf "$API/lands/$WALLET/inventory" -b "$COOKIES" | jq -r '.eligibilities[0].badgeId')
  echo "Minting badge: $BADGE"
  TX_RES=$(curl -sf -X POST "$API/mint/single" -H 'content-type: application/json' -b "$COOKIES" \
    -d "{\"badgeId\":\"$BADGE\"}")
  TX_B64=$(echo "$TX_RES" | jq -r .transaction)

  # 8. Sign + send
  MINT_SIG=$(node -e "
    const fs=require('fs'), bs58=require('bs58').default;
    const { VersionedTransaction, Keypair, Connection } = require('@solana/web3.js');
    (async () => {
      const tx = VersionedTransaction.deserialize(Buffer.from('$TX_B64', 'base64'));
      const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('$KEYFILE'))));
      tx.sign([owner]);
      const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
      const sig = await conn.sendTransaction(tx);
      console.log(sig);
    })().catch(e => { console.error(e); process.exit(1); });
  ")
  echo "Sent: $MINT_SIG"

  # 9. Wait + confirm
  sleep 6
  CONFIRM=$(curl -sf -X POST "$API/mint/confirm" -H 'content-type: application/json' -b "$COOKIES" \
    -d "{\"signature\":\"$MINT_SIG\",\"badgeId\":\"$BADGE\"}")
  echo "Confirmed: $(echo "$CONFIRM" | jq -c .)"

  # 10. Idempotency
  CONFIRM2=$(curl -sf -X POST "$API/mint/confirm" -H 'content-type: application/json' -b "$COOKIES" \
    -d "{\"signature\":\"$MINT_SIG\",\"badgeId\":\"$BADGE\"}")
  ALREADY=$(echo "$CONFIRM2" | jq -r .alreadyClaimed)
  if [ "$ALREADY" = "true" ]; then
    echo "  ✓ Idempotent"
  else
    echo "  ✗ Expected alreadyClaimed=true, got $ALREADY"; exit 1
  fi
fi

echo "=== smoke OK ==="
