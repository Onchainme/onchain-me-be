# OnchainMe Backend — Design Spec

**Status:** Draft for review
**Date:** 2026-04-27
**Author:** brainstorm session (Igor + Claude)
**Source documents:**
- `~/Downloads/OnchainMe_MVP_Roadmap.docx` — high-level MVP roadmap (6–8 weeks to alpha, hackathon target)
- `~/Downloads/OnchainMe — Описание страниц.pdf` — page-by-page UX spec (Home, My Land, Edit, Public Land + modals)

---

## 1. Executive Summary

OnchainMe turns a Solana wallet's on-chain activity into an explorable "land" with NFT badges. A user connects their wallet → backend scans transactions via Helius → 10 rule-based badges are evaluated → user mints qualifying badges as compressed NFTs (cNFTs) and arranges them on a tile grid → public `/land/<wallet>` URL for sharing.

**Scope of this spec: backend only.** Frontend is built separately by another developer. The renderer choice (2D Pixi.js per the pages spec, vs 3D R3F per the roadmap) is intentionally left to the frontend; the backend stores tile coordinates `(x, y)` agnostically and serves them as JSON. This contradiction between source documents is flagged but does not affect backend implementation.

**Backend deliverables:**
- HTTP API (`apps/api`) on Fastify with OpenAPI documentation
- Background worker (`apps/worker`) on BullMQ for transaction scanning, parsing, badge evaluation, mint confirmation, webhook handling
- MongoDB schema (Mongoose models) with auto-managed indexes
- SIWS-based authentication with JWT sessions
- Sponsored cNFT minting via Metaplex Bubblegum (no Anchor program)
- Comprehensive test suite (unit + integration + pinned-wallet snapshots)

**Alpha success metrics (from roadmap):** ≥30 unique wallets, ≥50% mint rate, ≥10 share-URL visits, D1 retention ≥30%.

---

## 2. Locked Stack Decisions

The brainstorm walked through 6 stack decisions with rationale; outcome below.

| # | Layer | Decision | Key rationale |
|---|---|---|---|
| 1 | Runtime | **Node.js 20+ / TypeScript (strict)** | Solana web3.js, Helius SDK, Metaplex Umi all JS-native; matches developer's existing TS familiarity |
| 2 | Auth | **SIWS (nonce + ed25519) → JWT** in cookie (7d) | Closes placement-vandalism vector; one signature per session is acceptable UX cost |
| 3 | Scan model | **Async via BullMQ + polling** | Heavy wallets (5K txs) blow past 60s serverless timeouts; async is required, not optional |
| 4 | Mint model | **Sponsored partial-sign**: backend = fee payer + tree delegate; user = leaf owner | Removes "buy SOL first" friction critical for 50% mint-rate target; backend signs only after eligibility check |
| 5 | DB | **MongoDB 7 (single-node replica set) + Mongoose 8** | Document-oriented model fits Solana data (variable tx shapes, JSON-y); replica set required to enable multi-doc transactions for `PUT /placements` and mint flows; Mongoose for schema validation, indexes, and TS-friendly models |
| 6 | HTTP framework | **Fastify + Zod** (`fastify-type-provider-zod`) + `@fastify/swagger` | Schema-first validation; OpenAPI generated free; mature plugin ecosystem |

**Supporting choices:**
- Redis for BullMQ — **Upstash** managed
- Solana RPC — **Helius** (Enhanced API + Webhooks)
- cNFT — **Metaplex Umi + `@metaplex-foundation/mpl-bubblegum`**, no Anchor program
- Hosting — **Railway** (api + worker as 2 services), **MongoDB Atlas M0 free tier** (db, replica set out-of-the-box), **Upstash** (redis)
- Observability — **Pino** structured logs + **Sentry** errors/perf + **Bull-Board** queue dashboard

---

## 3. Project Structure

pnpm-workspace monorepo. Two deployable apps, one shared package.

```
onchainme-backend/
├── apps/
│   ├── api/                          # Fastify HTTP service (Railway service #1)
│   │   ├── src/
│   │   │   ├── server.ts             # bootstrap: fastify + plugins + routes
│   │   │   ├── plugins/              # @fastify/jwt, cors, swagger, rate-limit, sentry
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts           # /auth/nonce, /auth/verify, /auth/logout, /auth/me
│   │   │   │   ├── lands.ts          # /lands, /lands/:wallet, /lands/:wallet/inventory
│   │   │   │   ├── scan.ts           # /scan/:wallet, /scan/job/:id
│   │   │   │   ├── placements.ts     # PUT/DELETE on /placements/:wallet
│   │   │   │   ├── mint.ts           # /mint/single, /mint/all, /mint/confirm
│   │   │   │   └── webhooks.ts       # /webhooks/helius
│   │   │   └── lib/
│   │   │       ├── auth.ts           # SIWS verify, JWT issue/check
│   │   │       ├── solana.ts         # Umi instance, tree config, mint authority
│   │   │       └── helius.ts         # Helius client wrapper
│   │   └── package.json
│   └── worker/                       # BullMQ worker (Railway service #2)
│       ├── src/
│       │   ├── worker.ts             # entrypoint, processor registration
│       │   └── jobs/
│       │       ├── scanWallet.ts     # full + incremental
│       │       ├── parseTxs.ts       # protocol router
│       │       ├── evaluateBadges.ts
│       │       ├── confirmMint.ts    # background tx confirmation
│       │       ├── processHeliusWebhook.ts
│       │       ├── checkMintAuthorityBalance.ts  # cron, 10 min
│       │       ├── cleanupNonces.ts              # cron, 1 hour
│       │       └── helpers/
│       │           └── parsers/
│       │               ├── jupiter.ts
│       │               ├── magicEden.ts
│       │               └── meteora.ts
│       └── package.json
└── packages/
    └── shared/
        ├── src/
        │   ├── db/
        │   │   ├── models.ts         # Mongoose models (all 8 collections)
        │   │   ├── connect.ts        # mongoose.connect with retry; close helper
        │   │   └── ensure-indexes.ts # syncIndexes() runner — startup hook + npm script
        │   ├── schemas/              # Zod schemas (request/response/domain)
        │   ├── badges/
        │   │   ├── registry.ts       # 10 badges with rule fns + weights + metadata URIs
        │   │   └── types.ts          # Badge, BadgeRule, EvalContext, NormalizedTx
        │   ├── queue/
        │   │   └── connection.ts     # ioredis + BullMQ connection (shared by api/worker)
        │   ├── errors.ts             # ErrorCode enum + AppError class
        │   └── env.ts                # Zod-validated process.env
        └── package.json
```

