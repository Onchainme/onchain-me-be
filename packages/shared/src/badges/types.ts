/**
 * New badge model — protocol-tiered. The 13 ids correspond to:
 *   • Jupiter & Pump.fun:  cumulative USD swap volume, 3 tiers each
 *   • Orca & Meteora:      current LP position USD, 3 tiers each
 *   • Seeker:              holding the Seeker Genesis NFT (single tier)
 */

export type BadgeId =
  | "jupiter_volume_bronze"
  | "jupiter_volume_silver"
  | "jupiter_volume_original"
  | "pumpfun_volume_bronze"
  | "pumpfun_volume_silver"
  | "pumpfun_volume_original"
  | "orca_position_bronze"
  | "orca_position_silver"
  | "orca_position_original"
  | "meteora_position_bronze"
  | "meteora_position_silver"
  | "meteora_position_original"
  | "seeker_genesis";

export type BadgeTier = "bronze" | "silver" | "original" | "single";

export type BadgeProtocol =
  | "jupiter"
  | "pumpfun"
  | "orca"
  | "meteora"
  | "seeker";

/**
 * Snapshot of a wallet's state at evaluation time. Built by the scan worker
 * from `User.protocolVolume` (running total) + `User.positionSnapshot`
 * (point-in-time LP / NFT holdings).
 */
export interface BadgeEvalContext {
  protocolVolumeUsd: {
    jupiter: number;
    pumpfun: number;
  };
  positionUsd: {
    orca: number;
    meteora: number;
  };
  seekerHeld: boolean;
  /** Used as the eligibleSince timestamp on freshly-earned badges. */
  now: Date;
}

export interface BadgeEvalResult {
  badgeId: BadgeId;
  eligibleSince: Date;
  meta: Record<string, unknown>;
}

export interface BadgeDef {
  id: BadgeId;
  protocol: BadgeProtocol;
  tier: BadgeTier;
  /** Score weight (used by leaderboard sum). Higher tier ⇒ higher weight. */
  weight: number;
  name: string;
  description: string;
  /** Static preview (first frame). Lives at /badges/<previewFile> on the api. */
  previewFile: string;
  /** Animated file (GIF/APNG). Lives at /badges/<animationFile>. */
  animationFile: string;
  /** USD threshold for the badge, or null for non-volume badges (Seeker). */
  thresholdUsd: number | null;
  evaluate: (ctx: BadgeEvalContext) => BadgeEvalResult | null;
}
