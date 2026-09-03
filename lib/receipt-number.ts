/**
 * Receipt numbers.
 *
 * Each terminal has its own prefix and its own counter, so two tills selling
 * with no network between them can never mint the same number. T1-000412 and
 * T2-000412 are different sales and stay different when they meet on the
 * central server.
 *
 * Format: <PREFIX>-<6 digits>, e.g. T1-000412.
 *
 * No database import here on purpose: the caller passes the transaction it is
 * already inside, which is also what stops two concurrent checkouts on the
 * same till both reading 412.
 */

export function terminalId(): string {
  return process.env.TERMINAL_ID ?? "T1";
}

/** The slice of the client this needs — satisfied by a Prisma transaction. */
export interface ReceiptCounterStore {
  receiptCounter: {
    upsert(args: {
      where: { terminalId: string };
      create: { terminalId: string; prefix: string; nextNumber: number };
      update: { nextNumber: { increment: number } };
    }): Promise<{ prefix: string; nextNumber: number }>;
  };
}

/**
 * Take the next number for this terminal. Must be called inside the caller's
 * transaction so the read and the increment cannot be interleaved.
 */
export async function nextReceiptNumber(
  client: ReceiptCounterStore,
  terminal = terminalId(),
): Promise<string> {
  const counter = await client.receiptCounter.upsert({
    where: { terminalId: terminal },
    create: { terminalId: terminal, prefix: terminal, nextNumber: 2 },
    update: { nextNumber: { increment: 1 } },
  });

  // upsert returns the row *after* the increment, so the number just taken is
  // one below what is now stored — except on create, where 1 was reserved.
  return format(counter.prefix, counter.nextNumber - 1);
}

export function format(prefix: string, number: number): string {
  return `${prefix}-${String(number).padStart(6, "0")}`;
}

export function parse(receiptNumber: string): { prefix: string; number: number } | null {
  const match = /^([A-Z0-9]+)-(\d{4,})$/i.exec(receiptNumber.trim());
  if (!match) return null;
  return { prefix: match[1]!.toUpperCase(), number: Number(match[2]) };
}