**Boundaries:**
- `apps/api` does only HTTP + queue dispatch. No transaction parsing, no Helius calls in route handlers.
- `apps/worker` runs in a separate process. Adding a new protocol parser = new file under `helpers/parsers/` + one entry in router.
- `packages/shared` is the single source of truth for DB types, Zod schemas, badge config. Changes here trigger rebuild of both apps.
- Badges are JSON-config + a pure JS function. Adding a badge = one entry in `registry.ts`. No DB migration required.

---

## 4. Database Schema

8 collections in MongoDB 7. Models defined via Mongoose 8 with strict validation. Badges as a domain concept live in code (`packages/shared/badges/registry.ts`); the DB stores only their **state** for a given wallet.

### Conventions

- Collection names are camelCase plural: `users`, `scanJobs`, `badgeClaims`, etc.
- Mongoose schemas use `_id` strategically:
  - `users._id = walletAddress` (base58 string) — saves a field and gives O(1) lookup
  - `txs._id = signature` — natural unique key
  - `txRawCache._id = signature`
  - `authNonces._id = nonce`
  - `heliusWebhookEvents._id = eventId`
  - `badgeEligibilities._id`, `badgeClaims._id`, `placements._id` use **compound objects** `{ walletAddress, badgeId }` — Mongo enforces `_id` uniqueness, giving us composite-PK semantics for free
  - `scanJobs._id` = auto `ObjectId` (no natural key)
- Timestamps via Mongoose `{ timestamps: true }` for `createdAt` / `updatedAt` where useful
- All indexes declared in the Mongoose schema; created on app startup via `model.syncIndexes()` (replaces "migrations" — Mongoose diffs and applies index changes)

### Collections (Mongoose schema sketches)

```typescript
// users — wallet = identity
const userSchema = new Schema({
  _id: { type: String, required: true },          // walletAddress, base58
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: Date,
  lastScanAt: Date,
  lastScanCursor: String,                          // last processed signature
  refInviter: String,                              // referring wallet (record only, no payouts in MVP)
  ogImageUrl: String,
}, { _id: false });                                // disable auto-_id, we set string manually

// scanJobs — history mirror of BullMQ jobs (BullMQ remains source of truth)
const scanJobSchema = new Schema({
  walletAddress: { type: String, required: true, index: true },
  mode: { type: String, enum: ["full", "incremental"], required: true },
  status: { type: String, enum: ["queued", "running", "done", "failed"], required: true },
  progress: {                                      // { phase, processed, total }
    phase: String,
    processed: Number,
    total: Number,
  },
  result: {                                        // { newBadges: [...], totalBadges, warnings: [...] }
    newBadges: [String],
    totalBadges: Number,
    warnings: [{ signature: String, parser: String, error: String }],
  },
  error: String,
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
});
scanJobSchema.index({ walletAddress: 1, startedAt: -1 });

// txs — normalized transactions, the basis for badge evaluation
const txSchema = new Schema({
  _id: String,                                     // signature
  walletAddress: { type: String, required: true },
  blockTime: { type: Date, required: true },
  protocol: { type: String, enum: ["jupiter", "magic_eden", "meteora", "other"], required: true },
  action: {
    type: String,
    enum: ["swap", "nft_buy", "nft_sell", "nft_list", "lp_deposit", "lp_withdraw"],
    required: true,
  },
  amountUsd: Number,
  meta: Schema.Types.Mixed,                        // protocol-specific (mints, slippage, etc.)
}, { _id: false });
txSchema.index({ walletAddress: 1, blockTime: -1 });
txSchema.index({ walletAddress: 1, protocol: 1 });

// txRawCache — full Helius raw response (for offline rule re-evaluation)
const txRawCacheSchema = new Schema({
  _id: String,                                     // signature
  walletAddress: { type: String, required: true, index: true },
  raw: { type: Schema.Types.Mixed, required: true },
  fetchedAt: { type: Date, default: Date.now },
}, { _id: false });

// badgeEligibilities — wallet qualified but not yet minted
const badgeEligibilitySchema = new Schema({
  _id: {                                           // compound PK
    walletAddress: { type: String, required: true },
    badgeId: { type: String, required: true },
  },
  evaluatedAt: { type: Date, default: Date.now },
  eligibleSince: { type: Date, required: true },
  meta: Schema.Types.Mixed,                        // UI hints: "47 swaps on Jupiter"
}, { _id: false });
badgeEligibilitySchema.index({ "_id.walletAddress": 1 });    // lookup all eligibilities for a wallet

// badgeClaims — cNFTs that have been minted
const badgeClaimSchema = new Schema({
  _id: {                                           // compound PK
    walletAddress: { type: String, required: true },
    badgeId: { type: String, required: true },
  },
  mintedAt: { type: Date, default: Date.now },
  mintSignature: { type: String, required: true },
  assetId: { type: String, required: true },
  merkleTree: { type: String, required: true },
}, { _id: false });
badgeClaimSchema.index({ "_id.walletAddress": 1 });

// placements — positions of placed objects on the tile grid
const placementSchema = new Schema({
  _id: {                                           // compound PK = (wallet, badge)
    walletAddress: { type: String, required: true },
    badgeId: { type: String, required: true },
  },
  tileX: { type: Number, required: true },
  tileY: { type: Number, required: true },
  placedAt: { type: Date, default: Date.now },
}, { _id: false });
placementSchema.index({ "_id.walletAddress": 1 });
// "one object per tile" enforced by DB:
placementSchema.index(
  { "_id.walletAddress": 1, tileX: 1, tileY: 1 },
  { unique: true, name: "wallet_tile_uq" },
);

// authNonces — one-shot SIWS challenges, auto-deleted by TTL after 1 day
const authNonceSchema = new Schema({
  _id: String,                                     // nonce
  walletAddress: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: Date,
}, { _id: false });
// TTL: Mongo deletes documents 86400 seconds AFTER `expiresAt` —
// that is, expired nonces survive 24h for forensics, then auto-vacuum.
// Replaces the cron job that the Postgres design needed.
authNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

// heliusWebhookEvents — idempotency for incremental scans and mint confirmations
const heliusWebhookEventSchema = new Schema({
  _id: String,                                     // eventId
  receivedAt: { type: Date, default: Date.now },
  processedAt: Date,
  payload: { type: Schema.Types.Mixed, required: true },
}, { _id: false });
```

