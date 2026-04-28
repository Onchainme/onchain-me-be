# Plan 1 — Setup Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable backend skeleton — pnpm monorepo with `apps/api` (Fastify), `apps/worker` (BullMQ), and `packages/shared` (Mongoose models + Zod env + errors), wired to local MongoDB (single-node replica set) + Redis via docker-compose, with CI green and a passing health-check.

**Architecture:** TypeScript-strict pnpm workspace. `packages/shared` exports Mongoose models, Zod env validation, and error types consumed by both apps. `apps/api` is a Fastify HTTP service. `apps/worker` is a long-running BullMQ process. MongoDB (configured as single-node replica set to enable transactions) and Redis run in docker-compose locally; CI uses GitHub Actions service containers.

**Tech Stack:** Node 20 / TypeScript 5.5 / pnpm 9 / Fastify 5 / Mongoose 8 / MongoDB 7 / BullMQ 5 / ioredis / Vitest 2 / Pino 9 / Zod 3.

**Spec reference:** [`docs/superpowers/specs/2026-04-27-onchainme-backend-design.md`](../specs/2026-04-27-onchainme-backend-design.md) — sections §3 (project structure), §4 (DB schema), §11 (Docker), §8 (testing).

**Exit criterion:** From a clean checkout, `docker-compose up -d && pnpm install && pnpm db:sync-indexes && pnpm dev:api` followed by `curl http://localhost:3001/api/v1/health` returns `{"ok":true,"db":"ok","redis":"ok"}`. CI is green on a fresh PR.

---

## File Structure (created in this plan)

```
onchainme-backend/
├── .editorconfig
├── .env.example
├── .eslintrc.cjs
├── .gitignore
├── .prettierrc.json
├── docker-compose.yml
├── package.json                       # root, pnpm workspaces
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── vitest.config.ts                   # root vitest config (workspace-aware)
├── .github/
│   └── workflows/
│       └── ci.yml
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── server.ts              # bootstrap
│   │   │   ├── plugins/
│   │   │   │   ├── logger.ts          # pino setup
│   │   │   │   ├── swagger.ts         # OpenAPI generation
│   │   │   │   ├── cors.ts
│   │   │   │   ├── request-id.ts
│   │   │   │   └── error-envelope.ts  # uniform error response
│   │   │   └── routes/
│   │   │       ├── index.ts           # registers all routes
│   │   │       └── health.ts          # GET /api/v1/health
│   │   └── tests/
│   │       └── health.spec.ts
│   └── worker/
│       ├── Dockerfile
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── worker.ts              # BullMQ entry, no jobs registered yet
└── packages/
    └── shared/
        ├── package.json
        ├── tsconfig.json
        ├── src/
        │   ├── index.ts               # re-exports
        │   ├── env.ts                 # Zod-validated env loader
        │   ├── errors.ts              # ErrorCode enum + AppError
        │   ├── db/
        │   │   ├── models.ts          # Mongoose models — all 8 collections
        │   │   ├── connect.ts         # mongoose.connect + close helpers
        │   │   └── ensure-indexes.ts  # syncIndexes() runner (replaces "migrations")
        │   └── queue/
        │       └── connection.ts      # ioredis + BullMQ helpers
        └── tests/
            ├── env.test.ts
            └── errors.test.ts
```

---

## Task 1: Initialize pnpm workspace

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.editorconfig`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "onchainme-backend",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20.10.0" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev:api": "pnpm --filter @onchainme/api dev",
    "dev:worker": "pnpm --filter @onchainme/worker dev",
    "db:sync-indexes": "pnpm --filter @onchainme/shared db:sync-indexes"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^8.8.0",
    "@typescript-eslint/parser": "^8.8.0",
    "eslint": "^9.12.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.3.3",
    "typescript": "^5.5.4",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create `.gitignore`**

```
# deps
node_modules/
.pnpm-store/

# build
dist/
*.tsbuildinfo

# env
.env
.env.local
.env.*.local
!.env.example

# logs
*.log
logs/

# IDE
.idea/
.vscode/
.DS_Store

# tests
coverage/
.vitest-cache/

# docker
mongo_data/
redis_data/

# secrets / keys
*.pem
*.key
mint-authority.json
```

- [ ] **Step 4: Create `.editorconfig`**

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 5: Smoke test pnpm install**

Run: `pnpm install`
Expected: pnpm resolves dependencies without errors; creates `node_modules/` and `pnpm-lock.yaml`.

- [ ] **Step 6: Commit**

```bash
git init
git add .gitignore .editorconfig package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore: initialize pnpm workspace"
```

---

## Task 2: TypeScript base config

**Files:**
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true,
    "incremental": true
  },
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/tests/**"]
}
```

- [ ] **Step 2: Commit**

```bash
git add tsconfig.base.json
git commit -m "chore: add TypeScript base config"
```

---

## Task 3: ESLint + Prettier

**Files:**
- Create: `.eslintrc.cjs`
- Create: `.prettierrc.json`

- [ ] **Step 1: Create `.eslintrc.cjs`**

```javascript
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/consistent-type-imports": "error",
    "no-console": ["warn", { allow: ["warn", "error"] }],
  },
  ignorePatterns: ["dist/", "node_modules/", "*.config.js", "*.config.cjs"],
};
```

- [ ] **Step 2: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- [ ] **Step 3: Run lint to verify config loads**

Run: `pnpm lint`
Expected: passes (no source files yet → no errors).

- [ ] **Step 4: Commit**

```bash
git add .eslintrc.cjs .prettierrc.json
git commit -m "chore: add eslint + prettier config"
```

---

## Task 4: Root Vitest config

**Files:**
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "apps/*/src/**/*.{test,spec}.ts",
      "apps/*/tests/**/*.{test,spec}.ts",
      "packages/*/src/**/*.{test,spec}.ts",
      "packages/*/tests/**/*.{test,spec}.ts",
    ],
    coverage: {
      reporter: ["text", "html"],
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["**/*.{test,spec}.ts", "**/dist/**"],
    },
    testTimeout: 10_000,
    passWithNoTests: true,    // Vitest 2 exits with code 1 by default when no tests
                              // are found; this lets `pnpm test` succeed before any
                              // test files exist (Tasks 7+ add real ones).
  },
});
```

- [ ] **Step 2: Verify Vitest runs (no tests yet)**

Run: `pnpm test`
Expected: `No test files found, exiting with code 0`.

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "chore: configure vitest for monorepo"
```

