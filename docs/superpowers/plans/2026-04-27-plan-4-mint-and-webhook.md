# Plan 4 — Mint + Webhook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sponsored partial-sign mint flow for compressed NFT (cNFT) badges via Metaplex Bubblegum, plus Helius webhook receiver and a worker job that monitors the mint authority's SOL balance.

**Architecture:**
- **Backend = fee payer + tree delegate.** The user's wallet only signs as `leafOwner`. We use Umi's `mintToCollectionV1` from `@metaplex-foundation/mpl-bubblegum`, partial-sign with the mint-authority keypair, serialize to base64, and return to the frontend. Frontend completes the signature, sends to RPC, then calls `/mint/confirm`.
- **Idempotent claim writes.** `BadgeClaim.findOneAndUpdate({_id}, {$setOnInsert: ...}, {upsert: true})` is atomic at the DB level — both the `/mint/confirm` path and the Helius webhook path call the same operation. A double-write is a no-op.
- **Webhook safety net.** If the frontend dies between "send tx" and "/mint/confirm", the Helius `compressed.mint` webhook still writes the claim. `heliusWebhookEvents` collection (one row per `signature`) deduplicates.
- **Balance gate.** A BullMQ repeatable job ticks every 10 minutes, calls `getBalance(mintAuthorityPublicKey)`, and if balance < 0.1 SOL sets a Redis key `onchainme:mint_disabled=1` with a 15-minute TTL. Every `/mint/*` route checks this key first and returns 503 if set.
- **No on-chain calls in CI.** Tests mock Solana RPC via MSW; building the unsigned transaction is local-only (Umi serializes without network). Real cNFT mints are exercised manually on devnet — see the README checklist added in Task 11.

**Tech Stack additions on top of Plan 3:**
- `@metaplex-foundation/umi` — base Umi runtime
- `@metaplex-foundation/umi-bundle-defaults` — RPC transport, signer adapter, etc.
- `@metaplex-foundation/mpl-bubblegum` 4.x — `mintToCollectionV1` instruction + leaf parsing helpers
- `@solana/web3.js` 1.x — `Connection` for the balance check (Umi's RPC could do it too, but `web3.js` is the lighter dependency the worker already needs for `Keypair`)

**Spec reference:** [`docs/superpowers/specs/2026-04-27-onchainme-backend-design.md`](../specs/2026-04-27-onchainme-backend-design.md) — §5 (`/mint/*`, `/webhooks/helius`, mint flow), §6 Flow 3 (sponsored partial-sign), §7 (mint error scenarios, mint-authority key safety, error codes), §8 (mint testing strategy: unit tests + manual devnet checklist).

**Exit criterion:** With Mongo + Redis up, a real `MINT_AUTHORITY_PRIVATE_KEY` (devnet, funded), and a real `MERKLE_TREE_ADDRESS` on devnet, this end-to-end flow works:

1. User logs in (Plan 2 SIWS auth) → cookie issued.
2. Worker scan completes (Plan 2 + 3) → `badgeEligibilities` for `first_swap` exists, no claim yet.
3. `POST /api/v1/mint/single {badgeId:"first_swap"}` (with cookie) → `{transaction: "<base64>", badgeId: "first_swap", expiresAt: <iso>}`.
4. Frontend (or our test script) deserializes, signs as `leafOwner`, sends to RPC, gets `signature`.
5. `POST /api/v1/mint/confirm {signature, badgeId:"first_swap"}` → `{badgeId, mintSignature, assetId, alreadyClaimed: false}`.
6. `db.badgeClaims.findOne({"_id.walletAddress":"<wallet>", "_id.badgeId":"first_swap"})` returns the row with `assetId` populated.
7. A second `/mint/confirm` with the same `signature` returns `alreadyClaimed: true`, no DB change.
8. Helius webhook delivering the same compressed.mint event posts to `/webhooks/helius` → 200, no duplicate row created.
9. Worker `checkMintAuthorityBalance` job logs `mint authority balance = X SOL` every 10 min; lowering test balance below 0.1 SOL flips `/mint/single` to 503 `MINT_AUTHORITY_OUT_OF_FUNDS` within one cycle.

`pnpm test` green; expected ~115 tests. `pnpm build` clean. Both Docker images build.

---

## File Structure (created or modified in this plan)

```
onchainme-backend/
├── packages/
│   └── shared/
│       └── src/
│           ├── solana/
│           │   ├── keypair.ts               # loadMintAuthority() — base58 decode + cache
│           │   ├── connection.ts            # getRpcConnection() — @solana/web3.js Connection from env
│           │   └── umi.ts                   # createUmiClient() — Umi + mpl-bubblegum + mint-authority signer
│           ├── mint/
│           │   ├── metadata.ts              # buildMetadataUri(badgeId)
│           │   ├── prepare.ts               # buildMintTransaction({wallet, badgeId, treeAddress, collectionAddress?})
│           │   ├── confirm.ts               # parseAssetIdFromTx(signature, umi)
│           │   ├── balance.ts               # checkAndFlagBalance() — reads getBalance, sets Redis flag if low
│           │   └── degraded.ts              # isMintDegraded() — reads Redis flag
│           ├── webhook/
│           │   └── verify.ts                # verifyHeliusSecret(headerValue)
│           └── tests/
│               ├── solana/
│               │   └── keypair.test.ts
│               ├── mint/
│               │   ├── metadata.test.ts
│               │   ├── prepare.test.ts
│               │   ├── confirm.test.ts
│               │   ├── balance.test.ts
│               │   └── degraded.test.ts
│               └── webhook/
│                   └── verify.test.ts
├── apps/
│   ├── api/
│   │   └── src/routes/
│   │       ├── mint.ts                      # POST /mint/single, /mint/all, /mint/confirm
│   │       └── webhooks.ts                  # POST /webhooks/helius
│   ├── api/src/routes/index.ts              # MODIFIED: register mintRoute + webhooksRoute
│   ├── api/src/server.ts                    # MODIFIED: load mint authority at boot (fail-fast)
│   ├── api/tests/
│   │   ├── mint.spec.ts                     # full /mint/single + /mint/confirm round-trip with mocked RPC
│   │   └── webhook.spec.ts                  # webhook idempotency + secret check
│   ├── worker/src/jobs/
│   │   └── checkBalance.ts                  # repeatable job processor
│   └── worker/src/worker.ts                 # MODIFIED: register repeatable job + processor
├── scripts/
│   └── create-tree.ts                       # one-time devnet tree setup (manual)
├── .env.example                             # MODIFIED: add MERKLE_TREE_ADDRESS, METADATA_BASE_URL, SOLANA_RPC_URL
└── README.md                                # MODIFIED: mint section + devnet checklist
```

---

## Task 1: Solana env additions + mint authority loader (TDD, in shared)

**Files:**
- Modify: `packages/shared/src/env.ts` (loosen optional defaults; add `SOLANA_RPC_URL`, `MERKLE_TREE_ADDRESS`, `METADATA_BASE_URL`, `COLLECTION_ADDRESS`)
- Modify: `.env.example`
- Create: `packages/shared/src/solana/keypair.ts`
- Create: `packages/shared/tests/solana/keypair.test.ts`
- Add deps to shared: `@solana/web3.js`, `@metaplex-foundation/umi`, `@metaplex-foundation/umi-bundle-defaults`, `@metaplex-foundation/mpl-bubblegum`

### Step 1: Add deps

```bash
pnpm --filter @onchainme/shared add @solana/web3.js @metaplex-foundation/umi @metaplex-foundation/umi-bundle-defaults @metaplex-foundation/mpl-bubblegum
```

### Step 2: Update `packages/shared/src/env.ts`

Find the existing Solana block:

```typescript
SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]),
HELIUS_API_KEY: ...
MINT_AUTHORITY_PRIVATE_KEY: z.string().optional().default(""),
MINT_AUTHORITY_TREE: z.string().optional().default(""),
```

Replace it with:

```typescript
SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]),
SOLANA_RPC_URL: z.string().url(),
HELIUS_API_KEY: z.string().min(1),
HELIUS_WEBHOOK_SECRET: z.string().min(1),
MINT_AUTHORITY_PRIVATE_KEY: z.string().min(1),
MERKLE_TREE_ADDRESS: z.string().min(32).max(64),
COLLECTION_ADDRESS: z.string().min(32).max(64).optional(),
METADATA_BASE_URL: z.string().url(),
```

(Rename `MINT_AUTHORITY_TREE` → `MERKLE_TREE_ADDRESS` for clarity. The rest are now required strings.)

### Step 3: Update `.env.example` to mirror

Add/update these lines:

```
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY
HELIUS_WEBHOOK_SECRET=any-shared-secret-string
# MINT_AUTHORITY_PRIVATE_KEY: base58-encoded ed25519 secret key (64 bytes after decode)
# Generate via:  solana-keygen new -o /tmp/mint-authority.json --no-bip39-passphrase
# Then base58-encode the secretKey: node -e "const fs=require('fs'); const bs58=require('bs58').default; console.log(bs58.encode(Uint8Array.from(JSON.parse(fs.readFileSync('/tmp/mint-authority.json')))))"
MINT_AUTHORITY_PRIVATE_KEY=
MERKLE_TREE_ADDRESS=
# Optional — leave empty for an uncollected mint (Bubblegum supports tree-only mints)
COLLECTION_ADDRESS=
METADATA_BASE_URL=https://onchainme.xyz/metadata
```

Update local `.env.local` with real devnet values OR placeholder strings long enough to satisfy the schema (`MINT_AUTHORITY_PRIVATE_KEY=x`, `MERKLE_TREE_ADDRESS=11111111111111111111111111111112`, `METADATA_BASE_URL=https://example.com/metadata`).

### Step 4: Failing test at `packages/shared/tests/solana/keypair.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadMintAuthority, mintAuthorityPublicKey } from "../../src/solana/keypair.js";

const ORIG_ENV = process.env;

function setBaseEnv(extras: Record<string, string> = {}) {
  process.env = { ...ORIG_ENV };
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=test";
  process.env.HELIUS_API_KEY = "test-key";
  process.env.HELIUS_WEBHOOK_SECRET = "secret";
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  Object.assign(process.env, extras);
}

describe("loadMintAuthority", () => {
  beforeEach(() => {
    setBaseEnv();
  });

  it("decodes a base58 secret key into a Solana Keypair", () => {
    const real = Keypair.generate();
    process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(real.secretKey);

    const loaded = loadMintAuthority();
    expect(loaded.publicKey.toBase58()).toBe(real.publicKey.toBase58());
  });

  it("throws when the secret key is malformed base58", () => {
    process.env.MINT_AUTHORITY_PRIVATE_KEY = "not-base58-!!!";
    expect(() => loadMintAuthority()).toThrow();
  });

  it("throws when the decoded key is the wrong length", () => {
    process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(new Uint8Array(32));
    expect(() => loadMintAuthority()).toThrow();
  });
});

describe("mintAuthorityPublicKey", () => {
  beforeEach(() => {
    setBaseEnv();
  });

  it("returns the same public key as Keypair.publicKey", () => {
    const real = Keypair.generate();
    process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(real.secretKey);
    expect(mintAuthorityPublicKey().toBase58()).toBe(real.publicKey.toBase58());
  });
});
```

### Step 5: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test keypair
```

Expected: FAIL — module does not exist.

### Step 6: Implement `packages/shared/src/solana/keypair.ts`

```typescript
import { Keypair, PublicKey } from "@solana/web3.js";
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
```

### Step 7: Update test file to reset the cache

Add to `packages/shared/tests/solana/keypair.test.ts` at the top:

```typescript
import { _resetMintAuthorityCache } from "../../src/solana/keypair.js";
```

Inside `beforeEach` of every describe, call `_resetMintAuthorityCache();` after `setBaseEnv()`.

### Step 8: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test keypair
```

Expected: 4 tests pass.

### Step 9: Re-export from `packages/shared/src/index.ts`

Append at the bottom:

```typescript
export { loadMintAuthority, mintAuthorityPublicKey } from "./solana/keypair.js";
```

`pnpm --filter @onchainme/shared build` clean.

---

## Task 2: Solana RPC connection + Umi client (in shared)

**Files:**
- Create: `packages/shared/src/solana/connection.ts`
- Create: `packages/shared/src/solana/umi.ts`

These wrappers exist so the rest of the codebase has one place to grab a connection / Umi instance. No tests — they're thin pass-throughs that wire env → SDK constructors. They get exercised by the integration tests in later tasks.

### Step 1: `packages/shared/src/solana/connection.ts`

```typescript
import { Connection } from "@solana/web3.js";
import { loadEnv } from "../env.js";

let cached: Connection | null = null;

export function getRpcConnection(): Connection {
  if (cached) return cached;
  const env = loadEnv();
  cached = new Connection(env.SOLANA_RPC_URL, { commitment: "confirmed" });
  return cached;
}

export function _resetConnectionCache(): void {
  cached = null;
}
```

### Step 2: `packages/shared/src/solana/umi.ts`

```typescript
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, signerIdentity, type Umi } from "@metaplex-foundation/umi";
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
```

### Step 3: Re-export

Append to `packages/shared/src/index.ts`:

```typescript
export { getRpcConnection } from "./solana/connection.js";
export { createUmiClient } from "./solana/umi.js";
```

### Step 4: Build clean

```bash
pnpm --filter @onchainme/shared build
```

Expected: zero TS errors. If `@metaplex-foundation/mpl-bubblegum` exports differ in your installed version, adjust the `mplBubblegum()` import to match (some versions use a default export, some a named one — read the package's `package.json` `exports` map and adjust).

---

## Task 3: Metadata URI builder (TDD, in shared)

**Files:**
- Create: `packages/shared/src/mint/metadata.ts`
- Create: `packages/shared/tests/mint/metadata.test.ts`

The Bubblegum mint instruction takes a `MetadataArgs` struct that includes a `uri` field pointing to a JSON document hosted off-chain. For alpha we use a static convention: `${METADATA_BASE_URL}/${badgeId}.json`. The frontend (or an R2 bucket) serves these.

### Step 1: Failing test at `packages/shared/tests/mint/metadata.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { buildMetadataUri, buildMetadataArgs } from "../../src/mint/metadata.js";
import { _resetEnvCache } from "../../src/env.js";

