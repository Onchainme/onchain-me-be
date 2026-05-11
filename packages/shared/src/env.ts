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
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),

  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]),
  SOLANA_RPC_URL: z.string().url(),
  HELIUS_API_KEY: z.string().min(1),
  HELIUS_WEBHOOK_SECRET: z.string().min(1),
  MINT_AUTHORITY_PRIVATE_KEY: z.string().min(1),
  MERKLE_TREE_ADDRESS: z.string().min(32).max(64),
  COLLECTION_ADDRESS: z.string().min(32).max(64).optional(),
  METADATA_BASE_URL: z.string().url(),

  // Paid-mint config. Mint fees are paid in lamports by the leafOwner (user)
  // and routed to CREATOR_ADDRESS in the same atomic transaction. Setting
  // MINT_PRICE_LAMPORTS=0 reverts to fully-sponsored mints (user pays no
  // price, but is still the fee payer — mint authority stops bleeding SOL).
  CREATOR_ADDRESS: z.string().min(32).max(64),
  MINT_PRICE_LAMPORTS: z.coerce.number().int().nonnegative().default(0),

  SENTRY_DSN: z.string().refine(
    (v) => v === "" || /^https?:\/\//.test(v),
    { message: "SENTRY_DSN must be empty or a URL" },
  ).default(""),
  ADMIN_BASIC_AUTH: z.string().regex(/^[^:]+:[^:]+$/, "ADMIN_BASIC_AUTH must be user:pass").optional().default("admin:change_me"),
  SERVICE_VERSION: z.string().default("dev"),

  // Expose POST /api/v1/dev/seed-eligibility[+all] outside of NODE_ENV=development.
  // Routes still go through fastify.requireAuth so a wallet can only seed its own
  // eligibility. Use this on alpha/devnet deploys where you keep NODE_ENV=production
  // but still want to bootstrap user inventories without a real Helius scan.
  ALLOW_DEV_ROUTES: z
    .union([z.literal("true"), z.literal("false"), z.literal("")])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
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

export function _resetEnvCache(): void {
  cached = undefined;
}
