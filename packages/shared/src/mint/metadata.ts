import { loadEnv } from "../env.js";
import { getBadge } from "../badges/registry.js";

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
  editionNonce: null;
}

// Metaplex Token Metadata caps the on-chain `name` at 32 bytes. Our new
// badge ids like `meteora_position_original` overflow when prefixed with
// "OnchainMe — " (35 chars). Use the registry's display name instead
// ("Meteora $100k", "Seeker Genesis", etc.) — they're all ≤ 14 chars.
// The badgeId stays recoverable via the off-chain metadata URI path
// (see apps/api/src/routes/import.ts which parses json_uri).
const MAX_ON_CHAIN_NAME = 32;

function shortNameFor(badgeId: string): string {
  const def = getBadge(badgeId);
  const candidate = def?.name ?? badgeId;
  if (candidate.length <= MAX_ON_CHAIN_NAME) return candidate;
  return candidate.slice(0, MAX_ON_CHAIN_NAME);
}

export function buildMetadataArgs(badgeId: string): MetadataArgs {
  return {
    name: shortNameFor(badgeId),
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