---

## Task 5: docker-compose + .env.example

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
version: "3.9"

services:
  mongo:
    image: mongo:7
    container_name: onchainme-mongo
    command: ["--replSet", "rs0", "--bind_ip_all", "--port", "27018"]
    ports:
      - "27018:27018"   # host:container — port 27018 chosen to avoid conflict
                         # with other local mongo instances on default 27017.
                         # internal port matches external so the replica set
                         # member announces itself at localhost:27018, which
                         # clients on the host can reach directly.
    volumes:
      - mongo_data:/data/db
    healthcheck:
      # First run: rs.status() throws → catch initiates a single-node replica set.
      # Subsequent runs: rs.status() succeeds → no-op.
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
      - "6380:6379"   # host:container — host port shifted from 6379 to avoid
                       # conflict with other local Redis instances.
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  mongo_data:
  redis_data:
```

- [ ] **Step 2: Create `.env.example`**

```env
# --- Application ---
NODE_ENV=development
LOG_LEVEL=debug
PORT=3001

# --- Database (MongoDB single-node replica set) ---
# Local: matches docker-compose `mongo` service on host port 27018
# Production: MongoDB Atlas SRV string (e.g., mongodb+srv://user:pass@cluster.xxx.mongodb.net/onchainme)
# Note: ?replicaSet=rs0 is REQUIRED locally for multi-doc transactions
MONGODB_URI=mongodb://localhost:27018/onchainme?replicaSet=rs0

# --- Redis (BullMQ) ---
REDIS_URL=redis://localhost:6380

# --- Auth ---
JWT_SECRET=change_me_in_prod_min_32_chars_long_random_string_xx
COOKIE_DOMAIN=localhost

# --- Solana / Helius (not used in Plan 1; required by env validator) ---
HELIUS_API_KEY=placeholder_helius_key_for_dev
HELIUS_WEBHOOK_SECRET=placeholder_webhook_secret
SOLANA_CLUSTER=devnet

# --- Mint authority (not used in Plan 1) ---
MINT_AUTHORITY_PRIVATE_KEY=
MINT_AUTHORITY_TREE=

# --- Sentry ---
SENTRY_DSN=
```

- [ ] **Step 3: Bring up services and verify health**

Run: `docker-compose up -d`
Expected: both containers start.

Wait ~30 seconds for the replica set to initialize, then:

Run: `docker-compose ps`
Expected: `onchainme-mongo` and `onchainme-redis` rows show `STATUS = Up (healthy)`.

Run: `mongosh "mongodb://localhost:27018/onchainme?replicaSet=rs0" --quiet --eval "rs.status().myState"`
Expected: `1` (the single node is PRIMARY of the replica set).

Run: `redis-cli -h localhost -p 6380 ping`
Expected: `PONG`.

- [ ] **Step 4: Copy env template**

Run: `cp .env.example .env.local`

(`.env.local` is gitignored. The app will load it; `.env.example` is the committed template.)

- [ ] **Step 5: Verify multi-doc transactions work**

Run:

```bash
mongosh "mongodb://localhost:27018/onchainme?replicaSet=rs0" --quiet --eval '
  const session = db.getMongo().startSession();
  session.startTransaction();
  session.getDatabase("onchainme").testTx.insertOne({_id: 1, hello: "world"});
  session.commitTransaction();
  print("transactions OK:", session.getDatabase("onchainme").testTx.findOne({_id: 1}).hello);
  session.getDatabase("onchainme").testTx.drop();
'
```

Expected: prints `transactions OK: world`. If this fails, the replica set is not properly initialized — re-check `docker-compose ps`.

---

## Task 6: packages/shared skeleton

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@onchainme/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./db": "./dist/db/connect.js",
    "./db/models": "./dist/db/models.js",
    "./queue": "./dist/queue/connection.js",
    "./env": "./dist/env.js",
    "./errors": "./dist/errors.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "db:sync-indexes": "tsx src/db/ensure-indexes.ts"
  },
  "dependencies": {
    "bullmq": "^5.21.0",
    "dotenv": "^16.4.5",
    "ioredis": "^5.4.1",
    "mongoose": "^8.7.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.10",
    "tsx": "^4.19.1",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "tests/**"]
}
```

- [ ] **Step 3: Create `packages/shared/src/index.ts`**

```typescript
export * from "./env.js";
export * from "./errors.js";
```