### Derived data (computed at query time via `$lookup` aggregation)

- **Home grid card** — aggregation pipeline:
  ```typescript
  Users.aggregate([
    { $lookup: { from: "placements", localField: "_id", foreignField: "_id.walletAddress", as: "placements" }},
    { $lookup: { from: "badgeClaims", localField: "_id", foreignField: "_id.walletAddress", as: "claims" }},
    { $project: { _id: 1, ogImageUrl: 1, objectsCount: { $size: "$placements" }, claims: 1 }},
    { $skip: cursor }, { $limit: 20 },
  ])
  ```
  Then in app code: `score = sum(badge.weight for c in claims where badge = registry[c._id.badgeId])`. ≤50 wallets in alpha → milliseconds. At 10k+, denormalize into `users.stats` field updated on mint/placement.
- **My Land stats** (protocols / transactions / score) — `$group` over `txs` filtered by walletAddress + count of `badgeClaims`. Single aggregation per call.

### Scoring

```
score(wallet) = SUM(badge.weight for badge in claims)
```

Weights live in `registry.ts` per badge. Changing weights = code change, no schema migration. Examples:

```typescript
{ id: 'first_swap',         weight: 10  }
{ id: 'jupiter_power_user', weight: 50  }
{ id: 'whale',              weight: 200 }
```

### Constraints summary

- **One badge claim per wallet** — compound `_id: { walletAddress, badgeId }` in `badgeClaims` enforces uniqueness at DB level
- **One badge placed per wallet** — same compound `_id` in `placements`
- **One object per tile** — unique compound index `(_id.walletAddress, tileX, tileY)` on `placements`
- **Webhook idempotency** — `_id: eventId` in `heliusWebhookEvents`
- **Auth nonces auto-cleanup** — TTL index on `expiresAt`, no cron job needed

### Why a replica set even for single-node MongoDB

`PUT /placements` (Flow 5) does `deleteMany + insertMany` across multiple documents in one collection. Without a replica set, Mongo cannot guarantee atomicity across these two operations. The replica set unlocks `session.withTransaction()` which wraps both operations in an ACID transaction with the same semantics as Postgres `BEGIN/COMMIT`.

For local dev and CI, a **single-node replica set** is sufficient — see §11 for the docker-compose setup. Atlas free tier (M0) provides a 3-node replica set out of the box.

### Mongo-specific atomicity wins (no transactions needed)

Several flows that would require transactions in a strict relational design get single-document atomicity for free in Mongo:

- `findOneAndUpdate({_id}, {$setOnInsert: {...}}, {upsert: true})` for `badgeClaims` — protects against double-mint races without transactions
- `findOneAndUpdate({_id, consumedAt: null}, {$set: {consumedAt: now}})` for `authNonces` — atomic check-and-consume of nonce
- TTL index on `authNonces.expiresAt` — replaces `cleanupNonces` cron from earlier draft

---

## 5. API Endpoints

Base prefix: `/api/v1`. JSON only. Errors in standard envelope (see Section 7).

### Auth markers

- 🔓 — public, no auth
- 🔒 — valid JWT required (cookie or `Authorization: Bearer`)
- 🔐 — valid JWT **and** `wallet` in token must match the resource owner

### Endpoint list

| Method | Path | Auth | Purpose |
|---|---|---|---|
| **AUTH (SIWS)** | | | |
| POST | `/auth/nonce` | 🔓 | `{wallet}` → `{nonce, message}` |
| POST | `/auth/verify` | 🔓 | `{wallet, nonce, signature}` → cookie + JWT |
| POST | `/auth/logout` | 🔒 | clear cookie |
| GET | `/auth/me` | 🔒 | `{wallet}` |
| **LANDS (public read layer)** | | | |
| GET | `/lands?cursor=&limit=20` | 🔓 | Home grid: list of land cards |
| GET | `/lands/:wallet` | 🔓 | Full land payload: placements + claims + stats + ogImageUrl |
| GET | `/lands/:wallet/inventory` | 🔐 | Owner only: claimed + eligible (drives Edit panel) |
| **SCAN (BullMQ jobs)** | | | |
| POST | `/scan/:wallet?mode=full\|incremental` | 🔐 | Enqueue job → `{jobId}` |
| GET | `/scan/job/:jobId` | 🔒 | `{status, progress, result?, error?}` |
| **PLACEMENTS** | | | |
| PUT | `/placements/:wallet` | 🔐 | `{placements:[{badgeId,x,y},...]}` — full bulk replace in one transaction |
| DELETE | `/placements/:wallet/:badgeId` | 🔐 | Remove one object from grid |
| **MINT (cNFT via Bubblegum)** | | | |
| POST | `/mint/single` | 🔒 | `{badgeId}` → `{transaction:base64, badgeId, expiresAt}` |
| POST | `/mint/all` | 🔒 | → `{transactions:[{badgeId,transaction:base64}, ...]}` |
| POST | `/mint/confirm` | 🔒 | `{signature, badgeId}` → writes `badgeClaims` |
| **WEBHOOKS** | | | |
| POST | `/webhooks/helius` | 🔓* | *Validated via shared-secret header |
| **SERVICE** | | | |
| GET | `/health` | 🔓 | `{ok:true, db:'ok', redis:'ok'}` |
| GET | `/docs` | 🔓 | Swagger UI |
| GET | `/openapi.json` | 🔓 | OpenAPI spec for client codegen |