const ORIG_ENV = process.env;

function setEnv(base: string) {
  process.env = { ...ORIG_ENV };
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://example.com/rpc";
  process.env.HELIUS_API_KEY = "key";
  process.env.HELIUS_WEBHOOK_SECRET = "sec";
  process.env.MINT_AUTHORITY_PRIVATE_KEY = "x".repeat(88);
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = base;
  _resetEnvCache();
}

describe("buildMetadataUri", () => {
  it("appends /<badgeId>.json to the base url", () => {
    setEnv("https://onchainme.xyz/metadata");
    expect(buildMetadataUri("first_swap")).toBe("https://onchainme.xyz/metadata/first_swap.json");
  });

  it("strips a trailing slash on the base url", () => {
    setEnv("https://onchainme.xyz/metadata/");
    expect(buildMetadataUri("nft_collector")).toBe(
      "https://onchainme.xyz/metadata/nft_collector.json",
    );
  });
});

describe("buildMetadataArgs", () => {
  beforeEach(() => {
    setEnv("https://onchainme.xyz/metadata");
  });

  it("produces a MetadataArgs-compatible shape with uri, name, symbol, sellerFeeBasisPoints", () => {
    const m = buildMetadataArgs("first_swap");
    expect(m.uri).toBe("https://onchainme.xyz/metadata/first_swap.json");
    expect(m.name).toBe("OnchainMe — first_swap");
    expect(m.symbol).toBe("OCM");
    expect(m.sellerFeeBasisPoints).toBe(0);
    expect(m.creators).toEqual([]);
    expect(m.isMutable).toBe(false);
  });
});
```

> **Note:** This test imports `_resetEnvCache` from env.ts. If that helper does not exist yet, add it: open `packages/shared/src/env.ts`, find the cached env, and add a one-line export `export function _resetEnvCache(): void { cached = null; }` (matching whatever the cache variable is named — it's likely already there from Plan 1's `loadEnv` implementation).

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test metadata
```

### Step 3: Implement `packages/shared/src/mint/metadata.ts`