(Files referenced in this re-export do not exist yet — they're created in Tasks 7 and 8. This task creates the skeleton; subsequent tasks fill in the modules. The package will not build cleanly until Task 8. That's OK — we don't run `pnpm build` until Task 9.)

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`
Expected: pnpm resolves and installs `@onchainme/shared` deps.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/package.json packages/shared/tsconfig.json packages/shared/src/index.ts pnpm-lock.yaml
git commit -m "feat(shared): scaffold shared package"
```

---

## Task 7: shared/env.ts (TDD)

**Files:**
- Create: `packages/shared/tests/env.test.ts`
- Create: `packages/shared/src/env.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/tests/env.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv } from "../src/env.js";

const ORIGINAL_ENV = process.env;

describe("loadEnv", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("parses a complete valid env", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "3001";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "helius_key";
    process.env.HELIUS_WEBHOOK_SECRET = "secret";
    process.env.SOLANA_CLUSTER = "devnet";

    const env = loadEnv();

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3001);
    expect(env.MONGODB_URI).toBe("mongodb://localhost:27018/onchainme?replicaSet=rs0");
  });

  it("coerces PORT from string to number", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "4000";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "k";
    process.env.HELIUS_WEBHOOK_SECRET = "s";
    process.env.SOLANA_CLUSTER = "devnet";

    const env = loadEnv();

    expect(env.PORT).toBe(4000);
    expect(typeof env.PORT).toBe("number");
  });

  it("rejects when JWT_SECRET is too short", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "3001";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "tooshort";
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "k";
    process.env.HELIUS_WEBHOOK_SECRET = "s";
    process.env.SOLANA_CLUSTER = "devnet";

    expect(() => loadEnv()).toThrow(/JWT_SECRET/);
  });

  it("rejects invalid SOLANA_CLUSTER", () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "info";
    process.env.PORT = "3001";
    process.env.MONGODB_URI = "mongodb://localhost:27018/onchainme?replicaSet=rs0";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.HELIUS_API_KEY = "k";
    process.env.HELIUS_WEBHOOK_SECRET = "s";
    process.env.SOLANA_CLUSTER = "wrong-cluster";

    expect(() => loadEnv()).toThrow(/SOLANA_CLUSTER/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onchainme/shared test`

(The root `pnpm test` works too; filtering is faster.)

Expected: FAIL with module-not-found or similar — `../src/env.js` does not exist.

- [ ] **Step 3: Implement `packages/shared/src/env.ts`**

```typescript
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  PORT: z.coerce.number().int().positive(),

  MONGODB_URI: z.string().refine(
    (v) => v.startsWith("mongodb://") || v.startsWith("mongodb+srv://"),
    { message: "MONGODB_URI must start with mongodb:// or mongodb+srv://" },
  ),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  COOKIE_DOMAIN: z.string().min(1),

  HELIUS_API_KEY: z.string().min(1),
  HELIUS_WEBHOOK_SECRET: z.string().min(1),
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]),

  MINT_AUTHORITY_PRIVATE_KEY: z.string().optional().default(""),
  MINT_AUTHORITY_TREE: z.string().optional().default(""),

  SENTRY_DSN: z.string().optional().default(""),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(opts: { reload?: boolean } = {}): Env {
  if (cached && !opts.reload) return cached;

  loadDotenv({ path: ".env.local", override: false });
  loadDotenv({ path: ".env", override: false });

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onchainme/shared test`
Expected: 4 tests pass (the 4 cases in `env.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/env.ts packages/shared/tests/env.test.ts
git commit -m "feat(shared): add Zod-validated env loader"
```

---

## Task 8: shared/errors.ts (TDD)

**Files:**
- Create: `packages/shared/tests/errors.test.ts`
- Create: `packages/shared/src/errors.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/tests/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { AppError, ErrorCode } from "../src/errors.js";

describe("AppError", () => {
  it("stores code, message, statusCode, and details", () => {
    const err = new AppError({
      code: ErrorCode.BADGE_NOT_ELIGIBLE,
      message: "Not eligible",
      statusCode: 422,
      details: { current: 12, required: 50 },
    });

    expect(err.code).toBe(ErrorCode.BADGE_NOT_ELIGIBLE);
    expect(err.message).toBe("Not eligible");
    expect(err.statusCode).toBe(422);
    expect(err.details).toEqual({ current: 12, required: 50 });
    expect(err).toBeInstanceOf(Error);
  });

  it("serializes to the wire envelope shape", () => {
    const err = new AppError({
      code: ErrorCode.TILE_OCCUPIED,
      message: "Tile already occupied",
      statusCode: 409,
      details: { x: 4, y: 7 },
    });

    expect(err.toJSON()).toEqual({
      error: {
        code: "TILE_OCCUPIED",
        message: "Tile already occupied",
        details: { x: 4, y: 7 },
      },
    });
  });

  it("omits details from JSON when not provided", () => {
    const err = new AppError({
      code: ErrorCode.AUTH_TOKEN_MISSING,
      message: "No token",
      statusCode: 401,
    });

    expect(err.toJSON()).toEqual({
      error: {
        code: "AUTH_TOKEN_MISSING",
        message: "No token",
      },
    });
  });
});

describe("ErrorCode", () => {
  it("contains all spec-defined codes", () => {
    const expected = [
      "VALIDATION_ERROR",
      "INVALID_WALLET_FORMAT",
      "INVALID_BADGE_ID",
      "INVALID_TILE_COORDINATE",
      "AUTH_NONCE_EXPIRED",
      "AUTH_NONCE_CONSUMED",
      "AUTH_SIGNATURE_INVALID",
      "AUTH_TOKEN_MISSING",
      "AUTH_TOKEN_INVALID",
      "FORBIDDEN_RESOURCE_OWNER",
      "LAND_NOT_FOUND",
      "JOB_NOT_FOUND",
      "TILE_OCCUPIED",
      "BADGE_ALREADY_CLAIMED",
      "SCAN_ALREADY_RUNNING",
      "BADGE_NOT_ELIGIBLE",
      "TX_BLOCKHASH_EXPIRED",
      "PLACEMENT_FOR_UNCLAIMED",
      "RATE_LIMIT_EXCEEDED",
      "INTERNAL_ERROR",
      "HELIUS_UNAVAILABLE",
      "SOLANA_RPC_UNAVAILABLE",
      "DATABASE_UNAVAILABLE",
      "REDIS_UNAVAILABLE",
      "MINT_AUTHORITY_OUT_OF_FUNDS",
    ];

    for (const code of expected) {
      expect(ErrorCode[code as keyof typeof ErrorCode]).toBe(code);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @onchainme/shared test`
Expected: FAIL — `../src/errors.js` does not exist.

- [ ] **Step 3: Implement `packages/shared/src/errors.ts`**

```typescript
export const ErrorCode = {
  // 400 validation
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_WALLET_FORMAT: "INVALID_WALLET_FORMAT",
  INVALID_BADGE_ID: "INVALID_BADGE_ID",
  INVALID_TILE_COORDINATE: "INVALID_TILE_COORDINATE",

  // 401 auth
  AUTH_NONCE_EXPIRED: "AUTH_NONCE_EXPIRED",
  AUTH_NONCE_CONSUMED: "AUTH_NONCE_CONSUMED",
  AUTH_SIGNATURE_INVALID: "AUTH_SIGNATURE_INVALID",
  AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",

  // 403 authorization
  FORBIDDEN_RESOURCE_OWNER: "FORBIDDEN_RESOURCE_OWNER",

  // 404 not found
  LAND_NOT_FOUND: "LAND_NOT_FOUND",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",

  // 409 conflict
  TILE_OCCUPIED: "TILE_OCCUPIED",
  BADGE_ALREADY_CLAIMED: "BADGE_ALREADY_CLAIMED",
  SCAN_ALREADY_RUNNING: "SCAN_ALREADY_RUNNING",

  // 422 business logic
  BADGE_NOT_ELIGIBLE: "BADGE_NOT_ELIGIBLE",
  TX_BLOCKHASH_EXPIRED: "TX_BLOCKHASH_EXPIRED",
  PLACEMENT_FOR_UNCLAIMED: "PLACEMENT_FOR_UNCLAIMED",

  // 429 rate limit
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // 5xx infra
  INTERNAL_ERROR: "INTERNAL_ERROR",
  HELIUS_UNAVAILABLE: "HELIUS_UNAVAILABLE",
  SOLANA_RPC_UNAVAILABLE: "SOLANA_RPC_UNAVAILABLE",
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  REDIS_UNAVAILABLE: "REDIS_UNAVAILABLE",
  MINT_AUTHORITY_OUT_OF_FUNDS: "MINT_AUTHORITY_OUT_OF_FUNDS",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  code: ErrorCodeValue;
  message: string;
  statusCode: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: ErrorCodeValue;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(opts: AppErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
  }

  toJSON(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    const payload: { code: string; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) payload.details = this.details;
    return { error: payload };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @onchainme/shared test`
Expected: 8 tests pass total (4 in `env.test.ts` + 3 in `AppError` block + 1 in `ErrorCode` block).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/errors.ts packages/shared/tests/errors.test.ts
git commit -m "feat(shared): add AppError class and ErrorCode enum"
```

---

## Task 9: Mongoose models (all 8 collections)

**Files:**
- Create: `packages/shared/src/db/models.ts`

- [ ] **Step 1: Create `packages/shared/src/db/models.ts`**

```typescript
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

// ---------- shared types ----------

export type Protocol = "jupiter" | "magic_eden" | "meteora" | "other";
export type TxAction =
  | "swap"
  | "nft_buy"
  | "nft_sell"
  | "nft_list"
  | "lp_deposit"
  | "lp_withdraw";
export type ScanMode = "full" | "incremental";
export type ScanStatus = "queued" | "running" | "done" | "failed";

// ---------- users ----------

const userSchema = new Schema(
  {
    _id: { type: String, required: true }, // walletAddress, base58
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: Date,
    lastScanAt: Date,
    lastScanCursor: String,
    refInviter: String,
    ogImageUrl: String,
  },
  { _id: false, collection: "users" },
);
export type User = InferSchemaType<typeof userSchema> & { _id: string };
export const User: Model<User> = mongoose.models.User ?? mongoose.model<User>("User", userSchema);

// ---------- scanJobs ----------

const scanJobSchema = new Schema(
  {
    walletAddress: { type: String, required: true },
    mode: { type: String, enum: ["full", "incremental"], required: true },
    status: {
      type: String,
      enum: ["queued", "running", "done", "failed"],
      required: true,
    },
    progress: {
      phase: String,
      processed: Number,
      total: Number,
    },
    result: {
      newBadges: [String],
      totalBadges: Number,
      warnings: [
        {
          signature: String,
          parser: String,
          error: String,
          _id: false,
        },
      ],
    },
    error: String,
    startedAt: { type: Date, default: Date.now },
    finishedAt: Date,
  },
  { collection: "scanJobs" },
);
scanJobSchema.index({ walletAddress: 1, startedAt: -1 });
export type ScanJob = InferSchemaType<typeof scanJobSchema>;
export const ScanJob: Model<ScanJob> =
  mongoose.models.ScanJob ?? mongoose.model<ScanJob>("ScanJob", scanJobSchema);

// ---------- txs ----------

const txSchema = new Schema(
  {
    _id: String, // signature
    walletAddress: { type: String, required: true },
    blockTime: { type: Date, required: true },
    protocol: {
      type: String,
      enum: ["jupiter", "magic_eden", "meteora", "other"],
      required: true,
    },
    action: {
      type: String,
      enum: ["swap", "nft_buy", "nft_sell", "nft_list", "lp_deposit", "lp_withdraw"],
      required: true,
    },
    amountUsd: Number,
    meta: Schema.Types.Mixed,
  },
  { _id: false, collection: "txs" },
);
txSchema.index({ walletAddress: 1, blockTime: -1 });
txSchema.index({ walletAddress: 1, protocol: 1 });
export type Tx = InferSchemaType<typeof txSchema> & { _id: string };
export const Tx: Model<Tx> = mongoose.models.Tx ?? mongoose.model<Tx>("Tx", txSchema);

// ---------- txRawCache ----------

const txRawCacheSchema = new Schema(
  {
    _id: String, // signature
    walletAddress: { type: String, required: true },
    raw: { type: Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, default: Date.now },
  },
  { _id: false, collection: "txRawCache" },
);
txRawCacheSchema.index({ walletAddress: 1 });
export type TxRawCache = InferSchemaType<typeof txRawCacheSchema> & { _id: string };
export const TxRawCache: Model<TxRawCache> =
  mongoose.models.TxRawCache ?? mongoose.model<TxRawCache>("TxRawCache", txRawCacheSchema);

// ---------- badgeEligibilities ----------

const badgeEligibilitySchema = new Schema(
  {
    _id: {
      walletAddress: { type: String, required: true },
      badgeId: { type: String, required: true },
    },
    evaluatedAt: { type: Date, default: Date.now },
    eligibleSince: { type: Date, required: true },
    meta: Schema.Types.Mixed,
  },
  { _id: false, collection: "badgeEligibilities" },
);
badgeEligibilitySchema.index({ "_id.walletAddress": 1 });
export type BadgeEligibility = InferSchemaType<typeof badgeEligibilitySchema>;
export const BadgeEligibility: Model<BadgeEligibility> =
  mongoose.models.BadgeEligibility ??
  mongoose.model<BadgeEligibility>("BadgeEligibility", badgeEligibilitySchema);

// ---------- badgeClaims ----------

const badgeClaimSchema = new Schema(
  {
    _id: {
      walletAddress: { type: String, required: true },
      badgeId: { type: String, required: true },
    },
    mintedAt: { type: Date, default: Date.now },
    mintSignature: { type: String, required: true },
    assetId: { type: String, required: true },
    merkleTree: { type: String, required: true },
  },
  { _id: false, collection: "badgeClaims" },
);
badgeClaimSchema.index({ "_id.walletAddress": 1 });
export type BadgeClaim = InferSchemaType<typeof badgeClaimSchema>;
export const BadgeClaim: Model<BadgeClaim> =
  mongoose.models.BadgeClaim ?? mongoose.model<BadgeClaim>("BadgeClaim", badgeClaimSchema);

// ---------- placements ----------

const placementSchema = new Schema(
  {
    _id: {
      walletAddress: { type: String, required: true },
      badgeId: { type: String, required: true },
    },
    tileX: { type: Number, required: true },
    tileY: { type: Number, required: true },
    placedAt: { type: Date, default: Date.now },
  },
  { _id: false, collection: "placements" },
);
placementSchema.index({ "_id.walletAddress": 1 });
// "one object per tile" — DB-enforced uniqueness on (wallet, tileX, tileY)
placementSchema.index(
  { "_id.walletAddress": 1, tileX: 1, tileY: 1 },
  { unique: true, name: "wallet_tile_uq" },
);
export type Placement = InferSchemaType<typeof placementSchema>;
export const Placement: Model<Placement> =
  mongoose.models.Placement ?? mongoose.model<Placement>("Placement", placementSchema);

// ---------- authNonces ----------

const authNonceSchema = new Schema(
  {
    _id: String, // nonce
    walletAddress: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: Date,
  },
  { _id: false, collection: "authNonces" },
);
// TTL: Mongo deletes documents 86400 seconds AFTER `expiresAt`
authNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });
export type AuthNonce = InferSchemaType<typeof authNonceSchema> & { _id: string };
export const AuthNonce: Model<AuthNonce> =
  mongoose.models.AuthNonce ?? mongoose.model<AuthNonce>("AuthNonce", authNonceSchema);

