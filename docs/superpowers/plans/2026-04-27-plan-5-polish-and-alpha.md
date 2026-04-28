# Plan 5 — Polish + Alpha

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the working backend (Plans 1–4) over the line for an alpha launch: error reporting via Sentry, an admin dashboard for queues, production-grade CORS/cookie config, OpenAPI response schemas for codegen, parser-warning visibility, a final devnet smoke test, and a deploy guide.

**Architecture:**
- **No new business logic.** Plan 5 is purely cross-cutting: observability, security hardening, doc/contract surface area. Every change is additive or replaces a placeholder.
- **Sentry is the only new external dependency.** It's optional at runtime: if `SENTRY_DSN` is empty, the SDK is initialized as a no-op so dev/test environments stay quiet.
- **Bull-Board is mounted inside the api app**, not as a separate service — keeps deploy simple. Locked behind HTTP basic auth via `ADMIN_BASIC_AUTH=user:pass`.
- **OpenAPI hardening is mechanical**: every route that currently has a `body` schema gets matching `response: {200: ..., 4xx: errorEnvelopeSchema}`. The api builds a single `errorEnvelopeSchema` once and reuses it.
- **Devnet smoke is captured as a curl-based runbook** in the README, executed once by hand to confirm Plans 1–4 cohere on real Solana devnet (not just MSW mocks).

**Tech Stack additions:**
- `@sentry/node` 8.x — error capture + breadcrumbs (api + worker)
- `@bull-board/api`, `@bull-board/fastify` — queue dashboard
- `@fastify/basic-auth` — protects `/admin/*`

**Spec reference:** [`docs/superpowers/specs/2026-04-27-onchainme-backend-design.md`](../specs/2026-04-27-onchainme-backend-design.md) — §7 (observability stack: Sentry, Bull-Board, audit, request-id), §5 (rate limits + endpoint list — every endpoint listed there gets a response schema), §8 (testing strategy — coverage targets are revisited after Plan 5).

**Exit criterion:** All of these are true on a fresh checkout:
1. `pnpm test` green; ≥ 145 tests (138 from Plan 4 + ~7 new across Sentry, Bull-Board, response schemas).
2. `pnpm typecheck && pnpm lint && pnpm build` clean across api + worker + shared.
3. With `SENTRY_DSN` unset, both apps boot silently. With it set, manually triggering a 5xx (e.g., kill mongo mid-request) appears in Sentry within ~30s.
4. `curl http://localhost:3001/admin/queues` returns 401; `curl -u admin:secret` returns the dashboard HTML.
5. `curl http://localhost:3001/docs/json | jq '.paths | keys'` returns every documented route, and `.paths."/api/v1/mint/single".post.responses` includes `200`, `401`, `409`, `422`, `503` — not just the default error.
6. Devnet smoke script (Task 7) runs end-to-end on a fresh wallet without manual intervention; output appended to README as "Last run: YYYY-MM-DD".
7. Deploy guide (Task 8) covers Railway (api + worker dynos), MongoDB Atlas (M0 free), Upstash Redis, env-var checklist, custom domain TLS, Sentry release tagging.

---

## File Structure (created or modified)

```
onchainme-backend/
├── packages/
│   └── shared/
│       └── src/
│           ├── env.ts                          # MODIFIED: add ADMIN_BASIC_AUTH; promote SENTRY_DSN to nullable URL
│           ├── observability/
│           │   ├── sentry.ts                   # initSentry() — shared init for api + worker
│           │   └── breadcrumbs.ts              # addParserWarning(), addMintAudit() helpers
│           ├── mint/
│           │   └── metadata.ts                 # MODIFIED: drop dead string fields (Task 4 review residue)
│           └── tests/
│               └── observability/
│                   └── sentry.test.ts          # init no-op when DSN empty; init real client when set
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── server.ts                       # MODIFIED: initSentry() before plugins
│   │   │   ├── plugins/
│   │   │   │   ├── error-envelope.ts           # MODIFIED: capture 5xx to Sentry with requestId
│   │   │   │   ├── cors.ts                     # MODIFIED: regex allows wildcard subdomain in prod
│   │   │   │   ├── basic-auth.ts               # NEW: registers @fastify/basic-auth scoped to /admin/*
│   │   │   │   └── bull-board.ts               # NEW: mounts dashboard at /admin/queues
│   │   │   ├── routes/
│   │   │   │   ├── health.ts                   # MODIFIED: response schema
│   │   │   │   ├── auth.ts                     # MODIFIED: response schemas on all 4 endpoints
│   │   │   │   ├── scan.ts                     # MODIFIED: response schemas
│   │   │   │   ├── lands.ts                    # MODIFIED: response schemas
│   │   │   │   ├── placements.ts               # MODIFIED: response schemas
│   │   │   │   ├── mint.ts                     # MODIFIED: response schemas
│   │   │   │   └── webhooks.ts                 # MODIFIED: response schema
│   │   │   └── schemas/
│   │   │       └── error-envelope.ts           # NEW: shared Zod schema for `{error: {code, message, details?}}`
│   │   └── tests/
│   │       ├── bull-board.spec.ts              # 401/200 with basic auth
│   │       └── openapi.spec.ts                 # /docs/json declares response schemas for every route
│   └── worker/
│       └── src/
│           ├── worker.ts                       # MODIFIED: initSentry() + capture failed jobs
│           └── jobs/
│               └── scanWallet.ts               # MODIFIED: addParserWarning() breadcrumb on each warning
├── scripts/
│   └── devnet-smoke.sh                         # NEW: runs end-to-end mint flow on devnet
└── README.md                                   # MODIFIED: deploy guide + smoke test result
```

