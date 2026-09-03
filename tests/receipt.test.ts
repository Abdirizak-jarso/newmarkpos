import { describe, expect, it } from "vitest";
import { columnsFor, receiptToPlainText, renderReceipt, type ReceiptData } from "@/lib/adapters/escpos";
import { applyPayments, priceSale, type CartLineInput } from "@/lib/pricing";
import { parse as parseReceiptNumber, format as formatReceiptNumber } from "@/lib/receipt-number";
import { drainPrintQueue, NoopPrinter, type QueuedJob } from "@/lib/adapters/printer";
import { toBase64 } from "@/lib/adapters/escpos";

const shop = {
  name: "Newmark Butchery",
  tagline: "Premium Halal Meat",
  addressLines: ["Bishan Plaza, Westlands", "Nairobi, Kenya"],
  phone: "0700000000",
  kraPin: "P051234567X",
  footerLines: ["Thank you for shopping with us", "newmarkprimemeat.com"],
};

function basket(): CartLineInput[] {
  return [
    {
      lineId: "a",
      productId: "p1",
      sku: "BEEF-BONELESS-CUBES",
      name: "Boneless Beef Cubes",
      pricingMode: "PER_KG",
      unitPrice: 820_00,
      weightGrams: 1235,
      taxClass: "EXEMPT",
      requestedAmount: 1_000_00,
    },
    {
      lineId: "b",
      productId: "p2",
      sku: "CH-001",
      name: "Whole Chicken",
      pricingMode: "PER_PIECE",
      unitPrice: 750_00,
      quantity: 2,
      unitWeightGrams: 1400,
      taxClass: "STANDARD",
    },
  ];
}

function receipt(): ReceiptData {
  const totals = priceSale(basket(), { standardVatRatePercent: 16, cashRoundingStep: 0 });
  const tenders = [
    { method: "MPESA" as const, amount: 2_000_00, reference: "SJH4K2L9XZ" },
    { method: "CASH" as const, amount: 600_00 },
  ];
  const payment = applyPayments(totals, tenders);

  return {
    shop,
    receiptNumber: "T1-000412",
    terminalId: "T1",
    cashier: "Cashier One",
    at: new Date("2026-09-02T10:30:00"),
    totals,
    tenders,
    changeDue: payment.changeDue,
  };
}

describe("renderReceipt", () => {
  const text = receiptToPlainText(renderReceipt(receipt(), 80));

  it("names the shop and the receipt", () => {
    expect(text).toContain("Newmark Butchery");
    expect(text).toContain("T1-000412");
    expect(text).toContain("Cashier One");
  });

  it("shows a weighed line to three decimals with its price per kg", () => {
    expect(text).toContain("1.235 kg @ 820.00/kg");
  });

  it("shows a per-piece line as a count", () => {
    expect(text).toContain("2 @ 750.00 ea");
  });

  it("records that a line was cut to a shilling target", () => {
    expect(text).toContain("cut to order: 1,000.00");
  });

  it("shows each tender, including the M-Pesa code", () => {
    expect(text).toContain("MPESA SJH4K2L9XZ");
    expect(text).toContain("CASH");
  });

  it("prints the change", () => {
    // 1,012.70 + 1,500.00 = 2,512.70 paid with 2,600.00 -> 87.30 change
    expect(text).toContain("CHANGE");
    expect(text).toContain("87.30");
  });

  it("breaks VAT out by treatment rather than as one figure", () => {
    expect(text).toContain("VAT @ 16%");
    expect(text).toContain("VAT exempt");
  });

  it("starts with the shop name, not a stray control byte", () => {
    // ESC @ takes no argument; decoding it as three bytes used to leave the
    // 'a' of the following ESC a printing at the top of the preview.
    expect(text.startsWith("Newmark Butchery")).toBe(true);
  });

  it("leaves no control characters in the preview", () => {
    expect(/[\x00-\x09\x0b-\x1f]/.test(text)).toBe(false);
  });

  it("fits the paper width", () => {
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(columnsFor(80));
    }
  });

  it("fits 58mm paper too", () => {
    const narrow = receiptToPlainText(renderReceipt(receipt(), 58));
    for (const line of narrow.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(columnsFor(58));
    }
  });
});

describe("receipt numbers", () => {
  it("carries a terminal prefix so offline tills cannot collide", () => {
    expect(formatReceiptNumber("T1", 412)).toBe("T1-000412");
    expect(formatReceiptNumber("T2", 412)).toBe("T2-000412");
    expect(formatReceiptNumber("T1", 412)).not.toBe(formatReceiptNumber("T2", 412));
  });

  it("round-trips", () => {
    expect(parseReceiptNumber("T1-000412")).toEqual({ prefix: "T1", number: 412 });
    expect(parseReceiptNumber("nonsense")).toBeNull();
  });
});

describe("print queue", () => {
  it("drains queued jobs", async () => {
    const jobs: QueuedJob[] = [
      { id: "1", kind: "RECEIPT", payload: toBase64(new Uint8Array([1, 2, 3])), attempts: 0 },
      { id: "2", kind: "RECEIPT", payload: toBase64(new Uint8Array([4, 5, 6])), attempts: 0 },
    ];
    const done: string[] = [];

    const result = await drainPrintQueue(new NoopPrinter(), {
      async claimNext() {
        return jobs.shift() ?? null;
      },
      async markDone(id) {
        done.push(id);
      },
      async markFailed() {
        throw new Error("should not fail against a noop printer");
      },
    });

    expect(result.printed).toBe(2);
    expect(done).toEqual(["1", "2"]);
  });

  it("stops on a dead printer instead of burning every job's retries", async () => {
    const failing = {
      name: "dead",
      paperWidth: 80 as const,
      async status() {
        return { connected: false, adapter: "dead", paperWidth: 80 as const };
      },
      async print() {
        return { ok: false, adapter: "dead", error: "Printer is switched off", at: new Date() };
      },
      async openDrawer() {
        return { ok: false, adapter: "dead", at: new Date() };
      },
    };

    let served = 0;
    const failed: string[] = [];

    const result = await drainPrintQueue(failing, {
      async claimNext() {
        served += 1;
        return served > 5 ? null : { id: String(served), kind: "RECEIPT", payload: "", attempts: 0 };
      },
      async markDone() {},
      async markFailed(id) {
        failed.push(id);
      },
    });

    expect(result.printed).toBe(0);
    // One attempt, then it gives up on the printer rather than the queue.
    expect(failed).toEqual(["1"]);
    expect(result.lastError).toBe("Printer is switched off");
  });
});
