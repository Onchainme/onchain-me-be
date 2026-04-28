import * as Sentry from "@sentry/node";

let enabled = false;

export interface InitSentryOpts {
  component: "api" | "worker";
}

export function initSentry(opts: InitSentryOpts): void {
  const dsn = process.env["SENTRY_DSN"] ?? "";
  if (!dsn) {
    enabled = false;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env["NODE_ENV"] ?? "development",
    release: `onchainme@${process.env["SERVICE_VERSION"] ?? "dev"}`,
    tracesSampleRate: 0.1,
    initialScope: {
      tags: { component: opts.component },
    },
  });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context) {
      for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    }
    Sentry.captureException(err);
  });
}
