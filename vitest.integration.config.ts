import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration tests run against a real Postgres database seeded from the live
 * catalogue, so they exercise the actual service layer — transactions, stock
 * movements, manager approval and the audit trail — rather than mocks.
 *
 * TEST_DATABASE_URL must point at a scratch database, never the shop's: the
 * setup step resets it before every run. A Neon branch is the cheap way to get
 * one, and it is thrown away with the branch.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Parallel files would fight over the same rows and the same receipt
    // counter, whichever database is underneath.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      TERMINAL_ID: "T9",
      // Must match the pepper the seed used, or no seeded PIN resolves.
      PIN_PEPPER: "test-pepper-not-used-anywhere-real-0123456789abcdef",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
      "server-only": path.resolve(process.cwd(), "tests/stubs/server-only.ts"),
    },
  },
});