### Rate limits (`@fastify/rate-limit`)

| Endpoint | Limit |
|---|---|
| `POST /auth/nonce` | 10/min/IP |
| `POST /auth/verify` | 5/min/IP |
| `POST /scan/:wallet?mode=full` | 1/5min/wallet, 5/hour/IP |
| `POST /scan/:wallet?mode=incremental` | 1/30s/wallet |
| `POST /mint/*` | 10/min/wallet |
| `PUT /placements` | 30/min/wallet |
| All others | 100/min/IP |

### SIWS message format (canonical)

```
OnchainMe wants you to sign in with your Solana account:
<wallet_address>

Welcome to OnchainMe.

URI: https://onchainme.xyz
Version: 1
Chain ID: solana:mainnet
Nonce: <nonce>
Issued At: <iso8601>
Expiration Time: <iso8601 +5 min>
```

JWT issued post-verify: HS256, payload `{wallet, iat, exp}`, 7-day expiration. Cookie: `om_session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/`.

### Mint flow (sponsored partial-sign)

Backend prepares the mint transaction via Umi `mintToCollectionV1`:

- `merkleTree` = `OUR_TREE` (env var)
- `leafOwner` = user wallet
- `feePayer` = `MINT_AUTHORITY_KEY`
- `treeDelegate` = `MINT_AUTHORITY_KEY`
- Metadata URI = derived from `badge_id` template (Arweave-hosted)

Backend signs as fee payer + tree delegate, serializes to base64, returns to frontend. Frontend deserializes, prompts wallet to sign as `leafOwner`, sends to RPC.

`/mint/all` returns one transaction per eligible badge (Solana tx-size limits prevent batching multiple cNFT mints into a single tx). Frontend signs N transactions sequentially.

---

## 6. Data Flow

### Flow 1 — First wallet connect (auth + full scan)

1. `POST /auth/nonce {wallet}` → backend inserts `authNonces` doc (TTL on `expiresAt` auto-cleans after 1d), returns `{nonce, message}`
2. Frontend prompts `wallet.signMessage(message)`
3. `POST /auth/verify {wallet, nonce, signature}` → backend atomically consumes nonce via `findOneAndUpdate({_id:nonce, consumedAt:null}, {$set:{consumedAt:now}})`, verifies ed25519, upserts `users` (`_id: walletAddress`), issues JWT, sets cookie
4. `POST /scan/:wallet?mode=full` → backend inserts `scanJobs` doc, calls `queue.add('scanWallet', {walletAddress, mode:'full'})`, returns `{jobId}`
5. Worker reserves the job, executes phases:
   - `fetching_signatures` — `getSignaturesForAddress` up to 5000
   - `fetching_transactions` — Helius Enhanced API in batches of 50
   - `parsing` — protocol router → `jupiter.ts` / `magicEden.ts` / `meteora.ts`
   - `evaluating` — run 10 badge rules over normalized txs
   - `done` — update `users.lastScanCursor` = newest signature
6. Each phase writes:
   - `txRawCache` via `bulkWrite` with `{ ordered: false }` — duplicate `_id`s (signatures) ignored
   - `txs` via `insertMany({ ordered: false })` — same dedup pattern
   - `badgeEligibilities` via `bulkWrite` with `updateOne({_id, upsert:true})` per badge
   - `scanJobs.progress` updated after every phase via `updateOne`
7. `GET /scan/job/:jobId` polled by frontend every 2 seconds → returns current `{status, progress, result?}`

### Flow 2 — Update (incremental re-scan)

Identical to Flow 1 but:
- `mode=incremental` → worker reads `users.lastScanCursor`, calls `getSignaturesForAddress(wallet, {until: cursor})` — only newer signatures
- New docs inserted in `txRawCache` and `txs`; existing `_id`s cause silent duplicate-key error which `insertMany({ ordered: false })` swallows
- `badgeEligibilities` re-evaluated over the **full** `txs` set (a multi-protocol badge may unlock from prior + new txs)
- `result.newBadges` populated → frontend animates "New!" markers in inventory

### Flow 3 — Mint single (sponsored partial-sign)

1. `POST /mint/single {badgeId}` (with JWT)
2. Backend asserts: `badgeEligibilities` contains `_id: {walletAddress, badgeId}` AND `badgeClaims` does not (two `findOne` calls; race-safe because the next step is atomic)
3. Backend builds Umi mint transaction with the parameters in §5, signs as fee payer + tree delegate, returns serialized base64
4. Frontend: `Transaction.from(base64)` → `wallet.signTransaction(tx)` → `connection.sendRawTransaction(tx.serialize())`
5. Frontend receives `signature`, calls `POST /mint/confirm {signature, badgeId}`
6. Backend confirms via `connection.confirmTransaction`, fetches via `getTransaction`, parses `assetId` from logs, then writes the claim atomically:
   ```typescript
   await BadgeClaim.findOneAndUpdate(
     { _id: { walletAddress, badgeId } },
     { $setOnInsert: { mintSignature, assetId, merkleTree, mintedAt: new Date() } },
     { upsert: true, returnDocument: "after" },
   );
   ```
   `$setOnInsert` ensures double-mint races are no-ops at the DB level — the second call returns the existing claim.