---

## Task 1: Sentry init (shared) + env additions

**Files:**
- Modify: `packages/shared/src/env.ts`
- Modify: `.env.example` and `.env.local`
- Create: `packages/shared/src/observability/sentry.ts`
- Create: `packages/shared/tests/observability/sentry.test.ts`
- Add dep to shared: `@sentry/node`

### Step 1: Add dep

```bash
pnpm --filter @onchainme/shared add @sentry/node
```

### Step 2: Tighten env

In `packages/shared/src/env.ts`, find:

```typescript
SENTRY_DSN: z.string().optional().default(""),
```

Replace with (keeping it optional but accepting empty string OR a URL):

```typescript
SENTRY_DSN: z.string().refine(
  (v) => v === "" || /^https?:\/\//.test(v),
  { message: "SENTRY_DSN must be empty or a URL" },
).default(""),
ADMIN_BASIC_AUTH: z.string().regex(/^[^:]+:[^:]+$/, "ADMIN_BASIC_AUTH must be user:pass").optional().default("admin:change_me"),
SERVICE_VERSION: z.string().default("dev"),  // for Sentry release tag; defaults to "dev" if missing
```

In `.env.example`, append:

```
# --- Observability ---
SENTRY_DSN=
ADMIN_BASIC_AUTH=admin:change_me_in_prod
SERVICE_VERSION=dev
```

Mirror in `.env.local` (use `admin:local` for `ADMIN_BASIC_AUTH`).

### Step 3: Failing test at `packages/shared/tests/observability/sentry.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { initSentry, isSentryEnabled } from "../../src/observability/sentry.js";

const ORIG_ENV = process.env;

function setEnv(extras: Record<string, string> = {}) {
  process.env = { ...ORIG_ENV };
  Object.assign(process.env, extras);
}

beforeEach(() => {
  setEnv();
  vi.restoreAllMocks();
});

describe("initSentry", () => {
  it("is a no-op when SENTRY_DSN is empty", () => {
    setEnv({ SENTRY_DSN: "", SERVICE_VERSION: "test" });
    const spy = vi.spyOn(Sentry, "init");
    initSentry({ component: "api" });
    expect(spy).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("initializes the Sentry client when SENTRY_DSN is set", () => {
    setEnv({
      SENTRY_DSN: "https://abc@sentry.example.com/1",
      SERVICE_VERSION: "v1.2.3",
      NODE_ENV: "production",
    });
    const spy = vi.spyOn(Sentry, "init").mockImplementation(() => undefined);
    initSentry({ component: "api" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://abc@sentry.example.com/1",
        environment: "production",
        release: "onchainme@v1.2.3",
      }),
    );
    expect(isSentryEnabled()).toBe(true);
  });

  it("tags every event with the component name", () => {
    setEnv({ SENTRY_DSN: "https://abc@sentry.example.com/1" });
    const spy = vi.spyOn(Sentry, "init").mockImplementation(() => undefined);
    initSentry({ component: "worker" });
    const opts = spy.mock.calls[0]?.[0] as { initialScope?: { tags?: Record<string, string> } };
    expect(opts.initialScope?.tags?.["component"]).toBe("worker");
  });
});
```

### Step 4: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test sentry
```

### Step 5: Implement `packages/shared/src/observability/sentry.ts`

```typescript
import * as Sentry from "@sentry/node";

let enabled = false;

export interface InitSentryOpts {
  component: "api" | "worker";
}

export function initSentry(opts: InitSentryOpts): void {
  const dsn = process.env["SENTRY_DSN"] ?? "";
  if (!dsn) {
    enabled = false;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env["NODE_ENV"] ?? "development",
    release: `onchainme@${process.env["SERVICE_VERSION"] ?? "dev"}`,
    tracesSampleRate: 0.1,
    initialScope: {
      tags: { component: opts.component },
    },
  });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context) {
      for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    }
    Sentry.captureException(err);
  });
}
```

### Step 6: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test sentry
```

Expected: 3 tests pass.

### Step 7: Re-export from `packages/shared/src/index.ts`

```typescript
export { initSentry, isSentryEnabled, captureException } from "./observability/sentry.js";
```

### Step 8: Build clean

```bash
pnpm --filter @onchainme/shared build
```

---

## Task 2: Sentry breadcrumb helpers

**Files:**
- Create: `packages/shared/src/observability/breadcrumbs.ts`
- Create: `packages/shared/tests/observability/breadcrumbs.test.ts`

Helpers used by api + worker to add structured breadcrumbs without requiring callers to import `@sentry/node` directly.

### Step 1: Failing test at `packages/shared/tests/observability/breadcrumbs.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/node";
import {
  addParserWarning,
  addMintAudit,
} from "../../src/observability/breadcrumbs.js";
import { initSentry } from "../../src/observability/sentry.js";

const ORIG_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIG_ENV, SENTRY_DSN: "https://abc@sentry.example.com/1" };
  vi.restoreAllMocks();
  vi.spyOn(Sentry, "init").mockImplementation(() => undefined);
  initSentry({ component: "worker" });
});