// ---------- heliusWebhookEvents ----------

const heliusWebhookEventSchema = new Schema(
  {
    _id: String, // eventId
    receivedAt: { type: Date, default: Date.now },
    processedAt: Date,
    payload: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false, collection: "heliusWebhookEvents" },
);
export type HeliusWebhookEvent = InferSchemaType<typeof heliusWebhookEventSchema> & {
  _id: string;
};
export const HeliusWebhookEvent: Model<HeliusWebhookEvent> =
  mongoose.models.HeliusWebhookEvent ??
  mongoose.model<HeliusWebhookEvent>("HeliusWebhookEvent", heliusWebhookEventSchema);

// ---------- registry — used by ensureIndexes script ----------

export const allModels = [
  User,
  ScanJob,
  Tx,
  TxRawCache,
  BadgeEligibility,
  BadgeClaim,
  Placement,
  AuthNonce,
  HeliusWebhookEvent,
] as const;
```

Notes:
- `mongoose.models.X ?? mongoose.model(...)` pattern prevents Mongoose's `OverwriteModelError` when the module is hot-reloaded by `tsx watch` in dev.
- Compound `_id` (object) for `placements`, `badgeClaims`, `badgeEligibilities` mimics composite primary keys — Mongo enforces `_id` uniqueness on inserts, so duplicate `(walletAddress, badgeId)` raises `DuplicateKeyError`.
- Indexes are declared in the schema; they are not created automatically — the `ensure-indexes` script in Task 10 calls `syncIndexes()` to materialize them.

---

## Task 10: shared/db connect + ensure-indexes runner

**Files:**
- Create: `packages/shared/src/db/connect.ts`
- Create: `packages/shared/src/db/ensure-indexes.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create `packages/shared/src/db/connect.ts`**