7. **In parallel**, Helius webhook subscribed to `OUR_TREE` address fires `compressed.mint` → `/webhooks/helius` → same `findOneAndUpdate` with `$setOnInsert` (idempotent safety net if frontend dropped between steps 4 and 5)

`/mint/all` returns N transactions; frontend signs each in sequence; backend processes confirmations identically.

### Flow 4 — Public visit `/land/:wallet`

Single aggregation pipeline over `users` with `$lookup` on `placements`, `badgeClaims`, plus separate `$group` over `txs`. No external service calls. HTTP `Cache-Control: public, max-age=30` mitigates load on viral lands.

Response shape:

```json
{
  "wallet": "ABC...",
  "stats": { "protocols": 3, "transactions": 1247, "score": 320 },
  "placements": [
    { "badgeId": "first_swap", "x": 4, "y": 7, "asset": { "id":"...", "image":"...", "name":"..." } }
  ],
  "ogImageUrl": "https://.../og/ABC.png"
}
```

### Flow 5 — Save placements (Edit → Update)

1. `PUT /placements/:wallet {placements:[{badgeId,x,y},...]}` (with JWT)
2. Backend asserts `token.wallet === :wallet`
3. Backend opens a Mongoose session and wraps the bulk replace in `withTransaction`:
   ```typescript
   const session = await mongoose.startSession();
   try {
     await session.withTransaction(async () => {
       await Placement.deleteMany({ "_id.walletAddress": wallet }, { session });
       await Placement.insertMany(
         body.placements.map((p) => ({
           _id: { walletAddress: wallet, badgeId: p.badgeId },
           tileX: p.x,
           tileY: p.y,
         })),
         { session, ordered: true },
       );
     });
   } finally {
     await session.endSession();
   }
   ```
4. The unique compound index `(_id.walletAddress, tileX, tileY)` catches in-request tile conflicts → `insertMany` throws `DuplicateKeyError`, the transaction aborts (delete is rolled back), backend returns 409 `TILE_OCCUPIED` with the conflicting `(x, y)` from `err.writeErrors[0].err.op`

### Background cron jobs (BullMQ Repeatable Jobs)

`authNonces` cleanup is **not** in this list — the Mongo TTL index on `expiresAt` handles it automatically. Removed `cleanupNonces` job vs Postgres draft.

| Job | Frequency | Purpose |
|---|---|---|
| `checkMintAuthorityBalance` | every 10 min | Sentry alert if mint-authority SOL balance < 0.5; service degradation if < 0.1 |
| `regenerateOgImage` | per-wallet, debounced after `PUT /placements` | Render PNG via `@napi-rs/canvas` from placements + sprite assets, upload to S3-compatible storage (Cloudflare R2 or Atlas File Storage), update `users.ogImageUrl` |

### OG-preview note

OG-preview is a gray area between backend and frontend. The simplest backend-side path: server-side 2D composition via `@napi-rs/canvas` using sprite atlas + placement coordinates. If the frontend uses 3D R3F instead, an alternative is `POST /og-snapshot {wallet, pngBase64}` from frontend after rendering. Final integration approach to be decided when frontend lands; backend exposes both paths.

---

## 7. Error Handling and Observability

### Error envelope (all 4xx and 5xx)

```json
{
  "error": {
    "code": "BADGE_NOT_ELIGIBLE",
    "message": "You haven't qualified for Jupiter Power User yet (need 50+ swaps).",
    "details": { "current": 12, "required": 50 },
    "requestId": "req_abc123"
  }
}
```

All codes defined as enum in `packages/shared/errors.ts` for stable consumption by the frontend.

### Error code taxonomy

```
400  VALIDATION
  VALIDATION_ERROR              — generic, details from Zod
  INVALID_WALLET_FORMAT
  INVALID_BADGE_ID
  INVALID_TILE_COORDINATE

401  AUTHENTICATION
  AUTH_NONCE_EXPIRED
  AUTH_NONCE_CONSUMED
  AUTH_SIGNATURE_INVALID
  AUTH_TOKEN_MISSING
  AUTH_TOKEN_INVALID

403  AUTHORIZATION
  FORBIDDEN_RESOURCE_OWNER      — JWT.wallet ≠ resource owner

404  NOT FOUND
  LAND_NOT_FOUND                — wallet never scanned
  JOB_NOT_FOUND

409  CONFLICT
  TILE_OCCUPIED
  BADGE_ALREADY_CLAIMED
  SCAN_ALREADY_RUNNING

422  BUSINESS LOGIC
  BADGE_NOT_ELIGIBLE
  TX_BLOCKHASH_EXPIRED          — user took too long to sign mint tx
  PLACEMENT_FOR_UNCLAIMED       — placing an unclaimed badge

429  RATE LIMIT
  RATE_LIMIT_EXCEEDED           — + Retry-After header

500/502/503  INFRASTRUCTURE (logged to Sentry, generic message to user)
  INTERNAL_ERROR                — fallback
  HELIUS_UNAVAILABLE
  SOLANA_RPC_UNAVAILABLE
  DATABASE_UNAVAILABLE
  REDIS_UNAVAILABLE
  MINT_AUTHORITY_OUT_OF_FUNDS   — critical alert
```

### Worker retry policy

| Job | attempts | backoff | Notes |
|---|---|---|---|
| `scanWallet` (full) | 3 | exp from 8s | Idempotent via PK on `signature` |
| `scanWallet` (incremental) | 5 | exp from 4s | Short, retried more aggressively |
| `parseTransactions` | 2 | fixed 2s | Failed parse → log raw to Sentry, skip the tx, continue |
| `confirmMint` | 10 | exp from 4s | Confirmation can take 30+s |
| `processHeliusWebhook` | 5 | exp from 2s | Idempotent on `event_id` |

