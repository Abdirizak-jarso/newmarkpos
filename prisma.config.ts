import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 keeps the connection out of the schema. The till's database is a
 * local SQLite file so a terminal can trade with no network at all; point
 * DATABASE_URL at a central server's file (or swap the adapter) when the shop
 * moves to a shared back office.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./newmark.db",
  },
});
