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
 * DATABASE_URL must therefore be Neon's POOLED connection string - the host
 * with `-pooler` in it. The direct string works locally and falls over under
 * concurrency in production, which is the worst way for it to fail: fine in
 * testing, broken on a Saturday.
 *
 * The client is built on first use rather than at import. `next build` imports
 * every server module to collect the routes, and a build machine legitimately
 * has no database - creating the connection up there would mean the app could
 * not be compiled without one. Nothing is deferred except the connecting: a
 * missing URL still throws, loudly, the first time anything asks for data.
 */

/**
 * Transaction timeouts, sized for the wire rather than for a local database.
 *
 * Prisma's defaults assume the database is a few milliseconds away: two
 * seconds to acquire a connection and five for the whole transaction body.
 * This one is in us-east-1 and the counter is in Nairobi, so a round trip is a
 * few hundred milliseconds - and a checkout makes a dozen of them inside the
 * transaction: the receipt number, the sale with its lines and payments, then
 * a read and two writes for every line's stock movement.
 *
 * On the defaults that arrives as `P2028: Unable to start a transaction in the
 * given time` - a 500, and a cashier reading "Could not complete the sale"
 * with a customer in front of them, for a sale nothing was wrong with. The
 * long timeout is not there to make slow queries acceptable; it is there so
 * that a slow link costs the shop seconds instead of the sale.
 */
export const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 30_000 } as const;

type TransactionOptions = { maxWait?: number; timeout?: number };
type TransactionCall = (arg: unknown, options?: TransactionOptions) => unknown;

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
 * Reads exactly like a PrismaClient at every call site - `db.sale.create(...)`
 * - but resolves the real one on the first property touched.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const prisma = client();
    const value = Reflect.get(prisma, property, receiver);
    if (typeof value !== "function") return value;

    // Every transaction in the app gets the timeouts above, rather than each
    // call site remembering to pass them. A call site that forgets is a sale
    // that fails intermittently, on the counter, in Nairobi and nowhere else -
    // so this is the one place that can guarantee none of them do. An explicit
    // option still wins, for the rare transaction that wants its own budget.
    if (property === "$transaction") {
      const call = value as unknown as TransactionCall;
      return (arg: unknown, options?: TransactionOptions) =>
        call.call(prisma, arg, { ...TRANSACTION_OPTIONS, ...options });
    }

    return value.bind(prisma);
  },
}) as PrismaClient;