```typescript
import mongoose from "mongoose";
import { loadEnv } from "../env.js";

let _connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (_connected) return mongoose;
  const env = loadEnv();

  // Mongoose 8: bufferCommands=false fails fast if not yet connected,
  // surfacing real connection errors instead of hanging silently.
  mongoose.set("bufferCommands", false);
  mongoose.set("strictQuery", true);

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 50,
  });

  _connected = true;
  return mongoose;
}

export async function closeDb(): Promise<void> {
  if (!_connected) return;
  await mongoose.disconnect();
  _connected = false;
}

export function isDbConnected(): boolean {
  return _connected && mongoose.connection.readyState === 1; // 1 = connected
}

export { mongoose };
```

- [ ] **Step 2: Create `packages/shared/src/db/ensure-indexes.ts`**

```typescript
import { allModels } from "./models.js";
import { connectDb, closeDb } from "./connect.js";

async function main(): Promise<void> {
  console.warn("Connecting to MongoDB...");
  await connectDb();

  for (const model of allModels) {
    console.warn(`syncing indexes for ${model.modelName} ...`);
    await model.syncIndexes();
  }

  console.warn("All indexes synced.");
  await closeDb();
}

main().catch(async (err) => {
  console.error("ensure-indexes failed:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 3: Update `packages/shared/src/index.ts`**

Replace the contents of `packages/shared/src/index.ts` with:

```typescript
export * from "./env.js";
export * from "./errors.js";
export { connectDb, closeDb, isDbConnected, mongoose } from "./db/connect.js";
export * as models from "./db/models.js";
```

- [ ] **Step 4: Run index sync**

Run: `pnpm --filter @onchainme/shared db:sync-indexes`
Expected: prints `Connecting to MongoDB...`, then `syncing indexes for User`, `syncing indexes for ScanJob`, ... for all 9 models, finally `All indexes synced.`

- [ ] **Step 5: Verify collections and indexes exist**

Run:

```bash
mongosh "mongodb://localhost:27018/onchainme?replicaSet=rs0" --quiet --eval '
  print("--- collections ---");
  db.getCollectionNames().sort().forEach((n) => print("  " + n));
  print("--- placements indexes ---");
  db.placements.getIndexes().forEach((i) => print("  " + JSON.stringify({name: i.name, key: i.key, unique: i.unique})));
  print("--- authNonces indexes ---");
  db.authNonces.getIndexes().forEach((i) => print("  " + JSON.stringify({name: i.name, key: i.key, expireAfterSeconds: i.expireAfterSeconds})));
