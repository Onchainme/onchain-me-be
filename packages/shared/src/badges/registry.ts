import type {
  BadgeDef,
  BadgeEvalContext,
  BadgeEvalResult,
  BadgeId,
  BadgeProtocol,
  BadgeTier,
} from "./types.js";

// Tier weights tuned for end-user "points": bronze 100 / silver 250 /
// original 1000. Same scale applies to both volume tiers (Jupiter/Pump.fun)
// and position tiers (Orca/Meteora) so a $10k holder = $10k swapper.
const VOLUME_TIERS = [
  { tier: "bronze" as const, usd: 1_000, weight: 100 },
  { tier: "silver" as const, usd: 10_000, weight: 250 },
  { tier: "original" as const, usd: 100_000, weight: 1000 },
];

function volumeBadge(
  id: BadgeId,
  protocol: "jupiter" | "pumpfun",
  tier: "bronze" | "silver" | "original",
  thresholdUsd: number,
  weight: number,
  display: { name: string; description: string },
  files: { previewFile: string; animationFile: string },
): BadgeDef {
  return {
    id,
    protocol,
    tier,
    weight,
    name: display.name,
    description: display.description,
    previewFile: files.previewFile,
    animationFile: files.animationFile,
    thresholdUsd,
    evaluate: (ctx: BadgeEvalContext): BadgeEvalResult | null => {
      const have = ctx.protocolVolumeUsd[protocol] ?? 0;
      if (have < thresholdUsd) return null;
      return {
        badgeId: id,
        eligibleSince: ctx.now,
        meta: { volumeUsd: have, thresholdUsd },
      };
    },
  };
}

function positionBadge(
  id: BadgeId,
  protocol: "orca" | "meteora",
  tier: "bronze" | "silver" | "original",
  thresholdUsd: number,
  weight: number,
  display: { name: string; description: string },
  files: { previewFile: string; animationFile: string },
): BadgeDef {
  return {
    id,
    protocol,
    tier,
    weight,
    name: display.name,
    description: display.description,
    previewFile: files.previewFile,
    animationFile: files.animationFile,
    thresholdUsd,
    evaluate: (ctx: BadgeEvalContext): BadgeEvalResult | null => {
      const have = ctx.positionUsd[protocol] ?? 0;
      if (have < thresholdUsd) return null;
      return {
        badgeId: id,
        eligibleSince: ctx.now,
        meta: { positionUsd: have, thresholdUsd },
      };
    },
  };
}

const seekerBadge: BadgeDef = {
  id: "seeker_genesis",
  protocol: "seeker",
  tier: "single",
  // Sits between silver (250) and original (1000) — Seeker is rare but not
  // as heavyweight as a $100k position.
  weight: 500,
  name: "Seeker Genesis",
  description: "Holds the Solana Mobile Seeker Genesis Token.",
  previewFile: "seeker.webp",
  animationFile: "seeker.webp",
  thresholdUsd: null,
  evaluate: (ctx) =>
    ctx.seekerHeld
      ? { badgeId: "seeker_genesis", eligibleSince: ctx.now, meta: { source: "on-chain-nft" } }
      : null,
};

