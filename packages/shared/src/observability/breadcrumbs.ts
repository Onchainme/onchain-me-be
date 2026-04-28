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
