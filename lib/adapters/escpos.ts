/**
 * ESC/POS receipt rendering.
 *
 * Target is an 80 mm thermal printer (42 columns at Font A); 58 mm is
 * supported by a width setting (32 columns). Everything here is pure byte
 * assembly — no printer, no I/O — so a receipt can be rendered and asserted on
 * in a unit test, and so a printer failure can never happen inside this code.
 */

import { formatCents, type Cents } from "../money";
import { formatKg } from "../weight";
import type { CartLine, SaleTotals, TaxBucket, Tender } from "../pricing";

const ESC = 0x1b;
const GS = 0x1d;

export type PaperWidth = 58 | 80;

export function columnsFor(width: PaperWidth): number {
  return width === 58 ? 32 : 42;
}

export interface ShopDetails {
  name: string;
  tagline?: string;
  addressLines: string[];
  phone?: string;
  kraPin?: string;
  vatNumber?: string;
  footerLines: string[];
}

export interface ReceiptData {
  shop: ShopDetails;
  receiptNumber: string;
  terminalId: string;
  cashier: string;
  at: Date;
  totals: SaleTotals;
  tenders: readonly Tender[];
  changeDue: Cents;
  customerName?: string;
  customerPin?: string;
  /** eTIMS control unit details, when the invoice has been accepted. */
  taxInvoiceNumber?: string;
  taxSignature?: string;
  /** DUPLICATE / REPRINT banner. */
  copyLabel?: string;
}

class Builder {
  private readonly parts: number[] = [];

  constructor(private readonly cols: number) {}

  raw(...bytes: number[]): this {
    this.parts.push(...bytes);
    return this;
  }

  text(value: string): this {
    // The printer's code page is single-byte; strip anything it cannot render
    // rather than emitting mojibake in the middle of a customer's total.
    for (const char of value.replace(/[^\x20-\x7e\n]/g, "")) {
      this.parts.push(char.charCodeAt(0));
    }
    return this;
  }

  line(value = ""): this {
    return this.text(value).raw(0x0a);
  }

  init(): this {
    return this.raw(ESC, 0x40);
  }

  align(mode: "left" | "center" | "right"): this {
    return this.raw(ESC, 0x61, mode === "left" ? 0 : mode === "center" ? 1 : 2);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  doubleHeight(on: boolean): this {
    return this.raw(GS, 0x21, on ? 0x01 : 0x00);
  }

  rule(char = "-"): this {
    return this.line(char.repeat(this.cols));
  }

  /** label on the left, value flush right, on one line. */
  pair(label: string, value: string): this {
    const room = this.cols - value.length;
    const left = label.length > room ? label.slice(0, Math.max(0, room - 1)) : label;
    const gap = Math.max(1, this.cols - left.length - value.length);
    return this.line(left + " ".repeat(gap) + value);
  }

  /** Wrap a long product name rather than truncating it off the receipt. */
  wrapped(value: string, indent = 0): this {
    const width = this.cols - indent;
    const words = value.split(/\s+/);
    let current = "";
    for (const word of words) {
      if (current === "") current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        this.line(" ".repeat(indent) + current);
        current = word;
      }
    }
    if (current !== "") this.line(" ".repeat(indent) + current);
    return this;
  }

  feed(lines = 4): this {
    return this.raw(ESC, 0x64, lines);
  }

  cut(): this {
    return this.raw(GS, 0x56, 0x42, 0x00);
  }

