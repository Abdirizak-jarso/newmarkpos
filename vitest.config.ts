import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests need their own seeded database and their own config;
    // `npm test` stays fast and side-effect free.
    exclude: ["tests/integration/**"],
    env: {
      // PINs cannot be hashed or looked up without a pepper. A fixed one here
      // keeps the unit tests deterministic and independent of anyone's .env.
      PIN_PEPPER: "test-pepper-not-used-anywhere-real-0123456789abcdef",
      TERMINAL_ID: "T0",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
      // Next injects this marker package at build time; unit tests import the
      // same modules directly and only need it to resolve to something.
      "server-only": path.resolve(process.cwd(), "tests/stubs/server-only.ts"),
    },
  },
});
