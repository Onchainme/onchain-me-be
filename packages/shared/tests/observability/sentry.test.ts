import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { initSentry, isSentryEnabled } from "../../src/observability/sentry.js";

const ORIG_ENV = process.env;

function setEnv(extras: Record<string, string> = {}) {
  process.env = { ...ORIG_ENV };
  Object.assign(process.env, extras);
}

beforeEach(() => {
  setEnv();
  vi.restoreAllMocks();
});

describe("initSentry", () => {
  it("is a no-op when SENTRY_DSN is empty", () => {
    setEnv({ SENTRY_DSN: "", SERVICE_VERSION: "test" });
    const spy = vi.spyOn(Sentry, "init");
    initSentry({ component: "api" });
    expect(spy).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("initializes the Sentry client when SENTRY_DSN is set", () => {
    setEnv({
      SENTRY_DSN: "https://abc@sentry.example.com/1",
      SERVICE_VERSION: "v1.2.3",
      NODE_ENV: "production",
    });
    const spy = vi.spyOn(Sentry, "init").mockImplementation(() => undefined);
    initSentry({ component: "api" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://abc@sentry.example.com/1",
        environment: "production",
        release: "onchainme@v1.2.3",
      }),
    );
    expect(isSentryEnabled()).toBe(true);
  });

  it("tags every event with the component name", () => {
    setEnv({ SENTRY_DSN: "https://abc@sentry.example.com/1" });
    const spy = vi.spyOn(Sentry, "init").mockImplementation(() => undefined);
    initSentry({ component: "worker" });
    const opts = spy.mock.calls[0]?.[0] as { initialScope?: { tags?: Record<string, string> } };
    expect(opts.initialScope?.tags?.["component"]).toBe("worker");
  });
});
