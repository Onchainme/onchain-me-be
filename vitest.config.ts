import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    server: {
      deps: {
        inline: ["@sentry/node"],
      },
    },
    include: [
      "apps/*/src/**/*.{test,spec}.ts",
      "apps/*/tests/**/*.{test,spec}.ts",
      "packages/*/src/**/*.{test,spec}.ts",
      "packages/*/tests/**/*.{test,spec}.ts",
    ],
    coverage: {
      reporter: ["text", "html"],
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["**/*.{test,spec}.ts", "**/dist/**"],
    },
    testTimeout: 10_000,
    passWithNoTests: true,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
