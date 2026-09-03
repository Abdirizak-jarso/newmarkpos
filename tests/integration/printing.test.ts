import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkout } from "@/lib/services/checkout";
import { reprintReceipt } from "@/lib/services/sales";
import {
  drainPrintQueue,
  MAX_PRINT_ATTEMPTS,
  NetworkPrinter,
  NoopPrinter,
} from "@/lib/adapters/printer";
import { fromBase64, receiptToPlainText } from "@/lib/adapters/escpos";
import type { CurrentUser } from "@/lib/session";

/**
 * Printing, against a real socket.
 *
 * An 80mm thermal printer on the shop LAN is a TCP server on port 9100 that
 * accepts raw ESC/POS. This stands one up, points the adapter at it, and
 * checks that the bytes a customer's receipt is made of actually arrive —
 * and, just as importantly, that a printer which is switched off costs the
 * shop a queued job rather than a sale.
 */

/** A thermal printer, near enough: it accepts bytes and remembers them. */
class FakePrinter {
  private server: net.Server | null = null;
  readonly received: Buffer[] = [];
  port = 0;

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
      socket.on("data", (chunk) => this.received.push(chunk));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  /**
   * Wait for the bytes to actually land.
   *
   * The adapter resolves once the payload is flushed to the socket, which is
   * the right moment for it — the bytes are on the wire and the printer owns
   * them from there. The receiving side gets them a tick or two later, so a
   * test that reads immediately sees nothing. Waits for the first chunk, then
   * for a short quiet period so a multi-job drain is captured whole.
   */
  async settle(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    let seen = -1;
    while (seen !== this.received.length && Date.now() < deadline) {
      seen = this.received.length;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  get text(): string {
    return receiptToPlainText(new Uint8Array(Buffer.concat(this.received)));
  }
}

let printer: FakePrinter;
let cashier: CurrentUser;
let cubesId: string;
let counter = 0;

const key = () => `print-${Date.now().toString(36)}-${counter++}`;

beforeAll(async () => {
  printer = new FakePrinter();
  await printer.start();

  const row = await db.user.findUniqueOrThrow({ where: { staffCode: "4001" } });
  cashier = { id: row.id, name: row.name, staffCode: "4001", role: "CASHIER" };
  cubesId = (await db.product.findUniqueOrThrow({ where: { sku: "BEEF-BONELESS-CUBES" } })).id;

  // Other test files ring up sales too, and every sale queues a receipt.
  // These tests assert on what came out of the printer, so they start from an
  // empty queue rather than whatever the rest of the suite left behind.
  await db.printJob.deleteMany({});
});

afterAll(async () => {
  await printer.stop();
});

function sale(idempotencyKey: string) {
  return {
    lines: [{ lineId: "l1", productId: cubesId, weightGrams: 1235, requestedAmount: 100_000 }],
    tenders: [{ method: "CASH" as const, amount: 200_000 }],
    idempotencyKey,
  };
}

/** The queue store the flush endpoint uses, against the real database. */
function store() {
  return {
    async claimNext() {
      const job = await db.printJob.findFirst({
        where: { status: { in: ["QUEUED", "FAILED"] }, attempts: { lt: MAX_PRINT_ATTEMPTS } },
        orderBy: { createdAt: "asc" },
      });
      if (!job) return null;
      await db.printJob.update({ where: { id: job.id }, data: { status: "PRINTING" } });
      return { id: job.id, kind: job.kind, payload: job.payload, attempts: job.attempts };
    },
    async markDone(id: string) {
      await db.printJob.update({
        where: { id },
        data: { status: "DONE", completedAt: new Date() },
      });
    },
    async markFailed(id: string, error: string, attempts: number) {
      await db.printJob.update({
        where: { id },
        data: { status: "FAILED", lastError: error, attempts },
      });
    },
  };
}

describe("printing a receipt over the network", () => {
  it("reports the printer as reachable", async () => {
    const adapter = new NetworkPrinter("127.0.0.1", printer.port, 80);
    const status = await adapter.status();
    expect(status.connected).toBe(true);
    expect(status.adapter).toBe("network");
  });

  it("sends a completed sale's receipt to the printer", async () => {
    await db.printJob.deleteMany({});
    const completed = await checkout(sale(key()), cashier);
    expect(completed.printJobId).not.toBe("");

    printer.received.length = 0;
    const adapter = new NetworkPrinter("127.0.0.1", printer.port, 80);
    const result = await drainPrintQueue(adapter, store());

    expect(result.printed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);

    await printer.settle();

    // The bytes that actually crossed the socket are a real receipt.
    const printed = printer.text;
    expect(printed).toContain("Newmark Butchery");
    expect(printed).toContain(completed.receiptNumber);
    expect(printed).toContain("Boneless Beef Cubes");
    expect(printed).toContain("1.235 kg @ 820.00/kg");
    expect(printed).toContain("TOTAL");
    expect(printed).toContain("CHANGE");
  });

  it("marks the job done so it does not print twice", async () => {
    const job = await db.printJob.findFirstOrThrow({
      where: { status: "DONE" },
      orderBy: { completedAt: "desc" },
    });
    expect(job.completedAt).not.toBeNull();

    const again = await drainPrintQueue(new NetworkPrinter("127.0.0.1", printer.port, 80), store());
    expect(again.printed).toBe(0);
  });

  it("ends the receipt with a cut so the customer can tear it off", async () => {
    await printer.settle();
    const raw = Buffer.concat(printer.received);
    // GS V 66 0 — feed and partial cut.
    expect(raw.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true);
  });

  it("prints a duplicate marked as one", async () => {
    const completed = await checkout(sale(key()), cashier);
    printer.received.length = 0;

    await reprintReceipt(completed.saleId, cashier);
    await drainPrintQueue(new NetworkPrinter("127.0.0.1", printer.port, 80), store());
    await printer.settle();

    const printed = printer.text;
    expect(printed).toContain("*** DUPLICATE ***");
    expect(printed).toContain(completed.receiptNumber);
  });
});

describe("when the printer is switched off", () => {
  it("still completes the sale", async () => {
    const completed = await checkout(sale(key()), cashier);
    expect(completed.receiptNumber).toMatch(/^T9-\d{6}$/);
    expect(completed.total).toBe(101_270);

    // The sale is committed and paid for, whatever the printer is doing.
    const banked = await db.sale.findUniqueOrThrow({ where: { id: completed.saleId } });
    expect(banked.status).toBe("COMPLETED");
  });

  it("leaves the receipt queued rather than losing it", async () => {
    // Port 1 is reserved and nothing listens there — a printer that is off.
    const dead = new NetworkPrinter("127.0.0.1", 1, 80, 300);
    const result = await drainPrintQueue(dead, store());

    expect(result.printed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.lastError).toBeTruthy();

    const stuck = await db.printJob.findFirst({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
    });
    expect(stuck).not.toBeNull();
    expect(stuck!.attempts).toBe(1);
    expect(stuck!.lastError).toBeTruthy();
  });

  it("prints the backlog once the printer comes back", async () => {
    const pendingBefore = await db.printJob.count({
      where: { status: { in: ["QUEUED", "FAILED"] } },
    });
    expect(pendingBefore).toBeGreaterThan(0);

    printer.received.length = 0;
    const result = await drainPrintQueue(
      new NetworkPrinter("127.0.0.1", printer.port, 80),
      store(),
      20,
    );

    expect(result.printed).toBe(pendingBefore);

    await printer.settle();
    expect(printer.text).toContain("Newmark Butchery");

    const pendingAfter = await db.printJob.count({
      where: { status: { in: ["QUEUED", "FAILED"] } },
    });
    expect(pendingAfter).toBe(0);
  });
});

describe("when no printer is configured at all", () => {
  it("drains the queue rather than letting it grow forever", async () => {
    const completed = await checkout(sale(key()), cashier);
    const result = await drainPrintQueue(new NoopPrinter(80), store());

    expect(result.printed).toBe(1);

    const job = await db.printJob.findFirstOrThrow({ where: { saleId: completed.saleId } });
    expect(job.status).toBe("DONE");
  });

  it("says it is not connected, so the till can tell the cashier the truth", async () => {
    const status = await new NoopPrinter(80).status();
    expect(status.connected).toBe(false);
    expect(status.detail).toMatch(/no printer/i);
  });

  it("keeps the rendered receipt so it can be shown on screen", async () => {
    const completed = await checkout(sale(key()), cashier);
    const text = receiptToPlainText(fromBase64(completed.receiptPayload));

    expect(text).toContain(completed.receiptNumber);
    expect(text).toContain("1.235 kg @ 820.00/kg");
    expect(text).toContain("cut to order: 1,000.00");
  });
});
