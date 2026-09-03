import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "./generated/prisma/client";

/**
 * The database connection.
 *
 * Neon Postgres over its serverless driver, because this runs on Vercel. A
 * Vercel function is a short-lived process that can be spun up by the hundred,
 * and a hundred processes each holding a TCP pool would exhaust Postgres'
 * connection limit long before the shop's traffic did. Neon's driver talks to
 * a connection pooler instead, so a burst of functions is a burst of requests
 * rather than a burst of connections.
 *
 * DATABASE_URL must therefore be Neon's POOLED connection string — the host
 * with `-pooler` in it. The direct string works locally and falls over under
 * concurrency in production, which is the worst way for it to fail: fine in
 * testing, broken on a Saturday.
 *
 * The client is built on first use rather than at import. `next build` imports
 * every server module to collect the routes, and a build machine legitimately
 * has no database — creating the connection up there would mean the app could
 * not be compiled without one. Nothing is deferred except the connecting: a
 * missing URL still throws, loudly, the first time anything asks for data.
 */

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the Neon pooled connection string.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString: url }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Next's dev server reloads modules on every edit; without this the process
// accumulates clients until it runs out of connections mid-service.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function client(): PrismaClient {
  const existing = globalForPrisma.prisma;
  if (existing) return existing;

  const created = createClient();
  // Cached globally in every environment: in dev this is what stops Next's
  // module-reload leak, and in production it lets one function instance reuse
  // its client across invocations instead of reconnecting every time.
  globalForPrisma.prisma = created;
  return created;
}

/**
 * Reads exactly like a PrismaClient at every call site — `db.sale.create(...)`
 * — but resolves the real one on the first property touched.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(client(), property, receiver);
    return typeof value === "function" ? value.bind(client()) : value;
  },
}) as PrismaClient;