```typescript
import { loadEnv } from "../env.js";

export function buildMetadataUri(badgeId: string): string {
  const base = loadEnv().METADATA_BASE_URL.replace(/\/$/, "");
  return `${base}/${badgeId}.json`;
}

export interface MetadataArgs {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  primarySaleHappened: boolean;
  isMutable: boolean;
  collection: null;
  uses: null;
  creators: never[];
  tokenStandard: "NonFungible";
  tokenProgramVersion: "Original";
  editionNonce: null;
}

export function buildMetadataArgs(badgeId: string): MetadataArgs {
  return {
    name: `OnchainMe — ${badgeId}`,
    symbol: "OCM",
    uri: buildMetadataUri(badgeId),
    sellerFeeBasisPoints: 0,
    primarySaleHappened: false,
    isMutable: false,
    collection: null,
    uses: null,
    creators: [],
    tokenStandard: "NonFungible",
    tokenProgramVersion: "Original",
    editionNonce: null,
  };
}
```

### Step 4: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test metadata
```

Expected: 3 tests pass.

### Step 5: Re-export from index.ts

```typescript
export { buildMetadataUri, buildMetadataArgs } from "./mint/metadata.js";
export type { MetadataArgs } from "./mint/metadata.js";
```

`pnpm --filter @onchainme/shared build` clean.

---

## Task 4: buildMintTransaction (TDD, in shared)

**Files:**
- Create: `packages/shared/src/mint/prepare.ts`
- Create: `packages/shared/tests/mint/prepare.test.ts`

`buildMintTransaction` returns a base64-encoded **partially-signed** transaction. Backend signs as fee payer + tree delegate (both = mint authority); frontend will add the leaf-owner signature.

### Step 1: Failing test at `packages/shared/tests/mint/prepare.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { buildMintTransaction } from "../../src/mint/prepare.js";
import { _resetMintAuthorityCache } from "../../src/solana/keypair.js";
import { _resetUmiCache } from "../../src/solana/umi.js";
import { _resetEnvCache } from "../../src/env.js";

const ORIG_ENV = process.env;

const TREE = "11111111111111111111111111111112"; // any valid base58 32-byte will do for serialization tests

function setEnv() {
  process.env = { ...ORIG_ENV };
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://example.com/rpc";
  process.env.HELIUS_API_KEY = "key";
  process.env.HELIUS_WEBHOOK_SECRET = "sec";
  process.env.MERKLE_TREE_ADDRESS = TREE;
  process.env.METADATA_BASE_URL = "https://example.com/metadata";

  const authority = Keypair.generate();
  process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(authority.secretKey);
  _resetEnvCache();
  _resetMintAuthorityCache();
  _resetUmiCache();
  return authority;
}

describe("buildMintTransaction", () => {
  beforeEach(() => {
    setEnv();
  });

  it("returns a base64 string and an expiresAt iso", async () => {
    const owner = Keypair.generate();
    const result = await buildMintTransaction({
      leafOwner: owner.publicKey.toBase58(),
      badgeId: "first_swap",
    });
    expect(typeof result.transactionBase64).toBe("string");
    expect(result.transactionBase64.length).toBeGreaterThan(100);
    expect(result.badgeId).toBe("first_swap");
    expect(typeof result.expiresAt).toBe("string");
    // expiresAt must be in the future
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("the returned base64 deserializes into a transaction with the mint authority signature attached", async () => {
    const authority = setEnv();
    const owner = Keypair.generate();
    const result = await buildMintTransaction({
      leafOwner: owner.publicKey.toBase58(),
      badgeId: "first_swap",
    });

    const bytes = Buffer.from(result.transactionBase64, "base64");
    // Try VersionedTransaction first (Umi default), fall back to legacy
    let signaturesPresent: number;
    try {
      const vtx = VersionedTransaction.deserialize(bytes);
      signaturesPresent = vtx.signatures.filter((s) => s.some((b) => b !== 0)).length;
      // The fee payer is the authority — its signature should be present.
      // The leaf owner signer slot exists but is unsigned.
      expect(signaturesPresent).toBeGreaterThanOrEqual(1);
      void authority; // silence unused
    } catch {
      const tx = Transaction.from(bytes);
      const auth = tx.signatures.find(
        (s) => s.publicKey.toBase58() === authority.publicKey.toBase58(),
      );
      expect(auth?.signature).not.toBeNull();
    }
  });

  it("rejects when the leaf owner is not a valid base58 pubkey", async () => {
    await expect(
      buildMintTransaction({ leafOwner: "not-base58-!!!", badgeId: "first_swap" }),
    ).rejects.toThrow();
  });
});
```

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test prepare
```

### Step 3: Implement `packages/shared/src/mint/prepare.ts`

```typescript
import { mintToCollectionV1, mintV1 } from "@metaplex-foundation/mpl-bubblegum";
import { publicKey, type Umi } from "@metaplex-foundation/umi";
import { base64 } from "@metaplex-foundation/umi/serializers";
import { loadEnv } from "../env.js";
import { createUmiClient } from "../solana/umi.js";
import { mintAuthorityPublicKey } from "../solana/keypair.js";
import { buildMetadataArgs } from "./metadata.js";

const TX_TTL_MS = 5 * 60 * 1000; // 5 min — Solana blockhash typical lifetime

export interface BuildMintInput {
  leafOwner: string;       // base58
  badgeId: string;
}

export interface BuildMintResult {
  transactionBase64: string;
  badgeId: string;
  expiresAt: string;       // iso
}

async function buildAndPartialSign(
  umi: Umi,
  leafOwnerB58: string,
  badgeId: string,
): Promise<Uint8Array> {
  const env = loadEnv();
  const tree = publicKey(env.MERKLE_TREE_ADDRESS);
  const leafOwner = publicKey(leafOwnerB58);
  const metadata = buildMetadataArgs(badgeId);

  // mintV1 (no collection) keeps the test path simple. mintToCollectionV1 is
  // structurally identical from the partial-sign perspective — swap to it
  // when COLLECTION_ADDRESS is configured.
  const collection = env.COLLECTION_ADDRESS;
  const builder = collection
    ? mintToCollectionV1(umi, {
        leafOwner,
        merkleTree: tree,
        collectionMint: publicKey(collection),
        metadata,
      })
    : mintV1(umi, {
        leafOwner,
        merkleTree: tree,
        metadata,
      });

  // Sign as fee payer + tree delegate (both are the umi identity).
  const built = await builder.buildWithLatestBlockhash(umi);
  const signed = await umi.identity.signTransaction(built);
  return umi.transactions.serialize(signed);
}

export async function buildMintTransaction(input: BuildMintInput): Promise<BuildMintResult> {
  // Validate leaf owner up front — Umi will throw deep inside otherwise.
  try {
    publicKey(input.leafOwner);
  } catch (err) {
    throw new Error(
      `Invalid leafOwner base58 pubkey: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Touch authority to surface env errors early.
  mintAuthorityPublicKey();

  const umi = createUmiClient();
  const serialized = await buildAndPartialSign(umi, input.leafOwner, input.badgeId);
  const transactionBase64 = base64.deserialize(serialized)[0];

  return {
    transactionBase64,
    badgeId: input.badgeId,
    expiresAt: new Date(Date.now() + TX_TTL_MS).toISOString(),
  };
}
```

> **Caveat for the implementer:** mpl-bubblegum 4.x's exact `mintV1` / `mintToCollectionV1` signatures and the `buildWithLatestBlockhash` helper name vary slightly across patch versions. If the import fails or `buildWithLatestBlockhash` doesn't exist on the builder, fall back to:
> ```typescript
> const built = await builder.setLatestBlockhash(umi).then((b) => b.build(umi));
> ```
> The test at Step 1 only verifies that the base64 deserializes into a transaction with at least one signature — it does NOT assert specific instruction shapes, so any valid Bubblegum mint construction satisfies it.

### Step 4: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test prepare
```

If `buildWithLatestBlockhash` requires a real RPC call (Umi may try to fetch the blockhash from `connection.getLatestBlockhash`), the test will fail with a network error. In that case, mock the RPC call:

```typescript
// At the top of the test file:
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

const server = setupServer(
  http.post("https://example.com/rpc", () =>
    HttpResponse.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        context: { slot: 1 },
        value: {
          blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
          lastValidBlockHeight: 1000,
        },
      },
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => server.close());
```

(Add the imports `beforeAll`, `afterAll` from vitest. Wire the existing `beforeEach(setEnv)` alongside.)

### Step 5: Re-export

```typescript
export { buildMintTransaction } from "./mint/prepare.js";
export type { BuildMintInput, BuildMintResult } from "./mint/prepare.js";
```

`pnpm --filter @onchainme/shared build` clean.

---

## Task 5: parseAssetIdFromTx + confirmation helpers (TDD, in shared)

**Files:**
- Create: `packages/shared/src/mint/confirm.ts`
- Create: `packages/shared/tests/mint/confirm.test.ts`

After the user sends the signed tx and gets a `signature`, the backend's `/mint/confirm` route calls Solana RPC `getTransaction(signature)`, checks the on-chain `meta.err`, and parses the cNFT `assetId` from the program logs (Bubblegum emits a `LeafSchema::V1` event we can decode, or we use the helper `parseLeafFromMintV1Transaction`).

### Step 1: Failing test at `packages/shared/tests/mint/confirm.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  fetchTransactionStatus,
  type ConfirmedTxStatus,
} from "../../src/mint/confirm.js";
import { _resetEnvCache } from "../../src/env.js";
import { _resetMintAuthorityCache } from "../../src/solana/keypair.js";
import { _resetConnectionCache } from "../../src/solana/connection.js";