  openDrawer(): this {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  /** QR code for the KRA eTIMS verification URL. */
  qr(data: string): this {
    if (data === "") return this;
    const bytes = [...data].map((c) => c.charCodeAt(0));
    const len = bytes.length + 3;
    return this.raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00) // model 2
      .raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06) // module size
      .raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31) // error correction L
      .raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...bytes)
      .raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print
  }

  build(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function lineQuantityText(line: CartLine): string {
  switch (line.pricingMode) {
    case "PER_KG":
      return `${formatKg(line.weightGrams)} kg @ ${formatCents(line.unitPrice)}/kg`;
    case "PER_PIECE":
      return `${line.quantity} @ ${formatCents(line.unitPrice)} ea`;
    case "FIXED_PACK":
      return `${line.quantity} pack @ ${formatCents(line.unitPrice)}`;
  }
}

function taxClassLabel(bucket: TaxBucket): string {
  switch (bucket.taxClass) {
    case "EXEMPT":
      return "VAT exempt";
    case "ZERO_RATED":
      return "Zero rated";
    case "STANDARD":
      return `VAT @ ${bucket.ratePercent}%`;
  }
}

function formatDateTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

export function renderReceipt(data: ReceiptData, width: PaperWidth = 80): Uint8Array {
  const cols = columnsFor(width);
  const b = new Builder(cols);
  const { shop, totals } = data;

  b.init().align("center").bold(true).doubleHeight(true).line(shop.name).doubleHeight(false);
  if (shop.tagline) b.line(shop.tagline);
  b.bold(false);
  for (const addressLine of shop.addressLines) b.line(addressLine);
  if (shop.phone) b.line(`Tel ${shop.phone}`);
  if (shop.kraPin) b.line(`PIN ${shop.kraPin}`);

  if (data.copyLabel) {
    b.line();
    b.bold(true).line(`*** ${data.copyLabel.toUpperCase()} ***`).bold(false);
  }

  b.align("left").rule();
  b.pair(`Receipt ${data.receiptNumber}`, formatDateTime(data.at));
  b.pair(`Served by ${data.cashier}`, `Till ${data.terminalId}`);
  if (data.customerName) b.line(`Customer: ${data.customerName}`);
  if (data.customerPin) b.line(`Customer PIN: ${data.customerPin}`);
  b.rule();

  for (const line of totals.lines) {
    b.wrapped(line.name);
    b.pair(`  ${lineQuantityText(line)}`, formatCents(line.gross));
    if (line.discount > 0) b.pair("  Discount", `-${formatCents(line.discount)}`);
    if (line.requestedAmount !== undefined) {
      b.line(`  (cut to order: ${formatCents(line.requestedAmount)})`);
    }
    if (line.notes) b.wrapped(`  ${line.notes}`, 2);
  }

  b.rule();
  b.pair("Subtotal", formatCents(totals.gross));
  if (totals.discount > 0) b.pair("Discount", `-${formatCents(totals.discount)}`);
  if (totals.roundingAdjustment !== 0) {
    b.pair("Cash rounding", formatCents(totals.roundingAdjustment));
  }
  b.bold(true).doubleHeight(true).pair("TOTAL", formatCents(totals.total)).doubleHeight(false).bold(false);
  b.pair("Total weight", `${formatKg(totals.totalWeightGrams)} kg`);

  b.rule();
  for (const tender of data.tenders) {
    const label = tender.reference ? `${tender.method} ${tender.reference}` : tender.method;
    b.pair(label, formatCents(tender.amount));
    // The M-Pesa time goes on the receipt because that, with the code, is what
    // the shop matches against Safaricom's statement when a payment is queried.
    if (tender.transactedAt) {
      b.line(`  paid ${formatDateTime(new Date(tender.transactedAt))}`);
    }
  }
  if (data.changeDue > 0) b.bold(true).pair("CHANGE", formatCents(data.changeDue)).bold(false);

  const taxable = totals.taxBuckets.filter((bucket) => bucket.net !== 0);
  if (taxable.length > 0) {
    b.rule();
    for (const bucket of taxable) {
      b.pair(`${taxClassLabel(bucket)} on ${formatCents(bucket.net)}`, formatCents(bucket.tax));
    }
    b.pair("Total VAT", formatCents(totals.tax));
  }

  if (data.taxInvoiceNumber) {
    b.rule().align("center");
    b.line(`eTIMS Invoice ${data.taxInvoiceNumber}`);
    if (data.taxSignature) {
      b.line(data.taxSignature);
      b.qr(data.taxSignature);
    }
    b.align("left");
  }

  b.rule().align("center");
  for (const footer of shop.footerLines) b.line(footer);
  b.feed(4).cut();

  return b.build();
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(payload: string): Uint8Array {
  return new Uint8Array(Buffer.from(payload, "base64"));
}

/** Plain-text rendering of the same receipt, for the on-screen preview. */
export function receiptToPlainText(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    if (byte === ESC || byte === GS) {
      // Skip the escape sequence rather than printing its bytes as characters.
      i += escapeLength(bytes, i);
      continue;
    }
    out.push(String.fromCharCode(byte));
    i += 1;
  }
  return out.join("");
}

function escapeLength(bytes: Uint8Array, at: number): number {
  const cmd = bytes[at + 1];

  // ESC @ (initialise) takes no argument. Treating it as three bytes swallows
  // the start of the next command and leaves its argument printing as a
  // stray character at the top of the preview.
  if (bytes[at] === ESC && cmd === 0x40) return 2;

  if (bytes[at] === GS && cmd === 0x28) {
    const len = (bytes[at + 3] ?? 0) | ((bytes[at + 4] ?? 0) << 8);
    return 5 + len;
  }
  if (bytes[at] === GS && cmd === 0x56) return 4; // GS V m n — cut
  if (bytes[at] === ESC && cmd === 0x70) return 5; // ESC p m t1 t2 — drawer

  // ESC a / ESC E / ESC d and GS ! all take a single argument byte.
  return 3;
}