'
```

Expected:
- collections list contains `users`, `scanJobs`, `txs`, `txRawCache`, `badgeEligibilities`, `badgeClaims`, `placements`, `authNonces`, `heliusWebhookEvents`
- `placements` has `wallet_tile_uq` index with `unique: true` on `_id.walletAddress, tileX, tileY`
- `authNonces` has an index on `expiresAt` with `expireAfterSeconds: 86400`

- [ ] **Step 6: Build the shared package**

Run: `pnpm --filter @onchainme/shared build`
Expected: `dist/` directory created without errors.

---

## Task 11: shared/queue/connection.ts

**Files:**
- Create: `packages/shared/src/queue/connection.ts`

- [ ] **Step 1: Create `packages/shared/src/queue/connection.ts`**

```typescript
import { Queue, QueueEvents, Worker, type ConnectionOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { loadEnv } from "../env.js";

let _redis: Redis | undefined;

export function getRedisConnection(): Redis {
  if (_redis) return _redis;
  const env = loadEnv();
  _redis = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return _redis;
}

export function getBullConnection(): ConnectionOptions {
  return getRedisConnection();
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = undefined;
  }
}

export const QUEUE_NAMES = {
  scan: "scan-wallet",
  mintConfirm: "mint-confirm",
  webhook: "helius-webhook",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function createQueue<T = unknown>(name: QueueName): Queue<T> {
  return new Queue<T>(name, { connection: getBullConnection() });
}

export function createWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Parameters<typeof Worker<T, R>>[1],
  concurrency = 1,
): Worker<T, R> {
  return new Worker<T, R>(name, processor, {
    connection: getBullConnection(),
    concurrency,
  });
}

export function createQueueEvents(name: QueueName): QueueEvents {
  return new QueueEvents(name, { connection: getBullConnection() });
}
```

- [ ] **Step 2: Update `packages/shared/src/index.ts`**

Replace contents with:

```typescript
export * from "./env.js";
export * from "./errors.js";
export { connectDb, closeDb, isDbConnected, mongoose } from "./db/connect.js";
export * as models from "./db/models.js";
export {
  getRedisConnection,
  getBullConnection,
  closeRedis,
  createQueue,
  createWorker,
  createQueueEvents,
  QUEUE_NAMES,
} from "./queue/connection.js";
export type { QueueName } from "./queue/connection.js";
```

- [ ] **Step 3: Build to verify exports**

Run: `pnpm --filter @onchainme/shared build`
Expected: clean build, `dist/queue/connection.js` exists.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/queue/connection.ts packages/shared/src/index.ts
git commit -m "feat(shared): add Redis/BullMQ connection helpers"
```

---

## Task 12: apps/api skeleton with health endpoint (TDD)

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/routes/index.ts`
- Create: `apps/api/tests/health.spec.ts`

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@onchainme/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.1",
    "@fastify/swagger": "^9.1.0",
    "@fastify/swagger-ui": "^5.1.0",
    "@onchainme/shared": "workspace:*",
    "mongoose": "^8.7.0",
    "fastify": "^5.0.0",
    "fastify-plugin": "^5.0.1",
    "fastify-type-provider-zod": "^4.0.1",
    "ioredis": "^5.4.1",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.10",
    "tsx": "^4.19.1",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "tests/**"]
}
```

- [ ] **Step 3: Install deps**

Run: `pnpm install`
Expected: deps resolve including workspace link to `@onchainme/shared`.

- [ ] **Step 4: Write the failing test**

Create `apps/api/tests/health.spec.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";

const app = await buildServer();

afterAll(async () => {
  await app.close();
});

describe("GET /api/v1/health", () => {
  it("returns 200 with ok=true when db and redis reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(body.redis).toBe("ok");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @onchainme/api test`
Expected: FAIL — `../src/server.js` does not exist.

- [ ] **Step 6: Implement `apps/api/src/routes/health.ts`**

```typescript
import type { FastifyPluginAsync } from "fastify";
import { connectDb, mongoose, getRedisConnection } from "@onchainme/shared";

type HealthStatus = "ok" | "fail";

interface HealthResponse {
  ok: boolean;
  db: HealthStatus;
  redis: HealthStatus;
}

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_req, reply) => {
    const result: HealthResponse = { ok: true, db: "ok", redis: "ok" };

    try {
      await connectDb();
      // admin().ping() is the canonical lightweight liveness check
      const adminDb = mongoose.connection.db;
      if (!adminDb) throw new Error("mongoose connection has no db handle");
      const pingResult = await adminDb.admin().ping();
      if (pingResult.ok !== 1) {
        result.db = "fail";
        result.ok = false;
      }
    } catch (err) {
      fastify.log.error({ err }, "health: db check failed");
      result.db = "fail";
      result.ok = false;
    }

    try {
      const ping = await getRedisConnection().ping();
      if (ping !== "PONG") {
        result.redis = "fail";
        result.ok = false;
      }
    } catch (err) {
      fastify.log.error({ err }, "health: redis check failed");
      result.redis = "fail";
      result.ok = false;
    }

    return reply.code(result.ok ? 200 : 503).send(result);
  });
};
```

- [ ] **Step 7: Implement `apps/api/src/routes/index.ts`**

```typescript
import type { FastifyPluginAsync } from "fastify";
import { healthRoute } from "./health.js";

export const registerRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute, { prefix: "/api/v1" });
};
```

- [ ] **Step 8: Implement `apps/api/src/server.ts`**

```typescript
import Fastify, { type FastifyInstance } from "fastify";
import { loadEnv } from "@onchainme/shared";
import { registerRoutes } from "./routes/index.js";

export async function buildServer(): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
          : undefined,
    },
  });

  await registerRoutes(app);

  return app;
}

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildServer();
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info({ signal }, "shutting down");
      await app.close();
      process.exit(0);
    });
  }
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  void start();
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @onchainme/api test`
Expected: 1 test passes (assumes `docker-compose up -d` from Task 5 is still up and migrations ran in Task 10).

- [ ] **Step 10: Smoke test the dev server**

Run: `pnpm dev:api` in one terminal.
Expected: log line `Server listening at http://0.0.0.0:3001`.

In another terminal: `curl -s http://localhost:3001/api/v1/health | jq`
Expected:
```json
{ "ok": true, "db": "ok", "redis": "ok" }
```

Stop the dev server (Ctrl-C).

- [ ] **Step 11: Commit**

```bash
git add apps/api/
git commit -m "feat(api): scaffold Fastify server with /api/v1/health endpoint"
```

---

## Task 13: apps/api supporting plugins (request-id, error-envelope, cors, swagger)

**Files:**
- Create: `apps/api/src/plugins/request-id.ts`
- Create: `apps/api/src/plugins/error-envelope.ts`
- Create: `apps/api/src/plugins/cors.ts`
- Create: `apps/api/src/plugins/swagger.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Create `apps/api/src/plugins/request-id.ts`**

```typescript
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

