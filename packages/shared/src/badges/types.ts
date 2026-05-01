import type { NormalizedTx } from "../parsers/types.js";

export type BadgeId =
  | "first_swap"
  | "jupiter_explorer"
  | "jupiter_power_user"
  | "swap_centurion"
  | "first_nft"
  | "nft_collector"
  | "nft_flipper"
  | "multi_protocol"
  | "early_adopter"
  | "active_trader";

export interface BadgeEvalContext {
  txs: NormalizedTx[];
  now: Date;
}

export interface BadgeEvalResult {
  badgeId: BadgeId;
  eligibleSince: Date;
  meta: Record<string, unknown>;
}

export type BadgeTier = "common" | "rare" | "epic" | "legendary";

export interface BadgeDef {
  id: BadgeId;
  weight: number;
  name: string;
  description: string;
  iconUrl: string;
  tier: BadgeTier;
  evaluate: (ctx: BadgeEvalContext) => BadgeEvalResult | null;
}
