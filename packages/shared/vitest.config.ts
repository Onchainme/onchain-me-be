import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    server: {
      deps: {
        inline: ["@sentry/node"],
      },
    },
  },
});
