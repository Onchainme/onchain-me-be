# OnchainMe Backend

Backend for OnchainMe — turns a Solana wallet's on-chain activity into a visual "land" with NFT achievement badges.

See the design spec at [`docs/superpowers/specs/2026-04-27-onchainme-backend-design.md`](docs/superpowers/specs/2026-04-27-onchainme-backend-design.md).

## Stack

- Node 20+ / TypeScript 5.5 (strict)
- Fastify 5 + Zod (`fastify-type-provider-zod`)
- Mongoose 8 + MongoDB 7 (single-node replica set for transactions)
- BullMQ + Redis 7
- pnpm 9 monorepo (`apps/api`, `apps/worker`, `packages/shared`)

## Quick start

```bash
# 1. Bring up Mongo (replica set) + Redis
docker-compose up -d

# 2. Install deps and copy env
pnpm install
cp .env.example .env.local

# 3. Wait ~30 sec for replica set to initialize, then sync indexes
pnpm db:sync-indexes

# 4. Start api and worker (two terminals)
pnpm dev:api      # http://localhost:3001/api/v1/health
pnpm dev:worker

# Verify
curl http://localhost:3001/api/v1/health
# → {"ok":true,"db":"ok","redis":"ok"}
```

## Try a real scan locally

Once both `pnpm dev:api` and `pnpm dev:worker` are running, and `HELIUS_API_KEY` in `.env.local` is a real key (Helius free tier — https://dev.helius.xyz):

```bash
# 1. Generate a test keypair (or reuse your own funded devnet wallet)
solana-keygen new -o /tmp/test.json --no-bip39-passphrase --force
WALLET=$(solana-keygen pubkey /tmp/test.json)

# 2. Get a SIWS challenge
RESP=$(curl -s -X POST http://localhost:3001/api/v1/auth/nonce \
  -H 'content-type: application/json' \
  -d "{\"wallet\":\"$WALLET\"}")
NONCE=$(echo $RESP | jq -r .nonce)
MSG=$(echo $RESP | jq -r .message)

# 3. Sign the message
SIG=$(solana sign-offchain-message -k /tmp/test.json "$MSG" 2>/dev/null | head -1)

# 4. Verify and capture cookie
curl -s -X POST http://localhost:3001/api/v1/auth/verify \
  -H 'content-type: application/json' \
  -c /tmp/cookies.txt \
  -d "{\"wallet\":\"$WALLET\",\"nonce\":\"$NONCE\",\"signature\":\"$SIG\"}"

# 5. Trigger a scan
JOB=$(curl -s -X POST "http://localhost:3001/api/v1/scan/$WALLET?mode=full" -b /tmp/cookies.txt | jq -r .jobId)

# 6. Poll
watch -n 1 "curl -s http://localhost:3001/api/v1/scan/job/$JOB -b /tmp/cookies.txt | jq"
```

After ~30s for a fresh wallet (or longer for active wallets, capped at 5K txs), the job's `status` becomes `done` and `db.txs.find({walletAddress: "<wallet>"})` returns the parsed Jupiter swaps and Magic Eden NFT events.

## What you get after a scan

The worker writes three things per scanned wallet:
- `txs` — normalized transaction rows (jupiter swaps, magic-eden buys/sells)
- `txRawCache` — raw Helius response for offline rule re-evaluation
- `badgeEligibilities` — every badge the wallet currently qualifies for

The 10 alpha badges and their weights live in
[`packages/shared/src/badges/registry.ts`](./packages/shared/src/badges/registry.ts).

## Reading a wallet's land

```bash
curl -s http://localhost:3001/api/v1/lands/$WALLET | jq
```

Returns `{wallet, stats: {protocols, transactions, score}, placements, ogImageUrl}`.
The score is computed as the sum of `weight` for every `badgeClaim` (claimed badges only — eligibilities don't count toward the score until minted in Plan 4).

## Editing your land

Logged-in users (cookie from `/auth/verify`) can:

```bash
# See what you've claimed and what you can mint:
curl -s http://localhost:3001/api/v1/lands/$WALLET/inventory -b /tmp/cookies.txt | jq

# Place objects on your grid (full bulk replace, atomic):
curl -X PUT http://localhost:3001/api/v1/placements/$WALLET \
  -H 'content-type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"placements":[{"badgeId":"first_swap","x":0,"y":0}]}'

# Remove one:
curl -X DELETE http://localhost:3001/api/v1/placements/$WALLET/first_swap \
  -b /tmp/cookies.txt
```

## Minting your badges (devnet checklist)

### One-time setup (devnet)

1. **Generate a mint-authority keypair** (if you don't have one):

```bash
solana-keygen new --outfile my-devnet-wallet.json
```

2. **Encode the secret key as base58** (the env var format):

```bash
node -e "
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(require('fs').readFileSync('my-devnet-wallet.json')))
);
console.log(bs58.encode(kp.secretKey));
"
```

Add the result to `.env.local` as `MINT_AUTHORITY_PRIVATE_KEY=<base58>`.

3. **Airdrop SOL** (devnet only):

```bash
solana airdrop 2 <MINT_AUTHORITY_PUBKEY> --url devnet
```

4. **Create the compressed-NFT Merkle tree** (one time per environment):

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com \
MINT_AUTHORITY_PRIVATE_KEY=<base58> \
node --import tsx scripts/create-tree.ts
```

The script prints:

```
Creating tree at: <TREE_PUBKEY>
Tree created. Signature: <SIG>
Set MERKLE_TREE_ADDRESS=<TREE_PUBKEY> in your .env.local
```

Add `MERKLE_TREE_ADDRESS=<TREE_PUBKEY>` to `.env.local`.

5. **Set `METADATA_BASE_URL`** — the public URL prefix where badge JSON metadata is served (e.g. `https://your-api.example.com/api/v1/metadata`).  Add it to `.env.local`.

### Running the mint flow

```bash
WALLET=<RECIPIENT_WALLET_ADDRESS>

# 1. Request a mint transaction (returns a base64 serialized transaction):
curl -s -X POST http://localhost:3001/api/v1/mint/single \
  -H 'content-type: application/json' \
  -d "{\"wallet\":\"$WALLET\",\"badgeId\":\"first_swap\"}" | jq

# 2. Sign + send (frontend step):
#    Deserialize the base64 transaction, sign it with the user's wallet,
#    and send it via sendRawTransaction. The returned signature is needed
#    for confirmation.

# 3. Confirm the mint (poll until status is "confirmed" or "failed"):
curl -s -X POST http://localhost:3001/api/v1/mint/confirm \
  -H 'content-type: application/json' \
  -d '{"signature":"<TX_SIGNATURE>"}' | jq
```

### Webhook setup (devnet, optional)

Configure a Helius devnet webhook at <https://dev.helius.xyz> to point at:

```
https://<your-public-url>/webhooks/helius
```

Set `HELIUS_WEBHOOK_SECRET=<secret>` (matching the Helius dashboard value) in `.env.local`.  The worker `/webhooks/helius` handler will update `badgeClaim.mintStatus` in real time as transactions confirm on-chain.

### Mint authority balance monitoring

The BullMQ worker runs a `checkBalance` job (repeatable, every 5 minutes) via the balance worker. If the mint authority drops below `MINT_BALANCE_WARN_THRESHOLD_SOL` (default 0.1 SOL), the job logs a warning. Monitor logs or wire an alert to the warning line:

```
[balance-worker] Low balance: <N> SOL — top up <PUBKEY>
```

### Manual test checklist

- [ ] `SOLANA_RPC_URL` reachable and returning latest blockhash
- [ ] `MINT_AUTHORITY_PRIVATE_KEY` decodes without error
- [ ] `MERKLE_TREE_ADDRESS` exists on-chain (check with `solana account <ADDR> --url devnet`)
- [ ] `METADATA_BASE_URL/<badgeId>` returns valid JSON with `name`, `symbol`, `image`, `attributes`
- [ ] `/api/v1/mint/single` returns 200 with a `transaction` field
- [ ] Signed transaction lands on-chain (visible in Solana Explorer / devnet)
- [ ] `/api/v1/mint/confirm` returns `{"status":"confirmed"}` after tx finalises
- [ ] Helius webhook fires and `badgeClaim.mintStatus` transitions to `"minted"` in MongoDB
- [ ] Balance worker logs no unexpected errors; balance alert fires when SOL < threshold

### Devnet smoke runbook

`scripts/devnet-smoke.sh` automates the SIWS → scan → (mint+confirm if eligible) loop. Run with api+worker up:

```bash
./scripts/devnet-smoke.sh
# Or reuse an existing keypair:
KEYFILE=/path/to/wallet.json ./scripts/devnet-smoke.sh
```

A fresh wallet has no on-chain history → exercises the 422 `BADGE_NOT_ELIGIBLE` path. Pass a wallet with Jupiter/ME activity to exercise the full mint loop.

#### Run history

| Date | Result | Notes |
|---|---|---|
| TBD | TBD | First Plan 5 run |

## Useful scripts

- `pnpm typecheck` — TypeScript across the monorepo
- `pnpm lint` — ESLint
- `pnpm test` — Vitest run
- `pnpm test:watch` — Vitest watch
- `pnpm build` — Build all packages
- `pnpm db:sync-indexes` — Sync Mongoose indexes to MongoDB (idempotent; safe to re-run)

## Production deploy (Railway + Atlas + Upstash)

Alpha is sized for free-tier infra. Costs ~$0/month at the user volumes we expect (< 1000 daily active wallets).

### 1. MongoDB Atlas (M0 free tier)

- Create a free cluster at https://cloud.mongodb.com.
- Network access: add `0.0.0.0/0` (Railway egress IPs are dynamic on free tier).
- Database user: `onchainme-app` with `readWrite` on the `onchainme` DB.
- Get the SRV connection string. Atlas SRV strings already include `?retryWrites=true&w=majority` — append `&replicaSet=atlas-xxx-shard-0` if the spec demands it (it does for our multi-doc transactions).
- After deploy, run `pnpm db:sync-indexes` once against the Atlas URI.

### 2. Upstash Redis

- Create a free Redis instance at https://upstash.com.
- Use the **TLS-enabled** connection string (`rediss://...`).
- BullMQ + ioredis support TLS without extra config.

### 3. Helius

- Free Developer plan at https://dev.helius.xyz.
- Generate an API key. The mainnet Enhanced API has a 10/sec rate limit on free — fine for alpha.
- Create a webhook (Helius dashboard) pointing to `https://<your-domain>/api/v1/webhooks/helius`. Header: `Authorization: <HELIUS_WEBHOOK_SECRET>`. Filter by your `MERKLE_TREE_ADDRESS`.

### 4. Sentry

- Create a project at https://sentry.io. Choose "Node.js" stack.
- Copy the DSN.
- Set `SERVICE_VERSION` to your git SHA via Railway's `RAILWAY_GIT_COMMIT_SHA` build var.

### 5. Railway

Two services from the same repo:

**api service:**
- Dockerfile path: `apps/api/Dockerfile`
- Public domain: `api.your-domain.xyz`
- Health check: `/api/v1/health`
- Env vars: see checklist below

**worker service:**
- Dockerfile path: `apps/worker/Dockerfile`
- Public domain: none (internal only)
- Health check: none (process-up is enough)
- Env vars: same as api

### 6. Env-var checklist

Set on both services:

| Var | Value |
|---|---|
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `PORT` | `3001` (api) / unused (worker) |
| `MONGODB_URI` | Atlas SRV string |
| `REDIS_URL` | Upstash `rediss://...` |
| `JWT_SECRET` | 32+ char random — `openssl rand -base64 48` |
| `COOKIE_DOMAIN` | `your-domain.xyz` |
| `FRONTEND_ORIGIN` | `https://app.your-domain.xyz` |
| `SOLANA_CLUSTER` | `mainnet-beta` |
| `SOLANA_RPC_URL` | Helius mainnet URL |
| `HELIUS_API_KEY` | from Helius dashboard |
| `HELIUS_WEBHOOK_SECRET` | random string, also set in Helius dashboard |
| `MINT_AUTHORITY_PRIVATE_KEY` | base58 64-byte secret (mainnet keypair, funded with ≥ 1 SOL) |
| `MERKLE_TREE_ADDRESS` | mainnet tree (re-run `scripts/create-tree.ts` against mainnet) |
| `COLLECTION_ADDRESS` | (optional) mainnet collection mint |
| `METADATA_BASE_URL` | `https://your-domain.xyz/metadata` |
| `SENTRY_DSN` | Sentry project DSN |
| `SERVICE_VERSION` | `${{RAILWAY_GIT_COMMIT_SHA}}` |
| `ADMIN_BASIC_AUTH` | `admin:strong_random_pass` |

### 7. Custom domain + TLS

- Railway → service settings → "Generate domain" or attach `api.your-domain.xyz`.
- DNS: CNAME `api` → `your-service.up.railway.app`. TLS is auto-provisioned.
- Update `FRONTEND_ORIGIN` and `COOKIE_DOMAIN` accordingly.

### 8. Post-deploy smoke

```bash
# Health
curl https://api.your-domain.xyz/api/v1/health
# Expected: {"ok":true,"db":"ok","redis":"ok"}

# Bull-Board (replace creds)
curl -u admin:strong_random_pass https://api.your-domain.xyz/admin/queues
# Expected: HTML

# Sentry
# Trigger a 500 by hitting an unimplemented route or kill a backing service briefly.
# Within 30s the event appears in Sentry → "Issues".
```

### 9. Cost ceiling

Free tiers:
- **Atlas M0**: 512 MB storage. At ~1 KB/wallet plus tx cache, ≈ 100k wallets before paid upgrade.
- **Upstash free**: 10k commands/day. We expect < 5k/day at alpha volume.
- **Railway**: $5/month free credit; api + worker each consume ~$2–3/month idle.
- **Helius free**: 100k requests/month. One full scan ≈ 5 requests; 100k = 20k full scans.
- **Sentry developer**: 5k events/month. Plenty for alpha.

When any of these fills up, we either upgrade or shed load. Triage in this order: Helius (paid plan first), Atlas (M10 = $57/mo), Upstash (pay-as-you-go), Railway (Pro plan), Sentry (Team plan).

## Layout

- `apps/api` — Fastify HTTP service
- `apps/worker` — BullMQ worker (scan jobs, mint confirmation, webhook handling)
- `packages/shared` — Mongoose models, Zod env, error types, queue helpers
- `docs/superpowers/specs/` — design specifications
- `docs/superpowers/plans/` — implementation plans (one per phase)
