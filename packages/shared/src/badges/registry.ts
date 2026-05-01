import type { BadgeDef, BadgeEvalContext, BadgeId, BadgeTier } from "./types.js";

const ONE_DAY_MS = 86_400_000;

function tierFromWeight(weight: number): BadgeTier {
  if (weight >= 75) return "legendary";
  if (weight >= 35) return "epic";
  if (weight >= 20) return "rare";
  return "common";
}

interface BadgeMeta {
  name: string;
  description: string;
}

const META: Record<BadgeId, BadgeMeta> = {
  first_swap: {
    name: "First Swap",
    description: "Сделал свой первый swap через Jupiter.",
  },
  jupiter_explorer: {
    name: "Jupiter Explorer",
    description: "10 свапов на Jupiter — ты уже не новичок.",
  },
  jupiter_power_user: {
    name: "Jupiter Power User",
    description: "50 свапов на Jupiter. Ликвидность тебя любит.",
  },
  swap_centurion: {
    name: "Swap Centurion",
    description: "100 свапов на Jupiter. Машина для торговли.",
  },
  first_nft: {
    name: "First NFT",
    description: "Купил свой первый NFT на Magic Eden.",
  },
  nft_collector: {
    name: "NFT Collector",
    description: "Собрал 10 уникальных NFT — настоящий коллекционер.",
  },
  nft_flipper: {
    name: "NFT Flipper",
    description: "5+ покупок и 5+ продаж NFT. Флиппинг — твоё.",
  },
  multi_protocol: {
    name: "Multi-Protocol",
    description: "Активен и в DEX, и в NFT-маркетплейсах.",
  },
  early_adopter: {
    name: "Early Adopter",
    description: "Кошелёк с историей больше года.",
  },
  active_trader: {
    name: "Active Trader",
    description: "50+ транзакций. Ты живёшь on-chain.",
  },
};

function iconUrlFor(id: BadgeId): string {
  return `/badges/${id}.svg`;
}

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

function withMeta(
  id: BadgeId,
  weight: number,
  evaluate: BadgeDef["evaluate"],
): BadgeDef {
  const meta = META[id];
  return {
    id,
    weight,
    name: meta.name,
    description: meta.description,
    iconUrl: iconUrlFor(id),
    tier: tierFromWeight(weight),
    evaluate,
  };
}

function buildCountBadge(
  id: BadgeId,
  weight: number,
  threshold: number,
  pick: (ctx: BadgeEvalContext) => { blockTime: Date }[],
): BadgeDef {
  return withMeta(id, weight, (ctx) => {
    const matches = pick(ctx);
    const at = nthOrNull(matches, threshold);
    if (!at) return null;
    return {
      badgeId: id,
      eligibleSince: at.blockTime,
      meta: { count: matches.length, threshold },
    };
  });
}

const firstSwap: BadgeDef = buildCountBadge("first_swap", 10, 1, jupiterSwaps);
const jupiterExplorer: BadgeDef = buildCountBadge("jupiter_explorer", 25, 10, jupiterSwaps);
const jupiterPowerUser: BadgeDef = buildCountBadge("jupiter_power_user", 50, 50, jupiterSwaps);
const swapCenturion: BadgeDef = buildCountBadge("swap_centurion", 100, 100, jupiterSwaps);
const firstNft: BadgeDef = buildCountBadge("first_nft", 10, 1, nftBuys);

const nftCollector: BadgeDef = withMeta("nft_collector", 30, (ctx) => {
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
});

const nftFlipper: BadgeDef = withMeta("nft_flipper", 40, (ctx) => {
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
});

const multiProtocol: BadgeDef = withMeta("multi_protocol", 25, (ctx) => {
  const swap = jupiterSwaps(ctx)[0];
  const me = magicEdenActivity(ctx)[0];
  if (!swap || !me) return null;
  const anchor = swap.blockTime.getTime() > me.blockTime.getTime() ? swap : me;
  return {
    badgeId: "multi_protocol",
    eligibleSince: anchor.blockTime,
    meta: { firstSwapAt: swap.blockTime, firstNftAt: me.blockTime },
  };
});

const earlyAdopter: BadgeDef = withMeta("early_adopter", 30, (ctx) => {
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
});

const activeTrader: BadgeDef = withMeta("active_trader", 40, (ctx) => {
  if (ctx.txs.length < 50) return null;
  const sorted = [...ctx.txs].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
  const at = sorted[49];
  if (!at) return null;
  return {
    badgeId: "active_trader",
    eligibleSince: at.blockTime,
    meta: { totalTxs: ctx.txs.length },
  };
});

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