describe("addParserWarning", () => {
  it("adds a 'parser' breadcrumb with category and data", () => {
    const spy = vi.spyOn(Sentry, "addBreadcrumb").mockImplementation(() => undefined);
    addParserWarning({ wallet: "WaLLet", parser: "jupiter", signature: "sig123", error: "missing route" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "parser",
        level: "warning",
        message: "jupiter parser warning",
        data: expect.objectContaining({
          wallet: "WaLLet",
          signature: "sig123",
          error: "missing route",
        }),
      }),
    );
  });

  it("is a no-op when sentry is not enabled", () => {
    process.env = { ...ORIG_ENV, SENTRY_DSN: "" };
    initSentry({ component: "worker" });
    const spy = vi.spyOn(Sentry, "addBreadcrumb").mockImplementation(() => undefined);
    addParserWarning({ wallet: "W", parser: "x", signature: "s", error: "e" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("addMintAudit", () => {
  it("adds an 'audit' breadcrumb with the partial-sign event", () => {
    const spy = vi.spyOn(Sentry, "addBreadcrumb").mockImplementation(() => undefined);
    addMintAudit({ wallet: "W", badgeId: "first_swap", action: "partial_sign" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "audit",
        level: "info",
        message: "mint partial_sign first_swap",
      }),
    );
  });
});
```

### Step 2: Run, verify FAIL

```bash
pnpm --filter @onchainme/shared test breadcrumbs
```

### Step 3: Implement `packages/shared/src/observability/breadcrumbs.ts`

```typescript
import * as Sentry from "@sentry/node";
import { isSentryEnabled } from "./sentry.js";

export interface ParserWarningInput {
  wallet: string;
  parser: string;
  signature: string;
  error: string;
}

export function addParserWarning(input: ParserWarningInput): void {
  if (!isSentryEnabled()) return;
  Sentry.addBreadcrumb({
    category: "parser",
    level: "warning",
    message: `${input.parser} parser warning`,
    data: {
      wallet: input.wallet,
      signature: input.signature,
      error: input.error,
    },
  });
}

export interface MintAuditInput {
  wallet: string;
  badgeId: string;
  action: "partial_sign" | "confirm" | "webhook_claim";
}

export function addMintAudit(input: MintAuditInput): void {
  if (!isSentryEnabled()) return;
  Sentry.addBreadcrumb({
    category: "audit",
    level: "info",
    message: `mint ${input.action} ${input.badgeId}`,
    data: { wallet: input.wallet },
  });
}
```

### Step 4: Run, verify PASS

```bash
pnpm --filter @onchainme/shared test breadcrumbs
```

Expected: 3 tests pass.

### Step 5: Re-export

```typescript
export { addParserWarning, addMintAudit } from "./observability/breadcrumbs.js";
```

### Step 6: Build clean

```bash
pnpm --filter @onchainme/shared build
```

---

## Task 3: Wire Sentry into api + worker + scan warnings

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/plugins/error-envelope.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/jobs/scanWallet.ts`
- Modify: `apps/api/src/routes/mint.ts` (audit breadcrumb on partial-sign + confirm)

### Step 1: Init Sentry in api boot

In `apps/api/src/server.ts`, find the `buildServer()` opening:

```typescript
export async function buildServer(): Promise<FastifyInstance> {
  const env = loadEnv();
```

Add `initSentry({ component: "api" });` immediately after `loadEnv()`. Add the import: `import { initSentry } from "@onchainme/shared";`

### Step 2: Capture 5xx in error-envelope

Read `apps/api/src/plugins/error-envelope.ts`. Inside the `setErrorHandler` block, after the response is built but before sending, capture if `statusCode >= 500`:

```typescript
import { captureException } from "@onchainme/shared";

// inside the handler, after determining statusCode:
if (statusCode >= 500) {
  captureException(error, {
    requestId: request.id,
    route: request.routeOptions?.url ?? request.url,
    method: request.method,
  });
}
```

(Adapt to the actual handler shape — the existing plugin already builds `requestId` and the code envelope.)

### Step 3: Init Sentry + capture failed jobs in worker

In `apps/worker/src/worker.ts`:

- Add `import { initSentry, captureException } from "@onchainme/shared";` to the imports.
- Inside `main()`, immediately after `loadEnv()`, call `initSentry({ component: "worker" });`.
- In each worker's `failed` handler, also call `captureException(err, { jobId: job?.id, queue: <name> })`. Existing code logs via pino — keep that AND add the Sentry call.

Example for `scanWorker`:

```typescript
scanWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err }, "scanWallet job failed");
  captureException(err, { jobId: job?.id, queue: "scan" });
});
```

Same for `balanceWorker`.

### Step 4: Add parser-warning breadcrumbs in scanWallet

In `apps/worker/src/jobs/scanWallet.ts`, find where `warnings.push(...)` happens (line ~50). Right after pushing, also add a Sentry breadcrumb so when we eventually capture an exception in the same job execution, the breadcrumb trail shows parser warnings. Pass `walletAddress` from the job data:

```typescript
import { addParserWarning } from "@onchainme/shared";

// inside the loop:
if (r.warning) {
  warnings.push({ signature: tx.signature, parser: r.warning.parser, error: r.warning.error });
  addParserWarning({
    wallet: walletAddress,         // already in scope from job.data
    parser: r.warning.parser,
    signature: tx.signature,
    error: r.warning.error,
  });
}
```

### Step 5: Add mint audit breadcrumbs in api routes

In `apps/api/src/routes/mint.ts`:

- After successful `buildMintTransaction` (in `/mint/single` handler), call `addMintAudit({wallet, badgeId, action: "partial_sign"})`.
- After successful claim insert in `/mint/confirm`, call `addMintAudit({wallet, badgeId, action: "confirm"})`.

In `apps/api/src/routes/webhooks.ts`:

- After successful `BadgeClaim.findOneAndUpdate` upsert in the compressed event loop, call `addMintAudit({wallet: c.newLeafOwner, badgeId: c.badgeId, action: "webhook_claim"})`.

### Step 6: Verification

No new tests needed (helpers already covered in Tasks 1–2). Run:

```bash
pnpm typecheck
pnpm --filter @onchainme/api test
pnpm --filter @onchainme/worker build
```

All clean. Existing 138 tests still pass.

### Step 7: Manual smoke (optional, for confidence)

With `SENTRY_DSN=` in `.env.local` (empty), boot api: `pnpm dev:api`. Hit a route that triggers a 5xx (e.g., kill mongo and call `/api/v1/health`). Confirm in console that no Sentry HTTP calls go out. Then set a real DSN and repeat — confirm event appears in Sentry within 30s.

---

## Task 4: Bull-Board dashboard at /admin/queues

**Files:**
- Add deps to api: `@bull-board/api`, `@bull-board/fastify`, `@fastify/basic-auth`
- Create: `apps/api/src/plugins/basic-auth.ts`
- Create: `apps/api/src/plugins/bull-board.ts`
- Modify: `apps/api/src/server.ts` (register both plugins)
- Create: `apps/api/tests/bull-board.spec.ts`

### Step 1: Add deps

```bash
pnpm --filter @onchainme/api add @bull-board/api @bull-board/fastify @fastify/basic-auth
```

### Step 2: Failing test at `apps/api/tests/bull-board.spec.ts`

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";
import { closeDb, closeRedis, connectDb } from "@onchainme/shared";

const app = await buildServer();
await connectDb();

afterAll(async () => {
  await app.close();
  await closeDb();
  await closeRedis();
});

describe("GET /admin/queues", () => {
  it("returns 401 without basic auth", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/queues" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with wrong credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/queues",
      headers: { authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with correct credentials", async () => {
    // .env.local sets ADMIN_BASIC_AUTH=admin:local (per Task 1 step 2)
    const res = await app.inject({
      method: "GET",
      url: "/admin/queues",
      headers: { authorization: "Basic " + Buffer.from("admin:local").toString("base64") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>"); // Bull-Board renders an HTML page
  });
});
```

### Step 3: Run, verify FAIL

```bash
pnpm --filter @onchainme/api test bull-board
```

Expected: 404 / module-not-loaded errors.

### Step 4: Implement `apps/api/src/plugins/basic-auth.ts`

```typescript
import fp from "fastify-plugin";
import basicAuth from "@fastify/basic-auth";
import { loadEnv } from "@onchainme/shared";

export const basicAuthPlugin = fp(async (fastify) => {
  const env = loadEnv();
  const [user, pass] = env.ADMIN_BASIC_AUTH.split(":");
  await fastify.register(basicAuth, {
    validate: async (username, password) => {
      if (username !== user || password !== pass) {
        throw new Error("Invalid credentials");
      }
    },
    authenticate: { realm: "OnchainMe Admin" },
  });
});
```

### Step 5: Implement `apps/api/src/plugins/bull-board.ts`

```typescript
import fp from "fastify-plugin";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { FastifyAdapter } from "@bull-board/fastify";
import { createQueue, QUEUE_NAMES } from "@onchainme/shared";

export const bullBoardPlugin = fp(async (fastify) => {
  const adapter = new FastifyAdapter();
  adapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [
      new BullMQAdapter(createQueue(QUEUE_NAMES.scan)),
      new BullMQAdapter(createQueue(QUEUE_NAMES.checkBalance)),
      new BullMQAdapter(createQueue(QUEUE_NAMES.mintConfirm)),
      new BullMQAdapter(createQueue(QUEUE_NAMES.webhook)),
    ],
    serverAdapter: adapter,
  });

  await fastify.register(
    async (scoped) => {
      scoped.addHook("onRequest", scoped.basicAuth);
      await scoped.register(adapter.registerPlugin(), { prefix: "/admin/queues" });
    },
    { prefix: "/" },
  );
});
```

> **Note:** `BullMQAdapter` import path uses the `.js` suffix because `@bull-board/api` ships ESM with explicit subpath exports.

### Step 6: Wire in `apps/api/src/server.ts`

Find the existing plugin registrations. Add (in this order — basic-auth before bull-board so the decorator exists):

```typescript
import { basicAuthPlugin } from "./plugins/basic-auth.js";
import { bullBoardPlugin } from "./plugins/bull-board.js";

// after rateLimitPlugin, before swaggerPlugin:
await app.register(basicAuthPlugin);
await app.register(bullBoardPlugin);
```

### Step 7: Run, verify PASS

```bash
pnpm --filter @onchainme/api test bull-board
```

Expected: 3 tests pass.

If the first test (no auth) returns 200 instead of 401, check that `bull-board` is wrapped in the scoped register block whose `onRequest` hook runs `basicAuth`. Some Bull-Board versions register their own `onRequest` that runs first — adjust the registration order or use `decorateRequest` style.

If you hit issues with the `BullMQAdapter` ESM import path, try:

```typescript
import { BullMQAdapter } from "@bull-board/api/dist/src/queueAdapters/bullMQ.js";
```

(Inspect the installed package's `package.json` `exports` map to find the correct subpath.)

### Step 8: Final check

```bash
pnpm --filter @onchainme/api build
```

Clean.

---

## Task 5: Production CORS + cookie tightening

**Files:**
- Modify: `packages/shared/src/env.ts` (add `FRONTEND_ORIGIN`)
- Modify: `apps/api/src/plugins/cors.ts`
- Modify: `apps/api/src/routes/auth.ts` (cookie SameSite logic)
- Modify: `.env.example` and `.env.local`

### Step 1: Add `FRONTEND_ORIGIN` to env

In `packages/shared/src/env.ts`, add (in the auth/cors section):

```typescript
FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
```

In `.env.example`:

```
# Origin of the frontend that calls this API. Used for CORS allowlist + cookie SameSite decision.
FRONTEND_ORIGIN=http://localhost:3000
```

Mirror in `.env.local`.

### Step 2: Update `apps/api/src/plugins/cors.ts`

Replace the existing dev/prod branch with:

```typescript
import fp from "fastify-plugin";
import cors from "@fastify/cors";
import { loadEnv } from "@onchainme/shared";

export const corsPlugin = fp(async (fastify) => {
  const env = loadEnv();
  const allowed = new URL(env.FRONTEND_ORIGIN);

  // In production, also allow any subdomain of the frontend origin's eTLD+1 if COOKIE_DOMAIN is multi-label.
  const subdomainPattern = new RegExp(
    `^${allowed.protocol}//([a-z0-9-]+\\.)?${allowed.hostname.replace(/\./g, "\\.")}$`,
  );

  await fastify.register(cors, {
    origin: env.NODE_ENV === "production"
      ? subdomainPattern
      : [env.FRONTEND_ORIGIN, "http://localhost:3000"],
    credentials: true,
  });
});
```

### Step 3: Update cookie SameSite logic in `apps/api/src/routes/auth.ts`

Find the `setCookie` call (around line 125). Replace the static `sameSite: "lax"` with a derived value:

```typescript
import { URL } from "node:url";

// inside the verify handler, before reply.setCookie:
const env = loadEnv();
const frontendUrl = new URL(env.FRONTEND_ORIGIN);
const apiHost = req.hostname;
// If frontend and api share a registrable domain, "lax" is fine.
// If they don't (e.g. frontend on vercel.app, api on railway.app), browser drops the cookie unless SameSite=None + Secure.
const crossSite = frontendUrl.hostname !== apiHost && !apiHost.endsWith(`.${env.COOKIE_DOMAIN}`);
const sameSite: "lax" | "none" = crossSite ? "none" : "lax";
const secure = sameSite === "none" || env.NODE_ENV === "production";

reply.setCookie("om_session", token, {
  httpOnly: true,
  secure,
  sameSite,
  path: "/",
  domain: env.COOKIE_DOMAIN === "localhost" ? undefined : env.COOKIE_DOMAIN,
  maxAge: 60 * 60 * 24 * 7,
});
```

(Preserve other existing cookie options.)

### Step 4: Verification

No new tests — existing auth.spec.ts covers the default lax+localhost path. Run:

```bash
pnpm --filter @onchainme/api test auth
```

3 auth tests still green. If a test fails because the cookie shape changed (e.g. the test asserts on `Set-Cookie` header substring), update the test assertion to be looser (e.g. `expect(setCookie).toMatch(/SameSite=Lax/i)`).

```bash
pnpm typecheck && pnpm lint
```

Clean.

---

## Task 6: OpenAPI response schemas (TDD via /docs/json contract test)

**Files:**
- Create: `apps/api/src/schemas/error-envelope.ts`
- Modify: every route in `apps/api/src/routes/*.ts`
- Create: `apps/api/tests/openapi.spec.ts`

### Step 1: Create the shared error envelope schema

`apps/api/src/schemas/error-envelope.ts`:

```typescript
import { z } from "zod";

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
```

### Step 2: Failing contract test at `apps/api/tests/openapi.spec.ts`

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";

const app = await buildServer();
await app.ready();

afterAll(async () => {
  await app.close();
});

const ROUTES_REQUIRING_RESPONSES = [
  ["GET", "/api/v1/health"],
  ["POST", "/api/v1/auth/nonce"],
  ["POST", "/api/v1/auth/verify"],
  ["GET", "/api/v1/auth/me"],
  ["POST", "/api/v1/auth/logout"],
  ["POST", "/api/v1/scan/{wallet}"],
  ["GET", "/api/v1/scan/jobs/{jobId}"],
  ["GET", "/api/v1/lands/{wallet}"],
  ["GET", "/api/v1/lands/{wallet}/inventory"],
  ["PUT", "/api/v1/placements"],
  ["POST", "/api/v1/mint/single"],
  ["POST", "/api/v1/mint/all"],
  ["POST", "/api/v1/mint/confirm"],
  ["POST", "/api/v1/webhooks/helius"],
] as const;

describe("OpenAPI document", () => {
  it("declares response schemas for every documented route", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };

    for (const [method, path] of ROUTES_REQUIRING_RESPONSES) {
      const op = doc.paths[path]?.[method.toLowerCase()];
      expect(op, `${method} ${path}`).toBeTruthy();
      expect(Object.keys(op!.responses)).toContain("200");
    }
  });

  it("declares 401/422 envelope for protected mint route", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const doc = res.json() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    const op = doc.paths["/api/v1/mint/single"]?.["post"];
    expect(Object.keys(op!.responses).sort()).toEqual(
      expect.arrayContaining(["200", "401", "409", "422", "503"]),
    );
  });
});
```

### Step 3: Run, verify FAIL

```bash
pnpm --filter @onchainme/api test openapi
```

Expected: failures because most routes only declare a `body` schema, not `response`.

### Step 4: Add response schemas, route by route

For each route file, add a `response: { 200: ..., 4xx: errorEnvelopeSchema, ... }` block to every `fastify.post`/`fastify.get`/`fastify.put` schema. Adjust the status codes to match what the handler actually throws.

**Pattern example for `apps/api/src/routes/mint.ts`** — `/mint/single`:

```typescript
import { errorEnvelopeSchema } from "../schemas/error-envelope.js";

const mintSingleResponse = z.object({
  transaction: z.string(),
  badgeId: z.string(),
  expiresAt: z.string(),
});

fastify.post(
  "/mint/single",
  {
    schema: {
      body: singleBody,
      response: {
        200: mintSingleResponse,
        401: errorEnvelopeSchema,
        409: errorEnvelopeSchema,
        422: errorEnvelopeSchema,
        503: errorEnvelopeSchema,
      },
    },
    preHandler: fastify.requireAuth,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  },
  async (req) => { /* unchanged */ },
);
```

Apply this pattern to **every** route. Skip nothing. Where a 200 body is empty, use `z.object({ ok: z.boolean() })` or whatever the handler actually returns.

> **One catch:** `fastify-type-provider-zod`'s serializer uses the response schema to **strip** unknown keys. If your handler returns extra debug fields, they'll be silently dropped. Audit each handler return type against the new schema.

### Step 5: Run, verify PASS

```bash
pnpm --filter @onchainme/api test openapi
```

Expected: 2 tests pass.

Re-run the full api suite to catch any handler returning fields that the new response schema strips:

```bash
pnpm --filter @onchainme/api test
```

If existing tests fail because expected fields are missing from response bodies — that's the strip behavior. Either add the fields to the schema, or remove them from the handler return value.

### Step 6: Build clean

```bash
pnpm --filter @onchainme/api build
pnpm typecheck
```

---

## Task 7: Devnet smoke runbook

**Files:**
- Create: `scripts/devnet-smoke.sh`
- Modify: `README.md` (link the smoke script + record the last-run date)

This is a manual end-to-end test. The script automates the curl-y bits but expects the user to have already provisioned a devnet `MERKLE_TREE_ADDRESS` (Plan 4 Task 11), funded the mint authority, and started api + worker.

### Step 1: Create `scripts/devnet-smoke.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

API="${API:-http://localhost:3001/api/v1}"
COOKIES=$(mktemp)
trap "rm -f $COOKIES" EXIT

echo "=== devnet smoke test — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. Generate test wallet
KEYFILE=$(mktemp --suffix=.json)
solana-keygen new -o "$KEYFILE" --no-bip39-passphrase --force --silent > /dev/null
WALLET=$(solana-keygen pubkey "$KEYFILE")
echo "Test wallet: $WALLET"

# 2. SIWS nonce
NONCE_RES=$(curl -sf -X POST "$API/auth/nonce" -H 'content-type: application/json' -d "{\"wallet\":\"$WALLET\"}")
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

# 5. Trigger scan (fresh wallet — will return ~0 eligibilities)
SCAN_RES=$(curl -sf -X POST "$API/scan/$WALLET?mode=full" -b "$COOKIES")
JOB_ID=$(echo "$SCAN_RES" | jq -r .jobId)
echo "Scan enqueued: $JOB_ID"

# Poll until done (max 60s)
for i in $(seq 1 30); do
  STATUS=$(curl -sf "$API/scan/jobs/$JOB_ID" -b "$COOKIES" | jq -r .status)
  [ "$STATUS" = "done" ] && break
  [ "$STATUS" = "failed" ] && { echo "Scan failed."; exit 1; }
  sleep 2
done
echo "Scan complete."

# 6. List eligibilities — fresh wallet has none, so /mint/single will 422
ELIG=$(curl -sf "$API/lands/$WALLET/inventory" -b "$COOKIES" | jq '.eligibilities | length')
echo "Eligibilities: $ELIG"

if [ "$ELIG" -eq 0 ]; then
  echo "Fresh wallet has no eligibilities — testing 422 path..."
  RC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/mint/single" \
    -H 'content-type: application/json' -b "$COOKIES" \
    -d '{"badgeId":"first_swap"}')
  [ "$RC" = "422" ] && echo "  ✓ 422 BADGE_NOT_ELIGIBLE" || { echo "  ✗ Expected 422 got $RC"; exit 1; }
else
  # 7. /mint/single → base64 tx
  BADGE=$(curl -sf "$API/lands/$WALLET/inventory" -b "$COOKIES" | jq -r '.eligibilities[0].badgeId')
  echo "Minting badge: $BADGE"
  TX_RES=$(curl -sf -X POST "$API/mint/single" -H 'content-type: application/json' -b "$COOKIES" \
    -d "{\"badgeId\":\"$BADGE\"}")
  TX_B64=$(echo "$TX_RES" | jq -r .transaction)

  # 8. Sign + send
  SIG=$(node -e "
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
  echo "Sent: $SIG"

  # 9. Wait + confirm
  sleep 6
  CONFIRM=$(curl -sf -X POST "$API/mint/confirm" -H 'content-type: application/json' -b "$COOKIES" \
    -d "{\"signature\":\"$SIG\",\"badgeId\":\"$BADGE\"}")
  echo "Confirmed: $(echo "$CONFIRM" | jq -c .)"

  # 10. Idempotency
  CONFIRM2=$(curl -sf -X POST "$API/mint/confirm" -H 'content-type: application/json' -b "$COOKIES" \
    -d "{\"signature\":\"$SIG\",\"badgeId\":\"$BADGE\"}")
  ALREADY=$(echo "$CONFIRM2" | jq -r .alreadyClaimed)
  [ "$ALREADY" = "true" ] && echo "  ✓ Idempotent" || { echo "  ✗ Expected alreadyClaimed=true"; exit 1; }
fi

echo "=== smoke OK ==="
```

Make executable:
```bash
chmod +x scripts/devnet-smoke.sh
```

### Step 2: Run it

Pre-reqs: api running on :3001, worker running, mongo + redis up, `.env.local` has a real Helius key + valid `MERKLE_TREE_ADDRESS` + funded `MINT_AUTHORITY_PRIVATE_KEY`.

```bash
./scripts/devnet-smoke.sh
```

Expected: exits 0. If a fresh wallet (no on-chain history) is used, the script will exercise the 422 path. To exercise the full mint, point the script at a wallet that already has Jupiter/ME activity (set `KEYFILE` env to skip the keygen step).

### Step 3: Append outcome to README

In the README, after the existing "Manual test checklist" subsection (added in Plan 4 Task 11), add:

```markdown
### Devnet smoke run history

| Date | Result | Notes |
|---|---|---|
| 2026-04-27 | TBD | First Plan 5 run |
```

Update the row with the actual date and result after running. If the run uncovered bugs, file them as a follow-up — don't fix-and-rerun without a reviewer.

---

## Task 8: Production deploy guide + cleanup MetadataArgs

**Files:**
- Modify: `packages/shared/src/mint/metadata.ts` (drop dead string fields)
- Modify: `packages/shared/tests/mint/metadata.test.ts` (update assertion)
- Modify: `README.md` (append "Production deploy" section)

### Step 1: Cleanup `MetadataArgs` (the Task 4 review residue)

In `packages/shared/src/mint/metadata.ts`, remove `tokenStandard` and `tokenProgramVersion` from the `MetadataArgs` interface AND from the returned object. Both fields are never read by consumers (the adapter in `prepare.ts` hardcodes the v5 enum values). Final shape:

```typescript
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
    editionNonce: null,
  };
}
```

Update the test in `packages/shared/tests/mint/metadata.test.ts` to no longer expect those fields. Run:

```bash
pnpm --filter @onchainme/shared test metadata
```

Expected: 3 tests pass. Then run the full suite to confirm no other test references the removed fields:

```bash
pnpm test
```

### Step 2: Append "Production deploy" section to README

After the existing "Devnet smoke run history" table, append:

```markdown
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
```
Dockerfile path: apps/api/Dockerfile
Start command:  (from Dockerfile CMD)
Public domain:  api.your-domain.xyz
Health check:   /api/v1/health
Env vars:       (see checklist below)
```

**worker service:**
```
Dockerfile path: apps/worker/Dockerfile
Start command:  (from Dockerfile CMD)
Public domain:  (none — internal only)
Health check:   (none — process-up is enough)
Env vars:       same as api
```

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
- Atlas M0: 512 MB storage. At ~1 KB/wallet plus tx cache, ≈ 100k wallets before paid upgrade.
- Upstash free: 10k commands/day. We expect < 5k/day at alpha volume.
- Railway: $5/month free credit; api + worker each consume ~$2–3/month idle.
- Helius free: 100k requests/month. One full scan ≈ 5 requests; 100k = 20k full scans.
- Sentry developer: 5k events/month. Plenty for alpha.

When any of these fills up, we either upgrade or shed load. Triage in this order: Helius (paid plan first), Atlas (M10 = $57/mo), Upstash (pay-as-you-go), Railway (Pro plan), Sentry (Team plan).
```

### Step 3: Final verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @onchainme/api build
pnpm --filter @onchainme/worker build
pnpm --filter @onchainme/shared build
```

All exit 0. Test count target: ≥ 145 (was 138; +3 sentry, +3 breadcrumbs, +3 bull-board, +2 openapi = +11; some pre-existing tests may have been updated for cookie/CORS changes).

### Step 4: Skim README for staleness

After all the additions, the README has grown. Skim once for:
- Conflicting instructions (e.g., dev-only env vars described twice).
- Broken internal links.
- Outdated test counts cited inline.

Fix any drift inline. No need for a separate task.

---

## Done — what works after Plan 5

- **Sentry** captures every 5xx (api) and post-retry job failure (worker), with `requestId`, `walletAddress`, `route` tags. Parser warnings ride along as breadcrumbs so when an exception fires mid-scan the trail shows what the parsers saw. Mint partial-signs and confirms are tagged `audit` for incident forensics.
- **Bull-Board** at `/admin/queues` (basic-auth) shows scan / checkBalance / mintConfirm / webhook queues with retry buttons.
- **CORS + cookie** correctly handle same-site dev (lax + non-secure) and cross-site prod (none + secure).
- **OpenAPI** declares 200 + every error code for all 14 routes. Client codegen has full type info.
- **Devnet smoke runbook** verifies the SIWS → scan → mint → confirm → idempotency loop on real Solana devnet.
- **Production deploy guide** covers Atlas + Upstash + Railway + Helius + Sentry with env-var checklist and cost ceilings.
- **Cleanup**: Task 4 review residue removed (`MetadataArgs` no longer carries dead string fields).
- ~145 tests pass.

---

## What's next — Plan 6: After alpha

Plan 5 ends at "alpha-ready". Anything past launch is its own brainstorm:

1. **Frontend** — separate spec, separate plan tree. Wallet adapter, mint UI, land renderer.
2. **Mainnet hardening** — audit log retention, key rotation playbook, mint authority cold-storage option.
3. **Webhook attribution** — proper `assetId → badgeId` lookup so the safety-net path doesn't depend on a frontend-supplied `badgeId` (Task 9 caveat).
4. **Performance** — connection pooling, parser parallelism, Redis-cached land render.
5. **Beta features** — referral codes, leaderboards, badge weighting tweaks, OG-image generation.

Each gets its own brainstorm → spec → plan cycle.