export const requestIdPlugin = fp(async (fastify) => {
  fastify.addHook("onRequest", async (req, reply) => {
    const incoming = req.headers["x-request-id"];
    const id = typeof incoming === "string" && incoming.length > 0 ? incoming : `req_${randomUUID()}`;
    req.id = id;
    reply.header("x-request-id", id);
  });
});
```

(Fastify already auto-generates a request id; this hook makes it controllable via the inbound header and reflects it on the response. Fastify's logger automatically includes `req.id` in log context.)

- [ ] **Step 2: Create `apps/api/src/plugins/error-envelope.ts`**

```typescript
import fp from "fastify-plugin";
import { AppError, ErrorCode } from "@onchainme/shared";
import { ZodError } from "zod";

export const errorEnvelopePlugin = fp(async (fastify) => {
  fastify.setErrorHandler((err, req, reply) => {
    const requestId = req.id;

    if (err instanceof AppError) {
      req.log.warn({ code: err.code, requestId }, err.message);
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
      });
    }

    if (err instanceof ZodError) {
      req.log.warn({ issues: err.issues, requestId }, "validation failed");
      return reply.code(400).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: "Request validation failed",
          details: { issues: err.issues },
          requestId,
        },
      });
    }

    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: err.message,
          requestId,
        },
      });
    }

    req.log.error({ err, requestId }, "unhandled error");
    return reply.code(500).send({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: "Internal server error",
        requestId,
      },
    });
  });
});
```

- [ ] **Step 3: Create `apps/api/src/plugins/cors.ts`**

```typescript
import fp from "fastify-plugin";
import cors from "@fastify/cors";
import { loadEnv } from "@onchainme/shared";

export const corsPlugin = fp(async (fastify) => {
  const env = loadEnv();
  await fastify.register(cors, {
    origin:
      env.NODE_ENV === "production"
        ? [
            new RegExp(`^https://([a-z0-9-]+\\.)?${env.COOKIE_DOMAIN.replace(/\./g, "\\.")}$`),
          ]
        : true,
    credentials: true,
  });
});
```

- [ ] **Step 4: Create `apps/api/src/plugins/swagger.ts`**

```typescript
import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { loadEnv } from "@onchainme/shared";

export const swaggerPlugin = fp(async (fastify) => {
  const env = loadEnv();
  if (env.NODE_ENV === "production") return;

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "OnchainMe API",
        version: "0.0.0",
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
  });

  await fastify.register(swaggerUi, { routePrefix: "/docs" });
});
```

- [ ] **Step 5: Update `apps/api/src/server.ts`**

Replace the `buildServer` function body to register the plugins:

```typescript
import Fastify, { type FastifyInstance } from "fastify";
import { loadEnv } from "@onchainme/shared";
import { registerRoutes } from "./routes/index.js";
import { requestIdPlugin } from "./plugins/request-id.js";
import { errorEnvelopePlugin } from "./plugins/error-envelope.js";
import { corsPlugin } from "./plugins/cors.js";
import { swaggerPlugin } from "./plugins/swagger.js";

export async function buildServer(): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
          : undefined,
    },
  });

  await app.register(requestIdPlugin);
  await app.register(errorEnvelopePlugin);
  await app.register(corsPlugin);
  await app.register(swaggerPlugin);
  await registerRoutes(app);

  return app;
}

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildServer();
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info({ signal }, "shutting down");
      await app.close();
      process.exit(0);
    });
  }
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  void start();
}
```

- [ ] **Step 6: Re-run health test (still passes)**

Run: `pnpm --filter @onchainme/api test`
Expected: still 1 test passes; plugins do not break the health route.

- [ ] **Step 7: Manual check Swagger UI**

Run: `pnpm dev:api` in one terminal.
Open `http://localhost:3001/docs` in a browser.
Expected: Swagger UI loads showing the `/api/v1/health` endpoint.

Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/plugins/ apps/api/src/server.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add request-id, error-envelope, cors, swagger plugins"
```

---

## Task 14: apps/worker skeleton

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/worker.ts`

- [ ] **Step 1: Create `apps/worker/package.json`**