export const REGISTRY: Record<BadgeId, BadgeDef> = {
  jupiter_volume_bronze: volumeBadge(
    "jupiter_volume_bronze",
    "jupiter",
    "bronze",
    VOLUME_TIERS[0]!.usd,
    VOLUME_TIERS[0]!.weight,
    { name: "Jupiter $1k", description: "Cumulative Jupiter swap volume of at least $1,000." },
    { previewFile: "bronze-cat.png", animationFile: "bronze-cat.png" },
  ),
  jupiter_volume_silver: volumeBadge(
    "jupiter_volume_silver",
    "jupiter",
    "silver",
    VOLUME_TIERS[1]!.usd,
    VOLUME_TIERS[1]!.weight,
    { name: "Jupiter $10k", description: "Cumulative Jupiter swap volume of at least $10,000." },
    { previewFile: "silver-cat.png", animationFile: "silver-cat.png" },
  ),
  jupiter_volume_original: volumeBadge(
    "jupiter_volume_original",
    "jupiter",
    "original",
    VOLUME_TIERS[2]!.usd,
    VOLUME_TIERS[2]!.weight,
    { name: "Jupiter $100k", description: "Cumulative Jupiter swap volume of at least $100,000." },
    { previewFile: "cat.png", animationFile: "cat.webp" },
  ),

  pumpfun_volume_bronze: volumeBadge(
    "pumpfun_volume_bronze",
    "pumpfun",
    "bronze",
    VOLUME_TIERS[0]!.usd,
    VOLUME_TIERS[0]!.weight,
    { name: "Pump.fun $1k", description: "Cumulative Pump.fun trade volume of at least $1,000." },
    { previewFile: "bronze-pill.png", animationFile: "bronze-pill.png" },
  ),
  pumpfun_volume_silver: volumeBadge(
    "pumpfun_volume_silver",
    "pumpfun",
    "silver",
    VOLUME_TIERS[1]!.usd,
    VOLUME_TIERS[1]!.weight,
    { name: "Pump.fun $10k", description: "Cumulative Pump.fun trade volume of at least $10,000." },
    { previewFile: "silver-pill.png", animationFile: "silver-pill.png" },
  ),
  pumpfun_volume_original: volumeBadge(
    "pumpfun_volume_original",
    "pumpfun",
    "original",
    VOLUME_TIERS[2]!.usd,
    VOLUME_TIERS[2]!.weight,
    { name: "Pump.fun $100k", description: "Cumulative Pump.fun trade volume of at least $100,000." },
    { previewFile: "pill.png", animationFile: "pill.png" },
  ),

  orca_position_bronze: positionBadge(
    "orca_position_bronze",
    "orca",
    "bronze",
    VOLUME_TIERS[0]!.usd,
    VOLUME_TIERS[0]!.weight,
    { name: "Orca $1k", description: "Holding an Orca LP position worth at least $1,000." },
    { previewFile: "bronze-orca.png", animationFile: "bronze-orca.png" },
  ),
  orca_position_silver: positionBadge(
    "orca_position_silver",
    "orca",
    "silver",
    VOLUME_TIERS[1]!.usd,
    VOLUME_TIERS[1]!.weight,
    { name: "Orca $10k", description: "Holding an Orca LP position worth at least $10,000." },
    { previewFile: "silver-orca.png", animationFile: "silver-orca.png" },
  ),
  orca_position_original: positionBadge(
    "orca_position_original",
    "orca",
    "original",
    VOLUME_TIERS[2]!.usd,
    VOLUME_TIERS[2]!.weight,
    { name: "Orca $100k", description: "Holding an Orca LP position worth at least $100,000." },
    { previewFile: "orca.png", animationFile: "orca.png" },
  ),

  meteora_position_bronze: positionBadge(
    "meteora_position_bronze",
    "meteora",
    "bronze",
    VOLUME_TIERS[0]!.usd,
    VOLUME_TIERS[0]!.weight,
    { name: "Meteora $1k", description: "Holding a Meteora LP position worth at least $1,000." },
    { previewFile: "bronze-meteora.png", animationFile: "bronze-meteora.png" },
  ),
  meteora_position_silver: positionBadge(
    "meteora_position_silver",
    "meteora",
    "silver",
    VOLUME_TIERS[1]!.usd,
    VOLUME_TIERS[1]!.weight,
    { name: "Meteora $10k", description: "Holding a Meteora LP position worth at least $10,000." },
    { previewFile: "silver-meteora.png", animationFile: "silver-meteora.png" },
  ),
  meteora_position_original: positionBadge(
    "meteora_position_original",
    "meteora",
    "original",
    VOLUME_TIERS[2]!.usd,
    VOLUME_TIERS[2]!.weight,
    { name: "Meteora $100k", description: "Holding a Meteora LP position worth at least $100,000." },
    { previewFile: "meteora.png", animationFile: "meteora.png" },
  ),

  seeker_genesis: seekerBadge,
};

export const ALL_BADGE_IDS: readonly BadgeId[] = Object.keys(REGISTRY) as BadgeId[];

export function getBadge(id: string): BadgeDef | undefined {
  return REGISTRY[id as BadgeId];
}

export function definitionsArray(): BadgeDef[] {
  return ALL_BADGE_IDS.map((id) => REGISTRY[id]);
}

export type { BadgeEvalResult, BadgeProtocol, BadgeTier };
