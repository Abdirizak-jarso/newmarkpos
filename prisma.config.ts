import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 keeps the connection out of the schema.
 *
 * DATABASE_URL is a Neon Postgres connection string. Migrations want the
 * DIRECT one (no `-pooler` in the host) because a pooler cannot hold the
 * advisory lock a migration takes; the running app wants the pooled one. Set
 * DIRECT_DATABASE_URL when the two differ, which on Neon they do.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
});