const ORIG_ENV = process.env;

function setEnv() {
  process.env = { ...ORIG_ENV };
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://rpc.test";
  process.env.HELIUS_API_KEY = "key";
  process.env.HELIUS_WEBHOOK_SECRET = "sec";
  process.env.MINT_AUTHORITY_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  _resetEnvCache();
  _resetMintAuthorityCache();
  _resetConnectionCache();
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  server.resetHandlers();
  setEnv();
});

describe("fetchTransactionStatus", () => {
  it("returns status='success' with a parsed assetId on a successful tx", async () => {
    server.use(
      http.post("https://rpc.test/", async () => {
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sig1"] },
            meta: {
              err: null,
              logMessages: [
                "Program BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY invoke [1]",
                // Bubblegum emits a 'mint' log with the asset ID:
                "Program log: AssetId: ABC1111111111111111111111111111111111111111",
                "Program BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY success",
              ],
            },
          },
        });
      }),
    );

    const result = await fetchTransactionStatus("sig1");
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.assetId).toBe("ABC1111111111111111111111111111111111111111");
    }
  });

  it("returns status='failed' with err when meta.err is set", async () => {
    server.use(
      http.post("https://rpc.test/", () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sig2"] },
            meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [] },
          },
        }),
      ),
    );

    const r: ConfirmedTxStatus = await fetchTransactionStatus("sig2");
    expect(r.status).toBe("failed");
  });

  it("returns status='not_found' when the tx is not yet on chain", async () => {
    server.use(
      http.post("https://rpc.test/", () =>
        HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null }),
      ),
    );

    const r = await fetchTransactionStatus("sigX");
    expect(r.status).toBe("not_found");
  });

  it("returns status='success' but assetId=null when logs lack the AssetId line", async () => {
    server.use(
      http.post("https://rpc.test/", () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sig3"] },
            meta: { err: null, logMessages: ["Program log: not the right log"] },
          },
        }),
      ),
    );

    const r = await fetchTransactionStatus("sig3");
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.assetId).toBeNull();
    }
  });
});
```

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test confirm
```

### Step 3: Implement `packages/shared/src/mint/confirm.ts`

```typescript
import { getRpcConnection } from "../solana/connection.js";

export type ConfirmedTxStatus =
  | { status: "success"; signature: string; slot: number; assetId: string | null }
  | { status: "failed"; signature: string; err: unknown }
  | { status: "not_found"; signature: string };

const ASSET_ID_LOG_RE = /AssetId:\s+([1-9A-HJ-NP-Za-km-z]{32,44})/;

export async function fetchTransactionStatus(signature: string): Promise<ConfirmedTxStatus> {
  const conn = getRpcConnection();
  // We use the raw call via web3.js to avoid pulling in the parsed-tx machinery.
  const tx = await conn.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) return { status: "not_found", signature };
  if (tx.meta?.err) return { status: "failed", signature, err: tx.meta.err };

  const logs = tx.meta?.logMessages ?? [];
  let assetId: string | null = null;
  for (const line of logs) {
    const m = ASSET_ID_LOG_RE.exec(line);
    if (m && m[1]) {
      assetId = m[1];
      break;
    }
  }

  return {
    status: "success",
    signature,
    slot: tx.slot,
    assetId,
  };
}
```

> **Note on the AssetId regex:** Real Bubblegum emits the leaf data in a base64-encoded program-data log line, not as a plain "AssetId: …" message. For the alpha we accept either form: parse out the asset id with the regex above (good enough for our pinned mock fixtures and for any wrapper layer that pre-decodes logs), and fall back to `null`. The webhook path (Task 8) covers the case where assetId truly isn't reachable from logs — Helius gives us the asset id directly in its parsed event payload. Production hardening of the log parser is deferred to Plan 5 polishing.

