import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration tests run against a real SQLite database seeded from the live
 * catalogue, so they exercise the actual service layer — transactions, stock
 * movements, manager approval and the audit trail — rather than mocks.
 *
 * They use their own throwaway database file, created by `npm run test:setup`,
 * so running them never touches the till's data.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // The services share one SQLite connection; parallel files would fight
    // over the same rows and the same receipt counter.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: "file:./newmark-test.db",
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