**Graceful degradation principle:** a failure in one protocol parser does not fail the whole scan. The user gets a partial result with `warnings: [{signature, parser, error}]` in `scanJobs.result`.

### Mint-specific error scenarios

1. **User rejects in wallet** — frontend catches; nothing reaches backend. State unchanged. Retry safe.
2. **Tx sent, but frontend dropped before `/mint/confirm`** — Helius webhook catches it, idempotent UPSERT to `badgeClaims`. User sees the badge claimed on next visit.
3. **Tx sent, on-chain failure** (slippage, blockhash expired, RPC error):
   - Failure during `sendRawTransaction` — frontend exception, no backend write, retry safe
   - Tx landed but `meta.err` set — `/mint/confirm` calls `getTransaction`, sees `err`, returns `TX_FAILED {err}` to frontend, no `badgeClaims` write

### Mint-authority key safety

- Stored only in `MINT_AUTHORITY_PRIVATE_KEY` env var on Railway (never in code/git)
- All partial-signs logged: `wallet=X badge=Y signature=Z` → Sentry breadcrumbs catch abuse
- `treeDelegate` is the mint-authority key (separable from creator); rotation = on-chain `setTreeDelegate` from cold-wallet creator. During rotation, `/mint/*` returns 503.
- Cron `checkMintAuthorityBalance` (10 min): warn at <0.5 SOL, degrade `/mint/*` to 503 at <0.1 SOL
- Anchor on-chain rate-limit program is a v2 hardening; off-chain Fastify rate-limit + monitoring is acceptable for alpha

### Observability stack

| Layer | Tool | What lands there |
|---|---|---|
| Structured logs | Pino | Per request: `{requestId, wallet?, route, method, status, duration_ms}`. Per worker step: `{jobId, phase, processed, total}` |
| Exceptions | Sentry | All 5xx, post-retry worker failures, critical alerts (mint-authority balance, idempotency violation) |
| Performance | Sentry Performance + custom counters | `scan.duration`, `mint.success_rate`, `parser.{protocol}.failure_rate` |
| Health | `GET /health` | Pings MongoDB (`db.admin().ping()`) + Redis (`redis.ping()`); 503 if degraded |
| Worker dashboard | Bull-Board on `/admin/queues` (basic auth) | Jobs, retries, manual retry button |
| Audit | Pino entries tagged `audit=true` | Mint partial-signs, placement changes — for incident forensics |

**Request ID:** `@fastify/request-context` generates UUID per request; propagated to Pino, Sentry, and returned in error response. User pastes `requestId` into bug report → engineer finds the trace.

---

## 8. Testing Strategy

Pyramid sized for a solo dev: enough to catch regressions in the most fragile (parsers, rules) and most expensive (mint, auth) paths.

### Stack

| Layer | Tool | Scope |
|---|---|---|
| Test runner | Vitest | Unit + integration; ESM-native, watch mode, snapshot support |
| HTTP testing | `fastify.inject()` | No HTTP server needed in tests |
| External HTTP mocking | MSW | Mock Helius and Solana RPC at fetch level |
| MongoDB (tests) | `mongodb-memory-server-replicaset` | Spawns ephemeral single-node replica set in-memory per test run; no docker required |
| MongoDB + Redis (CI/local dev) | docker-compose | Real Mongo replica set + Redis |
| Solana devnet | Manual checklist | Mint dry-runs in Week 5; not in CI (slow, flaky) |

### Layout

```
apps/api/src/**/*.test.ts        # unit tests next to source
apps/worker/src/**/*.test.ts     # unit tests for worker logic
test/
  integration/
    auth.spec.ts
    scan.spec.ts
    placements.spec.ts
    mint.spec.ts
    webhook.spec.ts
    rate-limit.spec.ts
    snapshot-wallets.spec.ts     # the critical regression net
  fixtures/
    wallets/
      0xPOWER_USER.json
      0xWHALE.json
      0xFRESH.json
    helius/
      jupiter_swap.json
      magic_eden_buy.json
      meteora_lp_deposit.json
    badges/
      expected_eligibility.json
```

### Unit tests (fast, many)

| File | What it covers | ~cases |
|---|---|---|
| `badges/registry.test.ts` | Each of 10 rules: positive + negative + edge | ~30 |
| `parsers/jupiter.test.ts` | Swap parsed correctly; non-swap skipped; failed tx dropped | ~10 |
| `parsers/magicEden.test.ts` | Buy / sell / list separated correctly | ~10 |
| `parsers/meteora.test.ts` | LP operations | ~5 |
| `auth/siws.test.ts` | Valid / invalid sig / wrong wallet / expired nonce | ~6 |
| `lib/scoring.test.ts` | Sum of weights, empty case, claim without registry entry | ~4 |
| `schemas/*.test.ts` | Zod schemas: positive + 2-3 negative each | ~20 |

Parser tests use snapshot-style assertions: input is a pinned raw Helius tx from `fixtures/helius/`, output is the expected `NormalizedTx`. `vitest -u` updates snapshots; diffs reviewed in PR.

### Integration tests (slower, focused)

| Spec | Coverage |
|---|---|
| `auth.spec` | Full SIWS round-trip; nonce consumed; reuse blocked; JWT validates downstream |
| `scan.spec` | `/scan` enqueues; worker run inline; polling shows `done`; DB rows correct |
| `placements.spec` | Bulk replace; 409 on tile conflict; 403 on wrong wallet |
| `mint.spec` | `/mint/single` returns valid base64 with backend signatures; `/mint/confirm` writes claim (Solana RPC mocked via MSW) |
| `webhook.spec` | Compressed-mint event writes claim; replay of same `event_id` is no-op |
| `rate-limit.spec` | Lockout triggers correctly with `Retry-After` |

### Pinned-wallet regression net (the most important suite)