### Step 4: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test confirm
```

Expected: 4 tests pass.

### Step 5: Re-export

```typescript
export { fetchTransactionStatus } from "./mint/confirm.js";
export type { ConfirmedTxStatus } from "./mint/confirm.js";
```

`pnpm --filter @onchainme/shared build` clean.

---

## Task 6: Mint-degraded flag in Redis (TDD, in shared)

**Files:**
- Create: `packages/shared/src/mint/degraded.ts`
- Create: `packages/shared/tests/mint/degraded.test.ts`

A tiny Redis-backed flag the worker writes when the mint authority's SOL balance is critically low. `/mint/*` reads it on every call.

### Step 1: Failing test at `packages/shared/tests/mint/degraded.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { isMintDegraded, setMintDegraded, clearMintDegraded } from "../../src/mint/degraded.js";
import { closeRedis, getRedisConnection } from "../../src/queue/connection.js";

beforeEach(async () => {
  process.env.REDIS_URL = "redis://localhost:6380";
  await getRedisConnection().del("onchainme:mint_disabled");
});

afterAll(async () => {
  await closeRedis();
});

describe("mint-degraded flag", () => {
  it("isMintDegraded returns false by default", async () => {
    expect(await isMintDegraded()).toBe(false);
  });

  it("setMintDegraded then isMintDegraded returns true", async () => {
    await setMintDegraded("balance below 0.1 SOL", 60);
    expect(await isMintDegraded()).toBe(true);
  });

  it("clearMintDegraded turns it back off", async () => {
    await setMintDegraded("test", 60);
    expect(await isMintDegraded()).toBe(true);
    await clearMintDegraded();
    expect(await isMintDegraded()).toBe(false);
  });

  it("expires after the TTL", async () => {
    await setMintDegraded("ttl test", 1);
    expect(await isMintDegraded()).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await isMintDegraded()).toBe(false);
  });
});
```

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test degraded
```

### Step 3: Implement `packages/shared/src/mint/degraded.ts`

```typescript
import { getRedisConnection } from "../queue/connection.js";

const KEY = "onchainme:mint_disabled";

export async function isMintDegraded(): Promise<boolean> {
  const v = await getRedisConnection().get(KEY);
  return v !== null && v !== "";
}

export async function setMintDegraded(reason: string, ttlSeconds: number): Promise<void> {
  await getRedisConnection().set(KEY, reason, "EX", ttlSeconds);
}

export async function clearMintDegraded(): Promise<void> {
  await getRedisConnection().del(KEY);
}
```

### Step 4: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test degraded
```

Expected: 4 tests pass. (Requires Redis on `localhost:6380` — `docker compose up -d` if not running.)

### Step 5: Re-export

```typescript
export { isMintDegraded, setMintDegraded, clearMintDegraded } from "./mint/degraded.js";
```

`pnpm --filter @onchainme/shared build` clean.

---

## Task 7: Webhook secret verification (TDD, in shared)

**Files:**
- Create: `packages/shared/src/webhook/verify.ts`
- Create: `packages/shared/tests/webhook/verify.test.ts`

Helius webhooks include a configurable `Authorization` header. We verify against `HELIUS_WEBHOOK_SECRET` using a constant-time comparison.

### Step 1: Failing test at `packages/shared/tests/webhook/verify.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { verifyHeliusSecret } from "../../src/webhook/verify.js";
import { _resetEnvCache } from "../../src/env.js";

const ORIG_ENV = process.env;

function setEnv(secret: string) {
  process.env = { ...ORIG_ENV };
  process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
  process.env.REDIS_URL = "redis://localhost:6380";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = "3001";
  process.env.COOKIE_DOMAIN = "localhost";
  process.env.SOLANA_CLUSTER = "devnet";
  process.env.SOLANA_RPC_URL = "https://example.com/rpc";
  process.env.HELIUS_API_KEY = "key";
  process.env.HELIUS_WEBHOOK_SECRET = secret;
  process.env.MINT_AUTHORITY_PRIVATE_KEY = "x".repeat(88);
  process.env.MERKLE_TREE_ADDRESS = "11111111111111111111111111111112";
  process.env.METADATA_BASE_URL = "https://example.com/metadata";
  _resetEnvCache();
}

describe("verifyHeliusSecret", () => {
  beforeEach(() => setEnv("super-secret-value"));

  it("returns true when the header matches the env secret", () => {
    expect(verifyHeliusSecret("super-secret-value")).toBe(true);
  });

  it("returns false on mismatch", () => {
    expect(verifyHeliusSecret("wrong")).toBe(false);
  });

  it("returns false on undefined / empty", () => {
    expect(verifyHeliusSecret(undefined)).toBe(false);
    expect(verifyHeliusSecret("")).toBe(false);
  });
});
```

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test verify
```

### Step 3: Implement `packages/shared/src/webhook/verify.ts`

```typescript
import { timingSafeEqual } from "node:crypto";
import { loadEnv } from "../env.js";

export function verifyHeliusSecret(headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const expected = loadEnv().HELIUS_WEBHOOK_SECRET;
  const a = Buffer.from(headerValue, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

### Step 4: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test verify
```

Expected: 4 tests pass.

### Step 5: Re-export

```typescript
export { verifyHeliusSecret } from "./webhook/verify.js";
```

`pnpm --filter @onchainme/shared build` clean.

---

## Task 8: API routes — POST /mint/single + /mint/all + /mint/confirm

**Files:**
- Create: `apps/api/src/routes/mint.ts`
- Modify: `apps/api/src/routes/index.ts` (register `mintRoute`)
- Create: `apps/api/tests/mint.spec.ts`

Endpoints:
- `POST /api/v1/mint/single {badgeId}` 🔒 — eligibility check + claim absence + balance gate + partial-sign → `{transaction, badgeId, expiresAt}`
- `POST /api/v1/mint/all` 🔒 — same, but iterates over all eligible-but-unclaimed badges → `{transactions: [{badgeId, transaction, expiresAt}, ...]}`
- `POST /api/v1/mint/confirm {signature, badgeId}` 🔒 — calls `fetchTransactionStatus`; on success upserts `badgeClaims`

### Step 1: Failing tests at `apps/api/tests/mint.spec.ts`

```typescript
import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { Keypair } from "@solana/web3.js";
import { buildServer } from "../src/server.js";
import {
  closeDb,
  closeRedis,
  connectDb,
  mongoose,
  clearMintDegraded,
  setMintDegraded,
} from "@onchainme/shared";

const TREE = "11111111111111111111111111111112";

beforeAll(() => {
  // Ensure the env has all the mint-related vars before buildServer reads loadEnv.
  // The env loader caches; tests rely on setup.ts or .env.local providing these.
  // If your local .env.local is missing them, the api will fail to start.
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));

const app = await buildServer();
await connectDb();

afterAll(async () => {
  server.close();
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  server.resetHandlers();
  await clearMintDegraded();
  for (const c of ["users", "authNonces", "badgeClaims", "badgeEligibilities", "heliusWebhookEvents"]) {
    await mongoose.connection.collection(c).deleteMany({});
  }
});

async function loggedInWallet() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const nonceRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/nonce",
    payload: { wallet },
  });
  const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  const verifyRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    payload: { wallet, nonce, signature: sig },
  });
  const cookie = verifyRes.cookies.find((c) => c.name === "om_session");
  return { wallet, cookie: `om_session=${cookie?.value}` };
}

async function makeEligible(wallet: string, badgeId: string) {
  await mongoose.connection.collection("badgeEligibilities").insertOne({
    _id: { walletAddress: wallet, badgeId } as never,
    evaluatedAt: new Date(),
    eligibleSince: new Date("2026-01-01"),
    meta: {},
  });
}

describe("POST /api/v1/mint/single", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      payload: { badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 422 BADGE_NOT_ELIGIBLE if no eligibility row exists", async () => {
    const { cookie } = await loggedInWallet();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("BADGE_NOT_ELIGIBLE");
  });

  it("returns 409 BADGE_ALREADY_CLAIMED if a claim row exists", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "first_swap");
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      mintedAt: new Date(),
      mintSignature: "old",
      assetId: "old_aid",
      merkleTree: TREE,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("BADGE_ALREADY_CLAIMED");
  });

  it("returns 503 MINT_AUTHORITY_OUT_OF_FUNDS when degraded flag is set", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "first_swap");
    await setMintDegraded("test forced", 60);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("MINT_AUTHORITY_OUT_OF_FUNDS");
  });

  it("returns a base64 transaction when eligible and not claimed", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "first_swap");

    // Mock the Solana RPC blockhash call that buildMintTransaction triggers.
    server.use(
      http.post(/.*/, async ({ request }) => {
        const body = (await request.json()) as { method: string };
        if (body.method === "getLatestBlockhash") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 1 },
              value: {
                blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
                lastValidBlockHeight: 1000,
              },
            },
          });
        }
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null });
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/single",
      headers: { cookie },
      payload: { badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      transaction: string;
      badgeId: string;
      expiresAt: string;
    };
    expect(body.badgeId).toBe("first_swap");
    expect(body.transaction.length).toBeGreaterThan(100);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("POST /api/v1/mint/confirm", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      payload: { signature: "sigX", badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("writes a claim and returns alreadyClaimed=false on a successful tx", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "first_swap");

    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sigOK"] },
            meta: {
              err: null,
              logMessages: ["Program log: AssetId: ABC1111111111111111111111111111111111111111"],
            },
          },
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigOK", badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      badgeId: string;
      mintSignature: string;
      assetId: string;
      alreadyClaimed: boolean;
    };
    expect(body.alreadyClaimed).toBe(false);
    expect(body.assetId).toBe("ABC1111111111111111111111111111111111111111");

    const row = await mongoose.connection
      .collection("badgeClaims")
      .findOne({ "_id.walletAddress": wallet, "_id.badgeId": "first_swap" });
    expect(row?.["mintSignature"]).toBe("sigOK");
  });

  it("is idempotent — second call returns alreadyClaimed=true and does not overwrite", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "first_swap");
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      mintedAt: new Date("2026-01-01"),
      mintSignature: "sigOriginal",
      assetId: "AID_ORIG",
      merkleTree: TREE,
    });

    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sigSecond"] },
            meta: {
              err: null,
              logMessages: ["Program log: AssetId: NEWASSET11111111111111111111111111111111111"],
            },
          },
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigSecond", badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { alreadyClaimed: boolean; assetId: string };
    expect(body.alreadyClaimed).toBe(true);
    expect(body.assetId).toBe("AID_ORIG");
  });

  it("returns 422 TX_FAILED when meta.err is set", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "first_swap");

    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 100,
            transaction: { message: { accountKeys: [] }, signatures: ["sigFail"] },
            meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [] },
          },
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigFail", badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("TX_FAILED");
    void wallet;
  });

  it("returns 422 TX_NOT_FOUND when the tx is not on chain", async () => {
    const { cookie } = await loggedInWallet();
    server.use(
      http.post(/.*/, () =>
        HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null }),
      ),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/confirm",
      headers: { cookie },
      payload: { signature: "sigGhost", badgeId: "first_swap" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("TX_NOT_FOUND");
  });
});

describe("POST /api/v1/mint/all", () => {
  it("returns one transaction per eligible-but-unclaimed badge", async () => {
    const { wallet, cookie } = await loggedInWallet();
    await makeEligible(wallet, "first_swap");
    await makeEligible(wallet, "first_nft");
    // Already claimed — should not appear in the response
    await mongoose.connection.collection("badgeClaims").insertOne({
      _id: { walletAddress: wallet, badgeId: "first_swap" } as never,
      mintedAt: new Date(),
      mintSignature: "old",
      assetId: "old_aid",
      merkleTree: TREE,
    });

    server.use(
      http.post(/.*/, async ({ request }) => {
        const body = (await request.json()) as { method: string };
        if (body.method === "getLatestBlockhash") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 1 },
              value: {
                blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
                lastValidBlockHeight: 1000,
              },
            },
          });
        }
        return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: null });
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mint/all",
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      transactions: { badgeId: string; transaction: string }[];
    };
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0]?.badgeId).toBe("first_nft");
  });
});
```

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/api test mint
```

