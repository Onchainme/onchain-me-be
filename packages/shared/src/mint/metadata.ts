import { loadEnv } from "../env.js";

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