`test/integration/snapshot-wallets.spec.ts` runs 3 real-wallet fixtures (Jupiter power user, Magic Eden NFT collector, fresh wallet with 5 txs) through the full scan pipeline and asserts `badgeEligibilities` matches `fixtures/badges/expected_eligibility.json`. Any parser or rule change either confirms intentional movement (snapshot updated in PR) or catches a regression.

This realizes the roadmap Phase 1 exit criterion: "Pin test wallets per protocol; snapshot expected output; CI runs on each change."

### CI (GitHub Actions)

```yaml
on: [pull_request, push: main]
jobs:
  test:
    services:
      mongo: { image: mongo:7, command: ["--replSet", "rs0", "--bind_ip_all"] }
      redis:    { image: redis:7 }
    steps:
      - pnpm install
      - pnpm typecheck         # tsc --noEmit across monorepo
      - pnpm lint              # eslint
      - pnpm test:unit
      - pnpm test:integration
      - pnpm build             # both apps; catches build breaks
```

Target wall time: < 3 minutes per PR.

### Out of scope (intentionally not tested)

- Helius API itself — mocked via MSW. Format changes caught in production via Sentry parser failure alerts; fixture added, parser fixed.
- Wallet adapter — frontend territory.
- cNFT mint on devnet in CI — too slow (30s/tx) and flaky. Replaced by (a) unit test that backend assembles correct unsigned tx, (b) manual Week 5 checklist with 3–5 devnet dry-runs across different wallets.
- Frontend rendering — out of scope of this spec.

### Coverage targets (realistic for solo)

- Parsers + badge rules: **80%+** plus snapshot-wallet net
- Routes (auth, business logic): **70%+**
- External adapters (Helius, Umi): **0%** as unit; exercised via integration

### Local dev workflow

```bash
docker-compose up -d        # Mongo (replica set) + Redis
pnpm db:sync-indexes        # one-shot index sync via mongoose syncIndexes()
pnpm dev:api                # tsx watch on apps/api
pnpm dev:worker             # tsx watch on apps/worker
pnpm test                   # vitest watch
```

`docker-compose.yml` at repo root with Mongo (port 27018) + Redis (port 6380). `.env.example` template; `.env.local` gitignored.

---

## 9. Open Decisions Deferred to Implementation Phase

These were intentionally not nailed down during brainstorm; will surface in the implementation plan:

1. **Sprite asset pack.** Free Kenney pack for badge thumbnails on the backend OG-preview path, or commission a custom set. Decision tied to whether frontend is 2D or 3D.
2. **Arweave vs IPFS for cNFT metadata.** Default plan: Arweave via `@metaplex-foundation/umi-uploader-irys`. Reconsider if cost is prohibitive.
3. **Merkle tree sizing.** `maxDepth=14, maxBufferSize=64, canopyDepth=10` supports ~16k cNFTs. Adequate for alpha (50 users × 10 badges = 500); plan tree migration for v2.
4. **Single-wallet vs separate keys for fee-payer and tree-delegate.** Roadmap allows single key for MVP simplicity. Split for v2 once volume justifies key isolation.
5. **OG-preview backend rendering vs frontend snapshot upload.** Resolve at frontend integration moment.

---

## 10. Out of Scope (v2+)

Restated from roadmap, for spec hygiene:

- Multiple land templates / drag-and-drop customization
- Full SPL NFTs / royalties / secondary-market listings
- Community hub, friends, feed, comments
- Leaderboards, XP, gamified quests
- Premium tier, marketplace, B2B badges
- Anonymous mode / email-based accounts
- Orca, Kamino, governance, staking protocol parsers (beyond Jupiter, Magic Eden, Meteora)
- Anchor on-chain rate-limit / mint guardrails
- KMS / Turnkey for mint-authority key

---

## 11. Local Infrastructure (Docker)

### Database engine clarification

The DB engine is **MongoDB 7** in every environment, configured as a **single-node replica set**. This is what unlocks multi-document transactions (used by `PUT /placements` per Flow 5). Local dev and CI use a self-initializing single-node replica set; production uses MongoDB Atlas (M0 free tier provides a 3-node replica set out of the box). The Mongoose connection code, models, and indexes are identical across environments — only the connection string differs.

### `docker-compose.yml` (repo root)

Brings up MongoDB 7 (replica set) + Redis 7. Replica set initialization is automated via the healthcheck — no init container or manual step needed.

```yaml
version: "3.9"

services:
  mongo:
    image: mongo:7
    container_name: onchainme-mongo
    command: ["--replSet", "rs0", "--bind_ip_all", "--port", "27018"]
    ports:
      - "27018:27018"          # host:container — port 27018 chosen to avoid conflict
                                # with other local mongo instances on default 27017.
                                # internal port matches external so the replica set
                                # member announces itself at localhost:27018, which
                                # the host can resolve directly.
    volumes:
      - mongo_data:/data/db
    healthcheck:
      # Self-initializes the single-node replica set on first run.
      # On subsequent runs, rs.status() succeeds and the initiate is skipped.
      test: |
        mongosh --port 27018 --quiet --eval "
          try {
            rs.status();
          } catch (err) {
            rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27018'}]});
          }
        "
      interval: 5s
      timeout: 30s
      start_period: 0s
      retries: 30

  redis:
    image: redis:7-alpine
    container_name: onchainme-redis
    ports:
      - "6380:6379"             # host:container — host port shifted from 6379 to
                                # avoid conflict with other local Redis instances.
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  # Uncomment for full-stack local runs. Day-to-day dev:
  #   keep these commented and run `pnpm dev:api` / `pnpm dev:worker`
  #   against host-side mongo + redis (faster reload, native debugger).
  #
  # api:
  #   build:
  #     context: .
  #     dockerfile: apps/api/Dockerfile
  #   container_name: onchainme-api
  #   environment:
  #     - NODE_ENV=development
  #     - MONGODB_URI=mongodb://mongo:27018/onchainme?replicaSet=rs0
  #     - REDIS_URL=redis://redis:6379
  #   env_file:
  #     - .env.local
  #   ports:
  #     - "3001:3001"
  #   depends_on:
  #     mongo:
  #       condition: service_healthy
  #     redis:
  #       condition: service_healthy
  #
  # worker:
  #   build:
  #     context: .
  #     dockerfile: apps/worker/Dockerfile
  #   container_name: onchainme-worker
  #   environment:
  #     - NODE_ENV=development
  #     - MONGODB_URI=mongodb://mongo:27018/onchainme?replicaSet=rs0
  #     - REDIS_URL=redis://redis:6379
  #   env_file:
  #     - .env.local
  #   depends_on:
  #     mongo:
  #       condition: service_healthy
  #     redis:
  #       condition: service_healthy

volumes:
  mongo_data:
  redis_data:
```