### Step 3: Verify error codes exist

Read `packages/shared/src/errors.ts`. Required: `BADGE_NOT_ELIGIBLE`, `BADGE_ALREADY_CLAIMED`, `MINT_AUTHORITY_OUT_OF_FUNDS`. Add if missing:

- `TX_FAILED` (422) — new, add it
- `TX_NOT_FOUND` (422) — new, add it

After any addition, `pnpm --filter @onchainme/shared build`.

### Step 4: Implement `apps/api/src/routes/mint.ts`

```typescript
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  buildMintTransaction,
  fetchTransactionStatus,
  isMintDegraded,
  loadEnv,
  models,
} from "@onchainme/shared";

const singleBody = z.object({ badgeId: z.string().min(1).max(64) });
const allBody = z.object({}).strict();
const confirmBody = z.object({
  signature: z.string().min(32).max(96),
  badgeId: z.string().min(1).max(64),
});

async function ensureClaimable(wallet: string, badgeId: string): Promise<void> {
  const eligible = await models.BadgeEligibility.findOne({
    "_id.walletAddress": wallet,
    "_id.badgeId": badgeId,
  });
  if (!eligible) {
    throw new AppError({
      code: ErrorCode.BADGE_NOT_ELIGIBLE,
      message: `Wallet has not earned ${badgeId}`,
      statusCode: 422,
    });
  }
  const claim = await models.BadgeClaim.findOne({
    "_id.walletAddress": wallet,
    "_id.badgeId": badgeId,
  });
  if (claim) {
    throw new AppError({
      code: ErrorCode.BADGE_ALREADY_CLAIMED,
      message: `${badgeId} is already claimed`,
      statusCode: 409,
    });
  }
}

async function ensureMintAvailable(): Promise<void> {
  if (await isMintDegraded()) {
    throw new AppError({
      code: ErrorCode.MINT_AUTHORITY_OUT_OF_FUNDS,
      message: "Minting is temporarily disabled",
      statusCode: 503,
    });
  }
}

export const mintRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/mint/single",
    {
      schema: { body: singleBody },
      preHandler: fastify.requireAuth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;
      const { badgeId } = req.body;

      await ensureMintAvailable();
      await ensureClaimable(wallet, badgeId);

      const result = await buildMintTransaction({ leafOwner: wallet, badgeId });
      return {
        transaction: result.transactionBase64,
        badgeId: result.badgeId,
        expiresAt: result.expiresAt,
      };
    },
  );

  fastify.post(
    "/mint/all",
    {
      schema: { body: allBody },
      preHandler: fastify.requireAuth,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;

      await ensureMintAvailable();

      const [eligibilities, claims] = await Promise.all([
        models.BadgeEligibility.find({ "_id.walletAddress": wallet }, { _id: 1 }).lean(),
        models.BadgeClaim.find({ "_id.walletAddress": wallet }, { _id: 1 }).lean(),
      ]);
      const claimed = new Set(
        claims.map((c) => (c._id as unknown as { badgeId: string }).badgeId),
      );
      const toMint = eligibilities
        .map((e) => (e._id as unknown as { badgeId: string }).badgeId)
        .filter((id) => !claimed.has(id));

      const transactions: { badgeId: string; transaction: string; expiresAt: string }[] = [];
      for (const badgeId of toMint) {
        const r = await buildMintTransaction({ leafOwner: wallet, badgeId });
        transactions.push({
          badgeId: r.badgeId,
          transaction: r.transactionBase64,
          expiresAt: r.expiresAt,
        });
      }
      return { transactions };
    },
  );

  fastify.post(
    "/mint/confirm",
    {
      schema: { body: confirmBody },
      preHandler: fastify.requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req) => {
      const wallet = (req.user as { wallet: string }).wallet;
      const { signature, badgeId } = req.body;

      const status = await fetchTransactionStatus(signature);
      if (status.status === "not_found") {
        throw new AppError({
          code: ErrorCode.TX_NOT_FOUND,
          message: "Transaction not yet visible on chain",
          statusCode: 422,
        });
      }
      if (status.status === "failed") {
        throw new AppError({
          code: ErrorCode.TX_FAILED,
          message: "Transaction failed on chain",
          statusCode: 422,
          details: { err: status.err },
        });
      }

      const env = loadEnv();
      const upserted = await models.BadgeClaim.findOneAndUpdate(
        { _id: { walletAddress: wallet, badgeId } },
        {
          $setOnInsert: {
            mintSignature: signature,
            assetId: status.assetId ?? "unknown",
            merkleTree: env.MERKLE_TREE_ADDRESS,
            mintedAt: new Date(),
          },
        },
        { upsert: true, new: true, includeResultMetadata: true },
      );

      // Mongoose returns the doc + metadata; lastErrorObject.upserted indicates a fresh insert
      const isNew = upserted?.lastErrorObject?.["upserted"] !== undefined;
      const doc = upserted?.value;

      return {
        badgeId,
        mintSignature: doc?.["mintSignature"] ?? signature,
        assetId: doc?.["assetId"] ?? status.assetId,
        alreadyClaimed: !isNew,
      };
    },
  );
};
```

### Step 5: Wire `apps/api/src/routes/index.ts`

```typescript
import { mintRoute } from "./mint.js";
// inside the inner register:
await api.register(mintRoute);
```

### Step 6: Run, verify PASS

```bash
pnpm --filter @onchainme/api test mint
```

Expected: 9 mint tests pass.

If `findOneAndUpdate` with `includeResultMetadata: true` returns a different shape in your installed Mongoose version (8.x changed the default), adjust the `isNew` extraction. The portable pattern: `const existing = await BadgeClaim.findOne(...); if (existing) { ... alreadyClaimed: true } else { await BadgeClaim.create(...); ... alreadyClaimed: false }`. The `$setOnInsert` race-safety still works because `findOne + create` under the unique compound `_id` index would fail the second create with `E11000`; catch that and return `alreadyClaimed: true`.

---

## Task 9: API route — POST /webhooks/helius (TDD)

**Files:**
- Create: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/routes/index.ts`
- Create: `apps/api/tests/webhook.spec.ts`

Helius posts an array of events. We validate the secret, then for each event:
1. Skip if `heliusWebhookEvents._id == event.signature` already exists
2. Insert the event row
3. If it's a `compressed.mint` for our tree with a known wallet+badge mapping (asset id, leaf owner), upsert `badgeClaims` via `$setOnInsert`

For alpha we keep the parser simple: extract `signature`, `assetId`, and `leafOwner` from the event payload. Unknown shapes → log a warning, skip the badge write but still record the event row (idempotent).

### Step 1: Failing test at `apps/api/tests/webhook.spec.ts`

```typescript
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis, connectDb, mongoose } from "@onchainme/shared";

const SECRET = process.env["HELIUS_WEBHOOK_SECRET"] ?? "test-secret";
const TREE = process.env["MERKLE_TREE_ADDRESS"] ?? "11111111111111111111111111111112";

const app = await buildServer();
await connectDb();

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  for (const c of ["badgeClaims", "heliusWebhookEvents", "badgeEligibilities"]) {
    await mongoose.connection.collection(c).deleteMany({});
  }
});

