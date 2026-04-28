import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/node";
import {
  addParserWarning,
  addMintAudit,
} from "../../src/observability/breadcrumbs.js";
import { initSentry } from "../../src/observability/sentry.js";

const ORIG_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIG_ENV, SENTRY_DSN: "https://abc@sentry.example.com/1" };
  vi.restoreAllMocks();
  vi.spyOn(Sentry, "init").mockImplementation(() => undefined);
  initSentry({ component: "worker" });
});

describe("addParserWarning", () => {
  it("adds a 'parser' breadcrumb with category and data", () => {
    const spy = vi.spyOn(Sentry, "addBreadcrumb").mockImplementation(() => undefined);
    addParserWarning({ wallet: "WaLLet", parser: "jupiter", signature: "sig123", error: "missing route" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "parser",
        level: "warning",
        message: "jupiter parser warning",
        data: expect.objectContaining({
          wallet: "WaLLet",
          signature: "sig123",
          error: "missing route",
        }),
      }),
    );
  });

  it("is a no-op when sentry is not enabled", () => {
    process.env = { ...ORIG_ENV, SENTRY_DSN: "" };
    initSentry({ component: "worker" });
    const spy = vi.spyOn(Sentry, "addBreadcrumb").mockImplementation(() => undefined);
    addParserWarning({ wallet: "W", parser: "x", signature: "s", error: "e" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("addMintAudit", () => {
  it("adds an 'audit' breadcrumb with the partial-sign event", () => {
    const spy = vi.spyOn(Sentry, "addBreadcrumb").mockImplementation(() => undefined);
    addMintAudit({ wallet: "W", badgeId: "first_swap", action: "partial_sign" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "audit",
        level: "info",
        message: "mint partial_sign first_swap",
      }),
    );
  });
});
