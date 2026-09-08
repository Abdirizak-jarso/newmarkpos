import { describe, expect, it } from "vitest";
import {
  columnsFor,
  receiptToPlainText,
  renderReceipt,
  telephoneLines,
  type ReceiptData,
} from "@/lib/adapters/escpos";
import { applyPayments, priceSale, type CartLineInput } from "@/lib/pricing";
import { parse as parseReceiptNumber, format as formatReceiptNumber } from "@/lib/receipt-number";
import { drainPrintQueue, NoopPrinter, type QueuedJob } from "@/lib/adapters/printer";
import { toBase64 } from "@/lib/adapters/escpos";

const shop = {
  brandLines: ["NEWMARK", "Where Quality Meets Tradition", "100% Halal Quality Meat"],
  name: "Newmark Butchery",
  addressLines: ["Bishan Plaza, Westlands", "Nairobi, Kenya"],
  phoneNumbers: ["0700 876 201", "0701 347 191"],
  kraPin: "P051234567X",
  mpesaPaybill: "600100",
  mpesaAccount: "106853",
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

/** Where a run of characters starts in the raw byte stream, or -1. */
function indexOfText(bytes: readonly number[], needle: string): number {
  const wanted = [...needle].map((c) => c.charCodeAt(0));
  return bytes.findIndex((_, i) => wanted.every((code, j) => bytes[i + j] === code));
}

describe("renderReceipt", () => {
  const text = receiptToPlainText(renderReceipt(receipt(), 80));

  it("names the shop and labels the receipt's details", () => {
    expect(text).toContain("Newmark Butchery");
    expect(text).toContain("Receipt No:    T1-000412");
    expect(text).toContain("Served By:     Cashier One");
  });

  it("identifies the terminal through the receipt number, not a Till line", () => {
    // The prefix is what stops two terminals minting the same number, so it
    // already says which till this came off. A separate line repeated it.
    expect(text).not.toContain("Till:");
    expect(text).toContain("Receipt No:    T1-000412");
  });

  it("heads the item table on one row and states the currency once", () => {
    expect(text).toMatch(/^Item\s+Qty\s+Price\s+Amount$/m);
    expect(text).toContain("All amounts in KSh");
    expect(text).not.toContain("(KSh)");
  });

  it("prints the shop's numbers on one bold Tel line", () => {
    expect(text).toContain("Tel: 0700 876 201 / 0701 347 191");
    // ESC E 1 immediately before it and ESC E 0 immediately after, so the
    // emphasis cannot bleed into the body of the receipt.
    const bytes = renderReceipt(receipt(), 80);
    const raw = Array.from(bytes);
    const tel = indexOfText(raw, "Tel: ");
    expect(raw.slice(tel - 8, tel)).toContain(0x45);
    expect(indexOfText(raw, "PIN")).toBeGreaterThan(-1);
  });

  it("drops the tagline the logo already carries, but keeps the name as text", () => {
    expect(text).not.toContain("Premium Halal Meat");
    expect(text).toContain("Newmark Butchery");
  });

  it("gives a long name its own line and keeps the figures under the headings", () => {
    // "Boneless Beef Cubes" is wider than the item column. It takes a line of
    // its own, whole, and the figures follow on the next row - still lined up
    // under Qty, Price and Amount rather than dropping into a stacked
    // "1.235 kg @ 820.00" form that no longer matches the table.
    expect(text).toMatch(/^Boneless Beef Cubes$/m);
    expect(text).toMatch(/^\s+1\.235 kg\s+820\.00\s+1,012\.70$/m);
  });

  it("keeps a carcass weight in the table instead of dropping out of it", () => {
    // 299.000 kg is ten characters. At a nine-wide Qty column the whole line
    // fell out of the table and printed as "299.000 kg @ 11.00".
    const carcass = receipt();
    const text = receiptToPlainText(
      renderReceipt(
        {
          ...carcass,
          totals: priceSale(
            [
              {
                lineId: "a",
                productId: "p1",
                sku: "LMB-LEG-NB",
                name: "Lamb Leg Netted Boneless",
                pricingMode: "PER_KG",
                unitPrice: 11_00,
                weightGrams: 299_000,
                taxClass: "EXEMPT",
              },
            ],
            { standardVatRatePercent: 16, cashRoundingStep: 0 },
          ),
        },
        80,
      ),
    );
    expect(text).toMatch(/^\s+299\.000 kg\s+11\.00\s+3,289\.00$/m);
    expect(text).not.toContain("@");
  });

  it("shows a per-piece line as a count", () => {
    expect(text).toMatch(/Whole Chicken\s+2 ea\s+750\.00\s+1,500\.00/);
  });

  it("records that a line was cut to a shilling target", () => {
    expect(text).toContain("cut to order: 1,000.00");
  });

  it("totals the sale under the money column", () => {
    expect(text).toMatch(/Subtotal\s+2,512\.70/);
    expect(text).toMatch(/Total\s+2,512\.70/);
  });

  it("prints no tender line under the total", () => {
    // Settled in one payment, that row was the Total over again with a method
    // beside it. The amount is not repeated under PAYMENT DETAILS either.
    expect(text).not.toMatch(/MPESA\s+2,000\.00/);
    expect(text).not.toMatch(/CASH\s+600\.00/);
    expect(text).not.toContain("AMOUNT PAID");
  });

  it("still prints the change, which is a different figure", () => {
    expect(text).toMatch(/Change\s+87\.30/);
  });

  it("prints no total weight line", () => {
    // Every line already carries its own weight in the Qty column; the total
    // was a kilo figure sitting in a receipt otherwise made of shillings.
    expect(text).not.toContain("Total Weight");
    expect(text).toMatch(/1\.235 kg/);
  });

  it("prints the paybill, the account and the code as reference", () => {
    // What a customer or the shop quotes when a payment has to be traced
    // against Safaricom. None of them may go missing.
    expect(text).toContain("PAYMENT DETAILS");
    expect(text).toMatch(/M-PESA PAYBILL:\s+600100/);
    expect(text).toMatch(/ACCOUNT NUMBER:\s+106853/);
    expect(text).toMatch(/M-PESA CODE:\s+SJH4K2L9XZ/);
  });

  it("confirms an M-Pesa payment once there is a code to check it by", () => {
    expect(text).toContain("MPESA Payment Confirmed");
    expect(text).not.toContain("code to follow");
  });

  it("prints the footer in full, ahead of the feed and the cut", () => {
    // The last thing on the paper must be the footer, then the feed, then the
    // cut - never a status line the cut lands in the middle of.
    const raw = Array.from(renderReceipt(receipt(), 80));
    const lastFooter = indexOfText(raw, "newmarkprimemeat.com");
    expect(lastFooter).toBeGreaterThan(indexOfText(raw, "MPESA Payment Confirmed"));
    expect(raw.slice(lastFooter)).toContain(0x64); // ESC d - feed
    expect(raw.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00]); // GS V B 0 - cut
    expect(text.trimEnd().endsWith("newmarkprimemeat.com")).toBe(true);
  });

  it("centres the shop and the footer so the screen copy reads like the paper", () => {
    // ESC a 1 is stripped out of the on-screen copy, so centring has to be
    // real spaces or the address lands hard against the left margin there.
    const centred = (needle: string) =>
      text.split("\n").some((line) => line.trim() === needle && line.startsWith("  "));
    expect(centred("Newmark Butchery")).toBe(true);
    expect(centred("Bishan Plaza, Westlands")).toBe(true);
    expect(centred("newmarkprimemeat.com")).toBe(true);
  });

  it("claims nothing about a payment banked before its code arrived", () => {
    // The paybill and account still print, so the customer can trace it. What
    // is not printed is a confirmation the shop cannot yet stand behind.
    const uncoded = receipt();
    const bare = receiptToPlainText(
      renderReceipt(
        { ...uncoded, tenders: [{ method: "MPESA", amount: uncoded.totals.total }] },
        80,
      ),
    );
    expect(bare).not.toContain("code to follow");
    expect(bare).not.toContain("Confirmed");
    expect(bare).toMatch(/M-PESA PAYBILL:\s+600100/);
  });

  it("omits the payment heading when there is nothing left to head", () => {
    const uncoded = receipt();
    const bare = receiptToPlainText(
      renderReceipt(
        {
          ...uncoded,
          shop: { ...shop, mpesaPaybill: "", mpesaAccount: "" },
          tenders: [{ method: "MPESA", amount: uncoded.totals.total }],
        },
        80,
      ),
    );
    expect(bare).not.toContain("PAYMENT DETAILS");
    expect(bare).not.toContain("Confirmed");
  });

  it("prints the change", () => {
    // 1,012.70 + 1,500.00 = 2,512.70 paid with 2,600.00 -> 87.30 change
    expect(text).toContain("Change");
    expect(text).toContain("87.30");
  });

  it("prints no VAT breakdown, but still computes and carries the figures", () => {
    // The paper no longer shows it. The sale still does: the buckets are what
    // the VAT return and the eTIMS invoice are built from, so they have to
    // survive whatever the receipt chooses to print.
    expect(text).not.toContain("VAT");
    expect(text).not.toContain("Zero rated");

    const totals = receipt().totals;
    expect(totals.tax).toBe(206_90);
    expect(totals.taxBuckets.find((b) => b.taxClass === "STANDARD")?.tax).toBe(206_90);
    expect(totals.taxBuckets.find((b) => b.taxClass === "EXEMPT")?.tax).toBe(0);
  });

  it("starts with the shop name, not a stray control byte", () => {
    // ESC @ takes no argument; decoding it as three bytes used to leave the
    // 'a' of the following ESC a printing at the top of the preview.
    expect(text.trimStart().startsWith("NEWMARK")).toBe(true);
  });

  it("keeps everything about the sale below the first rule", () => {
    // The on-screen receipt replaces the block above that rule with the shop's
    // logo. Anything belonging to the sale printed up there would be swapped
    // out with it and never reach the customer's eye.
    const masthead = text.slice(0, text.indexOf("\n----"));
    for (const belongsToTheSale of [
      "T1-000412",
      "Cashier One",
      "Boneless Beef Cubes",
      "2,512.70",
      "SJH4K2L9XZ",
    ]) {
      expect(masthead).not.toContain(belongsToTheSale);
    }
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

describe("telephone line", () => {
  it("joins the shop's numbers with a slash on one line", () => {
    expect(telephoneLines(["0700 876 201", "0701 347 191"], 42)).toEqual([
      "Tel: 0700 876 201 / 0701 347 191",
    ]);
  });

  it("wraps rather than running off the edge of the paper", () => {
    // A third number is a settings change, not a layout one - and on 58mm
    // paper it does not fit, so it has to break instead of overflowing.
    for (const cols of [42, 32]) {
      for (const count of [1, 2, 3, 4, 5]) {
        const numbers = Array.from({ length: count }, (_, i) => `07${i}0 876 201`);
        const lines = telephoneLines(numbers, cols);
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(cols);
        // Every number still reaches the paper.
        for (const number of numbers) expect(lines.join(" ")).toContain(number);
      }
    }
  });

  it("says nothing at all when the shop has listed no number", () => {
    expect(telephoneLines([], 42)).toEqual([]);
    expect(telephoneLines(["", "   "], 42)).toEqual([]);
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
