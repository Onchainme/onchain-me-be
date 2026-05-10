import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

// ---------- shared types ----------

export type Protocol = "jupiter" | "pumpfun" | "magic_eden" | "meteora" | "orca" | "other";
export type TxAction =
  | "swap"
  | "nft_buy"
  | "nft_sell"
  | "nft_list"
  | "lp_deposit"
  | "lp_withdraw";

// Per-protocol cumulative volume + checkpoint for incremental scans.
const protocolVolumeSubSchema = new Schema(
  {
    usd: { type: Number, default: 0 },
    // Newest tx signature we've already counted. Subsequent scans
    // fetch enhanced txs with `until: lastTxSig` and add to `usd`.
    lastTxSig: { type: String, default: null },
  },
  { _id: false },
);
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
    score: { type: Number, default: 0 },

    // Cumulative USD volume per swap protocol, with checkpoint sig so the
    // worker only counts newly-discovered txs on each rescan.
    protocolVolume: {
      type: new Schema(
        {
          jupiter: { type: protocolVolumeSubSchema, default: () => ({}) },
          pumpfun: { type: protocolVolumeSubSchema, default: () => ({}) },
        },
        { _id: false },
      ),
      default: () => ({}),
    },

    // Point-in-time snapshot of LP positions / NFT holdings refreshed on each
    // scan (no historical accumulation — current state only).
    positionSnapshot: {
      type: new Schema(
        {
          orcaUsd: { type: Number, default: 0 },
          meteoraUsd: { type: Number, default: 0 },
          seekerHeld: { type: Boolean, default: false },
          takenAt: Date,
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { _id: false, collection: "users" },
);
// leaderboard: sort by score desc, tiebreaker by wallet asc; rank lookup by score
userSchema.index({ score: -1, _id: 1 });
export type User = InferSchemaType<typeof userSchema> & { _id: string };
export const User: Model<User> =
  (mongoose.models["User"] as Model<User> | undefined) ??
  mongoose.model<User>("User", userSchema);

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
  (mongoose.models["ScanJob"] as Model<ScanJob> | undefined) ??
  mongoose.model<ScanJob>("ScanJob", scanJobSchema);

// ---------- txs ----------

const txSchema = new Schema(
  {
    _id: String, // signature
    walletAddress: { type: String, required: true },
    blockTime: { type: Date, required: true },
    protocol: {
      type: String,
      enum: ["jupiter", "pumpfun", "magic_eden", "meteora", "orca", "other"],
      required: true,
    },
    action: {
      type: String,
      enum: ["swap", "nft_buy", "nft_sell", "nft_list", "lp_deposit", "lp_withdraw"],
      required: true,
    },
    amountUsd: Number,
    // USD value of this single tx, computed via price-lookup on the bigger leg
    // of a swap (max(inputUsd, outputUsd)). Used by the volume-tier badges.
    volumeUsd: { type: Number, default: null },
    meta: Schema.Types.Mixed,
  },
  { _id: false, collection: "txs" },
);
txSchema.index({ walletAddress: 1, blockTime: -1 });
txSchema.index({ walletAddress: 1, protocol: 1 });
export type Tx = InferSchemaType<typeof txSchema> & { _id: string };
export const Tx: Model<Tx> =
  (mongoose.models["Tx"] as Model<Tx> | undefined) ??
  mongoose.model<Tx>("Tx", txSchema);

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
  (mongoose.models["TxRawCache"] as Model<TxRawCache> | undefined) ??
  mongoose.model<TxRawCache>("TxRawCache", txRawCacheSchema);

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
  (mongoose.models["BadgeEligibility"] as Model<BadgeEligibility> | undefined) ??
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
  (mongoose.models["BadgeClaim"] as Model<BadgeClaim> | undefined) ??
  mongoose.model<BadgeClaim>("BadgeClaim", badgeClaimSchema);

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
  (mongoose.models["Placement"] as Model<Placement> | undefined) ??
  mongoose.model<Placement>("Placement", placementSchema);

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
  (mongoose.models["AuthNonce"] as Model<AuthNonce> | undefined) ??
  mongoose.model<AuthNonce>("AuthNonce", authNonceSchema);

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
  (mongoose.models["HeliusWebhookEvent"] as Model<HeliusWebhookEvent> | undefined) ??
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
