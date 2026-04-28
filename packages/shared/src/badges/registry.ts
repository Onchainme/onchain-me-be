import type { BadgeDef, BadgeEvalContext, BadgeId } from "./types.js";

const ONE_DAY_MS = 86_400_000;

function jupiterSwaps(ctx: BadgeEvalContext) {
  return ctx.txs
    .filter((t) => t.protocol === "jupiter" && t.action === "swap")
    .sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
}

function nftBuys(ctx: BadgeEvalContext) {
  return ctx.txs
    .filter((t) => t.protocol === "magic_eden" && t.action === "nft_buy")
    .sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
}

function nftSells(ctx: BadgeEvalContext) {
  return ctx.txs
    .filter((t) => t.protocol === "magic_eden" && t.action === "nft_sell")
    .sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
}

function magicEdenActivity(ctx: BadgeEvalContext) {
  return ctx.txs
    .filter(
      (t) => t.protocol === "magic_eden" && (t.action === "nft_buy" || t.action === "nft_sell"),
    )
    .sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
}

function nthOrNull<T>(arr: T[], n: number): T | null {
  return arr.length >= n ? (arr[n - 1] ?? null) : null;
}

function distinctMints(txs: { meta: Record<string, unknown> }[]): Set<string> {
  const out = new Set<string>();
  for (const t of txs) {
    const mint = t.meta["mint"];
    if (typeof mint === "string") out.add(mint);
  }
  return out;
}

function buildCountBadge(
  id: BadgeId,
  weight: number,
  threshold: number,
  pick: (ctx: BadgeEvalContext) => { blockTime: Date }[],
): BadgeDef {
  return {
    id,
    weight,
    evaluate: (ctx) => {
      const matches = pick(ctx);
      const at = nthOrNull(matches, threshold);
      if (!at) return null;
      return {
        badgeId: id,
        eligibleSince: at.blockTime,
        meta: { count: matches.length, threshold },
      };
    },
  };
}

const firstSwap: BadgeDef = buildCountBadge("first_swap", 10, 1, jupiterSwaps);
const jupiterExplorer: BadgeDef = buildCountBadge("jupiter_explorer", 25, 10, jupiterSwaps);
const jupiterPowerUser: BadgeDef = buildCountBadge("jupiter_power_user", 50, 50, jupiterSwaps);
const swapCenturion: BadgeDef = buildCountBadge("swap_centurion", 100, 100, jupiterSwaps);
const firstNft: BadgeDef = buildCountBadge("first_nft", 10, 1, nftBuys);

const nftCollector: BadgeDef = {
  id: "nft_collector",
  weight: 30,
  evaluate: (ctx) => {
    const buys = nftBuys(ctx);
    const distinct = distinctMints(buys);
    if (distinct.size < 10) return null;
    let seen = 0;
    let qualifyingTx: { blockTime: Date } | null = null;
    const seenMints = new Set<string>();
    for (const t of buys) {
      const mint = (t.meta as Record<string, unknown>)["mint"];
      if (typeof mint !== "string") continue;
      if (seenMints.has(mint)) continue;
      seenMints.add(mint);
      seen += 1;
      if (seen === 10) {
        qualifyingTx = t;
        break;
      }
    }
    if (!qualifyingTx) return null;
    return {
      badgeId: "nft_collector",
      eligibleSince: qualifyingTx.blockTime,
      meta: { distinctMints: distinct.size },
    };
  },
};

const nftFlipper: BadgeDef = {
  id: "nft_flipper",
  weight: 40,
  evaluate: (ctx) => {
    const buys = nftBuys(ctx);
    const sells = nftSells(ctx);
    if (buys.length < 5 || sells.length < 5) return null;
    const fifthBuy = buys[4];
    const fifthSell = sells[4];
    if (!fifthBuy || !fifthSell) return null;
    const anchor =
      fifthBuy.blockTime.getTime() > fifthSell.blockTime.getTime() ? fifthBuy : fifthSell;
    return {
      badgeId: "nft_flipper",
      eligibleSince: anchor.blockTime,
      meta: { buys: buys.length, sells: sells.length },
    };
  },
};

const multiProtocol: BadgeDef = {
  id: "multi_protocol",
  weight: 25,
  evaluate: (ctx) => {
    const swap = jupiterSwaps(ctx)[0];
    const me = magicEdenActivity(ctx)[0];
    if (!swap || !me) return null;
    const anchor = swap.blockTime.getTime() > me.blockTime.getTime() ? swap : me;
    return {
      badgeId: "multi_protocol",
      eligibleSince: anchor.blockTime,
      meta: { firstSwapAt: swap.blockTime, firstNftAt: me.blockTime },
    };
  },
};

const earlyAdopter: BadgeDef = {
  id: "early_adopter",
  weight: 30,
  evaluate: (ctx) => {
    if (ctx.txs.length === 0) return null;
    const earliest = ctx.txs.reduce((min, t) =>
      t.blockTime.getTime() < min.blockTime.getTime() ? t : min,
    );
    const ageMs = ctx.now.getTime() - earliest.blockTime.getTime();
    if (ageMs <= 365 * ONE_DAY_MS) return null;
    return {
      badgeId: "early_adopter",
      eligibleSince: earliest.blockTime,
      meta: { earliestTxAt: earliest.blockTime, ageDays: Math.floor(ageMs / ONE_DAY_MS) },
    };
  },
};

const activeTrader: BadgeDef = {
  id: "active_trader",
  weight: 40,
  evaluate: (ctx) => {
    if (ctx.txs.length < 50) return null;
    const sorted = [...ctx.txs].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
    const at = sorted[49];
    if (!at) return null;
    return {
      badgeId: "active_trader",
      eligibleSince: at.blockTime,
      meta: { totalTxs: ctx.txs.length },
    };
  },
};

export const REGISTRY: Record<BadgeId, BadgeDef> = {
  first_swap: firstSwap,
  jupiter_explorer: jupiterExplorer,
  jupiter_power_user: jupiterPowerUser,
  swap_centurion: swapCenturion,
  first_nft: firstNft,
  nft_collector: nftCollector,
  nft_flipper: nftFlipper,
  multi_protocol: multiProtocol,
  early_adopter: earlyAdopter,
  active_trader: activeTrader,
};

export const ALL_BADGE_IDS: readonly BadgeId[] = Object.keys(REGISTRY) as BadgeId[];

export function getBadge(id: string): BadgeDef | undefined {
  return REGISTRY[id as BadgeId];
}

export function definitionsArray(): BadgeDef[] {
  return ALL_BADGE_IDS.map((id) => REGISTRY[id]);
}

export type { BadgeEvalResult } from "./types.js";
