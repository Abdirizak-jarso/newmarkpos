import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";

/**
 * The till's local database.
 *
 * SQLite on the terminal itself is the point: the shop sells with no network,
 * and what it sells drains to the central server through the SyncQueue when
 * the connection comes back.
 */

const url = process.env.DATABASE_URL ?? "file:./newmark.db";

function createClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Next's dev server reloads modules on every edit; without this the terminal
// accumulates open SQLite handles until it runs out of them mid-service.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