### `apps/api/Dockerfile`

Multi-stage build: deps cache → build → slim runtime. Uses pnpm via `corepack` (built into Node 20).

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- deps ----
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @onchainme/shared build && pnpm --filter @onchainme/api build

# ---- runtime ----
FROM node:20-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/packages/shared/dist ./node_modules/@onchainme/shared/dist
COPY --from=build /repo/packages/shared/package.json ./node_modules/@onchainme/shared/package.json
COPY --from=deps /repo/node_modules ./node_modules
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/health || exit 1
CMD ["node", "dist/server.js"]
```

### `apps/worker/Dockerfile`

Same skeleton as api, different entrypoint. No exposed port.

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @onchainme/shared build && pnpm --filter @onchainme/worker build

FROM node:20-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/apps/worker/package.json ./package.json
COPY --from=build /repo/packages/shared/dist ./node_modules/@onchainme/shared/dist
COPY --from=build /repo/packages/shared/package.json ./node_modules/@onchainme/shared/package.json
COPY --from=deps /repo/node_modules ./node_modules
CMD ["node", "dist/worker.js"]
```

### `.env.example` (committed) → copy to `.env.local` (gitignored)

```env
# --- Application ---
NODE_ENV=development
LOG_LEVEL=debug
PORT=3001

# --- Database (MongoDB) ---
# Local: matches docker-compose service `mongo` (single-node replica set on port 27018)
# Production: MongoDB Atlas SRV connection string — copy from Atlas dashboard → Connect → Drivers
# Note: `?replicaSet=rs0` is REQUIRED locally for multi-doc transactions to work
MONGODB_URI=mongodb://localhost:27018/onchainme?replicaSet=rs0

# --- Redis (BullMQ) ---
# Local: matches docker-compose service `redis` (host port 6380)
# Production: Upstash URL — copy from Upstash dashboard
REDIS_URL=redis://localhost:6380

# --- Auth ---
JWT_SECRET=change_me_in_prod_min_32_chars_long_random_string
COOKIE_DOMAIN=localhost

# --- Solana / Helius ---
HELIUS_API_KEY=your_helius_api_key
HELIUS_WEBHOOK_SECRET=shared_secret_for_webhook_signature_check
SOLANA_CLUSTER=mainnet-beta
# For dev set to devnet:
# SOLANA_CLUSTER=devnet

# --- Mint authority (cNFT signing) ---
# Base58-encoded ed25519 private key. NEVER commit. Generate via:
#   solana-keygen new -o mint-authority.json --no-bip39-passphrase
#   then base58-encode the secretKey from that file.
MINT_AUTHORITY_PRIVATE_KEY=
MINT_AUTHORITY_TREE=                       # base58 address of the Merkle tree

# --- Sentry ---
SENTRY_DSN=
```

### Quick start

```bash
# 1. Spin up Mongo (replica set) + Redis
docker-compose up -d

# 2. Wait ~30 sec for the replica set to initialize (the healthcheck does this)
docker-compose ps    # confirm both services are "Up (healthy)"

# 3. Sync indexes (one-shot — replaces "migrations" of relational stacks)
pnpm db:sync-indexes

# 4. Start api and worker (two terminals)
pnpm dev:api      # http://localhost:3001/api/v1/health
pnpm dev:worker   # logs job activity

# 5. (Optional) Open Bull-Board to inspect queues
#    api exposes it at http://localhost:3001/admin/queues (basic auth)
```

### Hosting deployment notes

- **Railway** detects `Dockerfile` per service automatically. Two services: one points to `apps/api/Dockerfile`, other to `apps/worker/Dockerfile`. Same env vars on both, set in Railway dashboard.
- **MongoDB Atlas (M0 free tier)**: copy the SRV connection string from Atlas → Connect → Drivers. Looks like `mongodb+srv://user:pass@cluster0.xxx.mongodb.net/onchainme?retryWrites=true&w=majority`. Atlas comes pre-configured as a 3-node replica set, so `replicaSet=...` is auto-detected from SRV. Whitelist the Railway egress IPs (or `0.0.0.0/0` for alpha — tighten before public launch).
- **Upstash Redis**: use the TLS URL (`rediss://`). BullMQ handles TLS via ioredis if URL starts with `rediss://`.
- **Helius webhook**: registered once via Helius dashboard or API to point at `https://api.onchainme.xyz/api/v1/webhooks/helius`, type `enhanced`, addresses = `[MINT_AUTHORITY_TREE]`.

---

## 12. References

- Source roadmap: `~/Downloads/OnchainMe_MVP_Roadmap.docx`
- Source pages spec: `~/Downloads/OnchainMe — Описание страниц.pdf`
- Helius Enhanced API: https://docs.helius.dev
- Metaplex Bubblegum: https://developers.metaplex.com/bubblegum
- Solana SIWS reference: https://github.com/phantom/sign-in-with-solana
- BullMQ: https://docs.bullmq.io
- Mongoose: https://mongoosejs.com
- MongoDB transactions: https://www.mongodb.com/docs/manual/core/transactions/
- Fastify: https://fastify.dev

---

*End of spec. Implementation plan to follow via `superpowers:writing-plans`.*
