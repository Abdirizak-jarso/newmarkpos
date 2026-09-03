import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 keeps the connection out of the schema.
 *
 * DATABASE_URL is a Neon Postgres connection string. Migrations want the
 * DIRECT one (no `-pooler` in the host) because a pooler cannot hold the
 * advisory lock a migration takes; the running app wants the pooled one.
 *
 * Two ways that direct string reaches here, because two different setups name
 * it differently:
 *   - Set by hand, or via `.env.example`: DIRECT_DATABASE_URL.
 *   - Set by Vercel's native Neon integration, with no custom prefix: it
 *     creates DATABASE_URL_UNPOOLED alongside DATABASE_URL — never
 *     DIRECT_DATABASE_URL, which is a name of ours, not Neon's.
 * Both are accepted so a migration works whichever way the project was wired.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url:
      process.env.DIRECT_DATABASE_URL ??
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL ??
      "",
  },
});