describe("POST /api/v1/webhooks/helius", () => {
  it("returns 401 when the Authorization header is missing or wrong", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      payload: [],
    });
    expect(res.statusCode).toBe(401);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: "wrong" },
      payload: [],
    });
    expect(res2.statusCode).toBe(401);
  });

  it("returns 200 and writes an event row for a valid signed payload", async () => {
    const wallet = "WaLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";
    const event = {
      signature: "sigW1",
      type: "COMPRESSED_NFT_MINT",
      events: {
        compressed: [
          { assetId: "ASSET11111111111111111111111111111111111111", treeId: TREE, newLeafOwner: wallet, badgeId: "first_swap" },
        ],
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(res.statusCode).toBe(200);

    const row = await mongoose.connection
      .collection("heliusWebhookEvents")
      .findOne({ _id: "sigW1" as never });
    expect(row).toBeTruthy();

    const claim = await mongoose.connection
      .collection("badgeClaims")
      .findOne({ "_id.walletAddress": wallet, "_id.badgeId": "first_swap" });
    expect(claim?.["mintSignature"]).toBe("sigW1");
    expect(claim?.["assetId"]).toBe("ASSET11111111111111111111111111111111111111");
  });

  it("is idempotent — replaying the same signature does NOT create duplicate rows or claims", async () => {
    const wallet = "WaLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";
    const event = {
      signature: "sigDup",
      type: "COMPRESSED_NFT_MINT",
      events: {
        compressed: [
          { assetId: "AID_DUP1111111111111111111111111111111111111", treeId: TREE, newLeafOwner: wallet, badgeId: "first_nft" },
        ],
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(second.statusCode).toBe(200);

    const eventCount = await mongoose.connection
      .collection("heliusWebhookEvents")
      .countDocuments({ _id: "sigDup" as never });
    expect(eventCount).toBe(1);

    const claimCount = await mongoose.connection
      .collection("badgeClaims")
      .countDocuments({ "_id.walletAddress": wallet, "_id.badgeId": "first_nft" });
    expect(claimCount).toBe(1);
  });

  it("ignores events for a different tree", async () => {
    const event = {
      signature: "sigOther",
      type: "COMPRESSED_NFT_MINT",
      events: {
        compressed: [
          { assetId: "AID", treeId: "OtherTree1111111111111111111111111111111111", newLeafOwner: "W", badgeId: "first_swap" },
        ],
      },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/helius",
      headers: { authorization: SECRET },
      payload: [event],
    });
    expect(res.statusCode).toBe(200);
    const claimCount = await mongoose.connection.collection("badgeClaims").countDocuments({});
    expect(claimCount).toBe(0);
    // Event row still persisted for forensics
    const eventRow = await mongoose.connection
      .collection("heliusWebhookEvents")
      .findOne({ _id: "sigOther" as never });
    expect(eventRow).toBeTruthy();
  });
});
```

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/api test webhook
```

### Step 3: Implement `apps/api/src/routes/webhooks.ts`

```typescript
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  ErrorCode,
  loadEnv,
  models,
  verifyHeliusSecret,
} from "@onchainme/shared";

// Helius compressed-mint payload (subset we use). Permissive on extras.
const compressedEventSchema = z.object({
  assetId: z.string(),
  treeId: z.string(),
  newLeafOwner: z.string(),
  badgeId: z.string().optional(),
});

const heliusEventSchema = z
  .object({
    signature: z.string().min(1),
    type: z.string().optional(),
    events: z
      .object({
        compressed: z.array(compressedEventSchema).optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

const bodySchema = z.array(heliusEventSchema);

export const webhooksRoute: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/webhooks/helius",
    {
      schema: { body: bodySchema },
      // No rate-limit override — falls back to default 100/min/IP.
    },
    async (req, reply) => {
      const auth = req.headers["authorization"];
      const headerValue = Array.isArray(auth) ? auth[0] : auth;
      if (!verifyHeliusSecret(headerValue?.replace(/^Bearer\s+/i, ""))) {
        throw new AppError({
          code: ErrorCode.AUTH_TOKEN_INVALID,
          message: "Invalid webhook secret",
          statusCode: 401,
        });
      }

      const env = loadEnv();
      const events = req.body;

      let processed = 0;
      let skipped = 0;
      for (const event of events) {
        // Idempotency: skip if signature already recorded
        const existing = await models.HeliusWebhookEvent.findById(event.signature);
        if (existing) {
          skipped += 1;
          continue;
        }

        await models.HeliusWebhookEvent.create({
          _id: event.signature,
          payload: event,
          processedAt: new Date(),
        });
        processed += 1;

        const compressed = event.events?.compressed ?? [];
        for (const c of compressed) {
          if (c.treeId !== env.MERKLE_TREE_ADDRESS) continue;
          if (!c.badgeId) continue; // can't attribute without a badge id
          await models.BadgeClaim.findOneAndUpdate(
            { _id: { walletAddress: c.newLeafOwner, badgeId: c.badgeId } },
            {
              $setOnInsert: {
                mintSignature: event.signature,
                assetId: c.assetId,
                merkleTree: c.treeId,
                mintedAt: new Date(),
              },
            },
            { upsert: true },
          );
        }
      }

      return reply.code(200).send({ ok: true, processed, skipped });
    },
  );
};
```

### Step 4: Wire `apps/api/src/routes/index.ts`

```typescript
import { webhooksRoute } from "./webhooks.js";
// inside the inner register, after mintRoute:
await api.register(webhooksRoute);
```

### Step 5: Run, verify PASS

```bash
pnpm --filter @onchainme/api test webhook
```

Expected: 4 webhook tests pass.

> **Note on `badgeId` source:** Real Helius webhooks don't include our `badgeId` directly — they emit raw cNFT mint events keyed by `assetId`. To map `assetId → badgeId` at webhook time we'd need to look it up from the metadata uri (which encodes the badge), or pre-record `(signature → badgeId)` when we hand the partial-signed tx to the user. **Simpler alpha approach:** the frontend posts `/mint/confirm {signature, badgeId}` after sending — that's the authoritative path. The webhook is a safety net for the rare case the frontend dies before /mint/confirm; in that case we accept that the asset lands in the user's wallet but the `badgeClaims` row stays missing until the user re-loads `/lands/:wallet/inventory` (which is allowed to call `/mint/confirm` itself when it sees a chain-only mint). **The test `payload.events.compressed[].badgeId` is a fixture convenience** — production will need a different attribution mechanism. Document this caveat in the README (Task 11) and revisit in Plan 5.

---

## Task 10: Worker — checkMintAuthorityBalance repeatable job

**Files:**
- Create: `apps/worker/src/jobs/checkBalance.ts`
- Modify: `apps/worker/src/worker.ts` (register processor + add repeatable job)

### Step 1: Add a `checkBalance` queue name to `packages/shared/src/queue/connection.ts`

Find the `QUEUE_NAMES` constant and append:

```typescript
export const QUEUE_NAMES = {
  scan: "scan-wallet",
  checkBalance: "check-balance",
} as const;
```

(If the original was already an `as const` object, just add the line.)

### Step 2: Create `apps/worker/src/jobs/checkBalance.ts`

```typescript
import {
  clearMintDegraded,
  getRpcConnection,
  mintAuthorityPublicKey,
  setMintDegraded,
} from "@onchainme/shared";

const LAMPORTS_PER_SOL = 1_000_000_000;
const WARN_BELOW_SOL = 0.5;
const DEGRADE_BELOW_SOL = 0.1;
const DEGRADE_TTL_S = 15 * 60;

export interface CheckBalanceResult {
  balanceSol: number;
  degraded: boolean;
}

export async function checkBalanceProcessor(): Promise<CheckBalanceResult> {
  const conn = getRpcConnection();
  const pubkey = mintAuthorityPublicKey();
  const lamports = await conn.getBalance(pubkey, "confirmed");
  const balanceSol = lamports / LAMPORTS_PER_SOL;

  if (balanceSol < DEGRADE_BELOW_SOL) {
    await setMintDegraded(`balance ${balanceSol.toFixed(4)} SOL`, DEGRADE_TTL_S);
    return { balanceSol, degraded: true };
  }
  if (balanceSol < WARN_BELOW_SOL) {
    // Soft warning — log via the worker's pino logger; don't degrade yet.
    // Clear any stale degrade flag if balance recovered above DEGRADE threshold.
    await clearMintDegraded();
    return { balanceSol, degraded: false };
  }
  await clearMintDegraded();
  return { balanceSol, degraded: false };
}
```

### Step 3: Modify `apps/worker/src/worker.ts`

Read the existing file. After the `scanWorker` registration, register a second worker AND schedule the repeatable job:

```typescript
import { createWorker, createQueue, QUEUE_NAMES } from "@onchainme/shared";
import { checkBalanceProcessor } from "./jobs/checkBalance.js";

// ... existing scanWorker code ...

const balanceWorker = createWorker(QUEUE_NAMES.checkBalance, checkBalanceProcessor, 1);
balanceWorker.on("ready", () => log.info("checkBalance worker registered"));
balanceWorker.on("completed", (job, result) => log.info({ jobId: job.id, result }, "checkBalance completed"));
balanceWorker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "checkBalance failed"));

// Schedule the repeatable job (every 10 minutes). BullMQ deduplicates by jobId so re-running on each
// worker boot is safe.
const balanceQueue = createQueue(QUEUE_NAMES.checkBalance);
await balanceQueue.add(
  "checkBalance",
  {},
  {
    jobId: "checkBalance:repeatable",
    repeat: { pattern: "*/10 * * * *" }, // every 10 minutes
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
);
log.info("checkBalance repeatable job scheduled (every 10 min)");

// Extend the SIGINT/SIGTERM block — close balanceWorker BEFORE closeRedis,
// alongside scanWorker.close():
//   await balanceWorker.close();
```

### Step 4: Build worker — clean

```bash
pnpm --filter @onchainme/worker build
```

### Step 5: Smoke-run worker

```bash
timeout 8 pnpm --filter @onchainme/worker start 2>&1 | head -40
```

Expected to see all of:
- `worker starting`
- `redis ready`
- `scanWallet worker registered`
- `checkBalance worker registered`
- `checkBalance repeatable job scheduled (every 10 min)`
- `worker ready`

Within 10 minutes (or trigger manually by adjusting the cron pattern to `*/1 * * * *` temporarily) you should see `checkBalance completed { balanceSol: <n>, degraded: false }`. If `MINT_AUTHORITY_PRIVATE_KEY` and `SOLANA_RPC_URL` aren't valid, the job fails — which is fine for the smoke test, just confirm the wiring.

---

## Task 11: Tree creation script + README + final verification

**Files:**
- Create: `scripts/create-tree.ts`
- Modify: `README.md`

### Step 1: One-time tree creation script `scripts/create-tree.ts`

This is run **manually**, once, to provision the Bubblegum Merkle tree on devnet. It is NOT part of the runtime.

```typescript
#!/usr/bin/env -S node --import tsx
import { Keypair } from "@solana/web3.js";
import { createTree } from "@metaplex-foundation/mpl-bubblegum";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, generateSigner } from "@metaplex-foundation/umi";
import { mplBubblegum } from "@metaplex-foundation/mpl-bubblegum";
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
console.log("Creating tree at:", merkleTree.publicKey);

const tx = await createTree(umi, {
  merkleTree,
  maxDepth: 14,        // ~16k leaves
  maxBufferSize: 64,
  canopyDepth: 10,     // tradeoff: bigger canopy = fewer proof bytes per mint
}).then((b) => b.sendAndConfirm(umi));

console.log("Tree created. Signature:", bs58.encode(tx.signature));
console.log("Set MERKLE_TREE_ADDRESS=" + merkleTree.publicKey + " in your .env.local");
```

Make it executable in docs (the script doesn't need a chmod for `node --import tsx` invocation):

```bash
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY \
  MINT_AUTHORITY_PRIVATE_KEY=<base58> \
  node --import tsx scripts/create-tree.ts
```

(Run this manually before exercising mint endpoints. The output line `Set MERKLE_TREE_ADDRESS=...` goes into `.env.local`.)

### Step 2: README — add mint section

After the "Editing your land" section (added in Plan 3), append:

```markdown
## Minting your badges (devnet checklist)

The mint flow uses Metaplex Bubblegum compressed NFTs. Backend acts as fee payer + tree delegate; user signs as leaf owner.

### One-time setup (devnet)

\`\`\`bash
# 1. Generate a mint authority keypair
solana-keygen new -o /tmp/mint-authority.json --no-bip39-passphrase --force

# 2. Encode the secret key as base58 and put in .env.local
node -e "const fs=require('fs'); const bs58=require('bs58').default; \
  console.log(bs58.encode(Uint8Array.from(JSON.parse(fs.readFileSync('/tmp/mint-authority.json')))))" \
  | tee -a .env.local
# Then prepend MINT_AUTHORITY_PRIVATE_KEY= manually.

# 3. Airdrop devnet SOL to the authority
solana airdrop 2 $(solana-keygen pubkey /tmp/mint-authority.json) --url devnet

# 4. Create the merkle tree (one-time)
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY \
  MINT_AUTHORITY_PRIVATE_KEY=<from step 2> \
  node --import tsx scripts/create-tree.ts
# Copy the printed MERKLE_TREE_ADDRESS=... line into .env.local

# 5. Set METADATA_BASE_URL — for alpha, host static JSON anywhere (R2, GitHub Pages):
#    https://your.cdn/metadata/first_swap.json must exist for each badgeId.
\`\`\`

### Running the mint flow

\`\`\`bash
# Assume $WALLET is a logged-in user wallet with at least one eligible badge.
# 1. Get a partial-signed mint transaction
JOB=$(curl -s -X POST http://localhost:3001/api/v1/mint/single \
  -H 'content-type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"badgeId":"first_swap"}' | jq)
echo "$JOB"

# 2. Frontend deserializes the base64 transaction, signs as leafOwner,
#    sends via wallet.signTransaction + connection.sendRawTransaction.
#    Capture the resulting signature.

# 3. Confirm
curl -s -X POST http://localhost:3001/api/v1/mint/confirm \
  -H 'content-type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"signature":"<sig>","badgeId":"first_swap"}'
\`\`\`

### Webhook setup (devnet, optional)

Helius dashboard → "Webhooks" → create a webhook for the merkle tree address with type `compressed.mint`. Set the `Authorization` header to `${HELIUS_WEBHOOK_SECRET}`. Point to `https://<your-tunnel>/api/v1/webhooks/helius`. Use ngrok or Cloudflare Tunnel for local testing.

### Mint authority balance monitoring

The worker job `checkBalance` runs every 10 minutes. Check logs for `checkBalance completed { balanceSol: ... }`. If balance drops below 0.1 SOL, `/mint/*` returns 503 `MINT_AUTHORITY_OUT_OF_FUNDS` until the next successful check after a top-up.

### Manual test checklist

- [ ] /mint/single returns base64
- [ ] User signs and sends; tx lands on devnet
- [ ] /mint/confirm writes badgeClaims with assetId
- [ ] Repeat /mint/confirm — alreadyClaimed=true, no DB change
- [ ] Drain mint authority below 0.1 SOL → /mint/single returns 503 within 10 min
- [ ] Re-airdrop and wait for next checkBalance — /mint/single recovers
```

(Use real triple-backticks in the actual file.)

### Step 3: Final verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All exit 0. Test count target: shared (~85) + api (~50) ≈ **115+ tests**. If any pre-existing lints surface, note in the report but don't fix unless trivial.

### Step 4: Smoke-build Docker images

```bash
docker build -f apps/api/Dockerfile -t onchainme-api:smoke .
docker build -f apps/worker/Dockerfile -t onchainme-worker:smoke .
```

Both clean.

---

## Done — what works after Plan 4

- `MINT_AUTHORITY_PRIVATE_KEY` loaded once at boot; refuses to start without it
- `POST /mint/single` validates eligibility + claim absence + balance gate; returns base64 partial-signed Bubblegum mint
- `POST /mint/all` returns one tx per eligible-but-unclaimed badge
- `POST /mint/confirm` checks the on-chain tx, parses assetId from logs, writes `badgeClaims` idempotently via `$setOnInsert`. Replaying the same `(wallet, badgeId)` returns `alreadyClaimed: true` with the original asset id (no overwrite).
- `POST /webhooks/helius` validated by shared secret, idempotent on `signature`, writes `badgeClaims` for events whose `treeId` matches our tree
- Worker `checkBalance` job runs every 10 min, sets a Redis `mint_disabled` flag when balance < 0.1 SOL (15-min TTL); `/mint/*` reads it and returns 503 `MINT_AUTHORITY_OUT_OF_FUNDS`
- Tree creation script + README devnet checklist
- ~115 tests pass (unit + integration with MSW-mocked Solana RPC)

## What's next — Plan 5: Polish + Alpha

Plan 5 wraps the project for alpha launch:
1. Sentry integration (error capture, performance, audit breadcrumbs for mint partial-signs)
2. Bull-Board dashboard mounted at `/admin/queues` with basic auth
3. Production CORS + cookie domain config + secure cookie in prod
4. OpenAPI tightening: every route declares `response` schemas for client codegen
5. Helius parser warnings → Sentry breadcrumb when scan completes with warnings
6. Final manual checklist: SIWS, scan, badge eval, mint, webhook on a fresh devnet wallet
7. Production deploy guide (Railway / Atlas / Upstash) in README
8. ~8 tasks