```json
{
  "name": "@onchainme/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/worker.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/worker.js",
    "dev": "tsx watch src/worker.ts"
  },
  "dependencies": {
    "@onchainme/shared": "workspace:*",
    "bullmq": "^5.21.0",
    "mongoose": "^8.7.0",
    "ioredis": "^5.4.1",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2"
  },
  "devDependencies": {
    "@types/node": "^20.16.10",
    "tsx": "^4.19.1",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Create `apps/worker/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "tests/**"]
}
```

- [ ] **Step 3: Create `apps/worker/src/worker.ts`**

```typescript
import { pino } from "pino";
import { closeDb, closeRedis, getRedisConnection, loadEnv } from "@onchainme/shared";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = pino({
    level: env.LOG_LEVEL,
    transport:
      env.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
        : undefined,
  });

  log.info("worker starting");

  // Verify Redis connectivity at startup; fail fast if it cannot connect.
  const redis = getRedisConnection();
  const ping = await redis.ping();
  if (ping !== "PONG") {
    log.error({ ping }, "redis ping did not return PONG");
    process.exit(1);
  }
  log.info("redis ready");

  // Job processors are registered here in subsequent plans.
  // For Plan 1 we just keep the worker process alive so docker-compose / Railway
  // can verify the service stays up.

  log.info("worker ready (no job processors registered yet)");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      log.info({ signal }, "shutting down");
      await closeRedis();
      await closeDb();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("worker crashed at startup:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Install deps**

Run: `pnpm install`
Expected: workspace deps linked.

- [ ] **Step 5: Smoke test**

Run: `pnpm dev:worker`
Expected: logs `worker starting`, `redis ready`, `worker ready (no job processors registered yet)`. Process stays running.

Stop with Ctrl-C; expect log `shutting down`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/ pnpm-lock.yaml
git commit -m "feat(worker): scaffold BullMQ worker process"
```

---

## Task 15: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      # Single-node MongoDB replica set for transactions.
      # We DON'T use GitHub's native services here because they don't allow
      # post-start commands; we need to run rs.initiate(). So we run Mongo
      # as a regular container in a step instead. See `Run mongo` step below.

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10

    env:
      NODE_ENV: test
      LOG_LEVEL: warn
      PORT: 3001
      MONGODB_URI: mongodb://localhost:27017/onchainme?replicaSet=rs0
      REDIS_URL: redis://localhost:6379
      JWT_SECRET: ci_secret_at_least_thirty_two_chars_xx
      COOKIE_DOMAIN: localhost
      HELIUS_API_KEY: ci_helius_key
      HELIUS_WEBHOOK_SECRET: ci_secret
      SOLANA_CLUSTER: devnet

    steps:
      - uses: actions/checkout@v4

      - name: Start MongoDB replica set
        run: |
          docker run -d --name mongo \
            -p 27017:27017 \
            mongo:7 \
            --replSet rs0 --bind_ip_all
          # Wait for mongo to be ready
          for i in 1 2 3 4 5 6 7 8 9 10; do
            docker exec mongo mongosh --quiet --eval "db.runCommand({ping: 1})" && break
            sleep 2
          done
          # Initiate single-node replica set
          docker exec mongo mongosh --quiet --eval "
            rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]});
          "
          # Wait for it to become PRIMARY
          for i in 1 2 3 4 5 6 7 8 9 10; do
            STATE=$(docker exec mongo mongosh --quiet --eval "rs.status().myState" || echo "0")
            if [ "$STATE" = "1" ]; then
              echo "Mongo is PRIMARY"
              break
            fi
            sleep 2
          done

      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - run: pnpm install --frozen-lockfile

      - run: pnpm typecheck

      - run: pnpm lint

      - run: pnpm db:sync-indexes

      - run: pnpm test

      - run: pnpm build
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for typecheck/lint/test/build"
```

(CI will run on the next push to a remote branch. If the repo has no remote yet, this commit is queued for whenever you `git push`.)

---

## Task 16: Dockerfiles for api and worker

**Files:**
- Create: `apps/api/Dockerfile`
- Create: `apps/worker/Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
**/node_modules
**/dist
.git
.github
*.log
.env
.env.local
.env.*.local
mongo_data/
redis_data/
coverage/
.vitest-cache/
```

- [ ] **Step 2: Create `apps/api/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- deps ----
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @onchainme/shared build && pnpm --filter @onchainme/api build

# ---- runtime ----
FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/packages/shared ./node_modules/@onchainme/shared
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/v1/health || exit 1
CMD ["node", "dist/server.js"]
```

- [ ] **Step 3: Create `apps/worker/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker
RUN pnpm --filter @onchainme/shared build && pnpm --filter @onchainme/worker build

FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/apps/worker/package.json ./package.json
COPY --from=build /repo/packages/shared ./node_modules/@onchainme/shared
CMD ["node", "dist/worker.js"]
```

- [ ] **Step 4: Build the api image**

Run: `docker build -t onchainme-api -f apps/api/Dockerfile .`
Expected: build succeeds; final image size < 300 MB.

- [ ] **Step 5: Build the worker image**

Run: `docker build -t onchainme-worker -f apps/worker/Dockerfile .`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add .dockerignore apps/api/Dockerfile apps/worker/Dockerfile
git commit -m "build: add multi-stage Dockerfiles for api and worker"
```

---

## Task 17: README and final verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
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

## Useful scripts

- `pnpm typecheck` — TypeScript across the monorepo
- `pnpm lint` — ESLint
- `pnpm test` — Vitest run
- `pnpm test:watch` — Vitest watch
- `pnpm build` — Build all packages
- `pnpm db:sync-indexes` — Sync Mongoose indexes to MongoDB (idempotent; safe to re-run)

## Layout

- `apps/api` — Fastify HTTP service
- `apps/worker` — BullMQ worker (scan jobs, mint confirmation, webhook handling)
- `packages/shared` — Mongoose models, Zod env, error types, queue helpers
- `docs/superpowers/specs/` — design specifications
- `docs/superpowers/plans/` — implementation plans (one per phase)
```

- [ ] **Step 2: Final end-to-end verification**

Run all of the following from a clean state to confirm Plan 1 acceptance:

```bash
# (from repo root, with docker-compose already up)
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm db:sync-indexes
pnpm test
pnpm build
```

Expected: every command exits with code 0.

Then in two terminals:

```bash
# Terminal 1
pnpm dev:api
# Terminal 2
pnpm dev:worker
```

Then in a third terminal:

```bash
curl -s http://localhost:3001/api/v1/health | jq
```

Expected output:

```json
{ "ok": true, "db": "ok", "redis": "ok" }
```

- [ ] **Step 3: Commit README**

```bash
git add README.md
git commit -m "docs: add README with quick-start"
```

---

## Done — what works now

- `apps/api` boots, `/api/v1/health` validates MongoDB + Redis connectivity, returns the spec'd envelope shape, exposes Swagger UI at `/docs` in dev
- `apps/worker` boots and stays up; ready to register processors in Plan 2
- All 8 spec collections exist in MongoDB with correct indexes (idle, populated by Plan 2 onward)
- `packages/shared` exports `connectDb()`/`mongoose`, Zod-validated `loadEnv()`, `AppError`/`ErrorCode`, BullMQ helpers, all 9 Mongoose models
- CI runs typecheck + lint + index sync + tests + build against ephemeral MongoDB (replica set) + Redis on every PR
- Both apps build into deployable Docker images

## What's next — Plan 2: Auth + Scanner

Plan 2 will add (in TDD order):

1. SIWS message construction and ed25519 verify
2. `POST /auth/nonce`, `POST /auth/verify`, `POST /auth/logout`, `GET /auth/me` with JWT cookies
3. JWT auth decorator and protected-route helper
4. Helius client wrapper with retry + rate-limit handling
5. `POST /scan/:wallet` endpoint that enqueues a BullMQ job
6. `GET /scan/job/:jobId` polling endpoint
7. Worker `scanWallet` processor with phased progress reporting
8. Jupiter swap parser (with pinned-fixture tests)
9. Magic Eden parser (buy / sell / list)
10. Parser router (programId → parser)
11. Persist normalized txs and `txRawCache`
12. Pinned-wallet snapshot regression test (3 wallets covering different profiles)

Plan 2 expected size: ~25 tasks.
