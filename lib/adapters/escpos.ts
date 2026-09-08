/**
 * ESC/POS receipt rendering.
 *
 * Target is an 80 mm thermal printer (42 columns at Font A); 58 mm is
 * supported by a width setting (32 columns). Everything here is pure byte
 * assembly - no printer, no I/O - so a receipt can be rendered and asserted on
 * in a unit test, and so a printer failure can never happen inside this code.
 */

import { formatCents, type Cents } from "../money";
import { formatKg } from "../weight";
import type { CartLine, SaleTotals, Tender } from "../pricing";

const ESC = 0x1b;
const GS = 0x1d;

export type PaperWidth = 58 | 80;

export function columnsFor(width: PaperWidth): number {
  return width === 58 ? 32 : 42;
}

export interface ShopDetails {
  /**
   * The logo's own words, for the paper the logo cannot reach.
   *
   * A thermal head prints characters, not artwork, so on the roll this is the
   * masthead. On screen and in a browser print the logo image takes its place
   * - same words, drawn properly. Keep the two saying the same thing.
   */
  brandLines: string[];
  name: string;
  addressLines: string[];
  /**
   * Every number the shop answers, joined onto one Tel line. A list rather
   * than a string so a third number is a settings change, not a layout one.
   */
  phoneNumbers?: string[];
  kraPin?: string;
  vatNumber?: string;
  /** M-Pesa paybill and account, printed so a customer can pay or query. */
  mpesaPaybill?: string;
  mpesaAccount?: string;
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

  /**
   * Centred with real spaces, not with `ESC a 1`.
   *
   * The on-screen receipt is the same bytes with the escape sequences
   * stripped, so a line the printer would centre arrives on screen hard
   * against the left margin. Padding centres it in both places at once. Safe
   * with double-height text, which is taller but not wider.
   */
  centred(value: string): this {
    const text = value.length > this.cols ? value.slice(0, this.cols) : value;
    return this.line(" ".repeat(Math.floor((this.cols - text.length) / 2)) + text);
  }

  /**
   * A row of fixed-width cells: the first flush left, the rest flush right in
   * their own column. Right-aligning the numeric columns is what makes a
   * receipt's shillings line up on the decimal point instead of drifting with
   * the length of the cut's name above them.
   */
  cells(values: readonly string[], widths: readonly number[]): this {
    let out = "";
    values.forEach((value, i) => {
      const width = widths[i] ?? 0;
      const text = value.length > width ? value.slice(0, width) : value;
      out += i === 0 ? text.padEnd(width) : text.padStart(width);
    });
    return this.line(out.trimEnd());
  }

  /**
   * A totals line: label and figure together in the right-hand third, under
   * the money column they are summing rather than out at the paper's edge.
   */
  totalRow(label: string, value: string): this {
    const valueWidth = 12;
    const labelWidth = 16;
    const indent = Math.max(0, this.cols - labelWidth - valueWidth);
    return this.line(
      " ".repeat(indent) + label.padEnd(labelWidth).slice(0, labelWidth) + value.padStart(valueWidth),
    );
  }

  /** `Label:` in a fixed gutter with its value beside it, as a form reads. */
  field(label: string, value: string): this {
    return this.line((label.padEnd(FIELD_LABEL_WIDTH) + value).slice(0, this.cols));
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

const FIELD_LABEL_WIDTH = 15;

/**
 * The shop's numbers on one line, or as many lines as they need.
 *
 * Two numbers and the `Tel:` label come to 32 characters, which fits both the
 * 80 mm roll and the 58 mm one. A third would not, so this breaks on the
 * separator rather than running off the edge of the paper - the trailing
 * slash is kept on the broken line so the reader can see the list continues.
 */
export function telephoneLines(numbers: readonly string[], cols: number): string[] {
  const listed = numbers.map((number) => number.trim()).filter(Boolean);
  if (listed.length === 0) return [];

  const lines: string[] = [];
  let current = `Tel: ${listed[0]}`;

  for (let i = 1; i < listed.length; i += 1) {
    const number = listed[i]!;
    const candidate = `${current} / ${number}`;
    // A line that will be continued has to carry the trailing " /", so it
    // needs two characters more room than one that ends the list. Checking
    // against the full width and appending the slash afterwards is what put
    // the 58 mm line two characters over the edge of the paper.
    const room = i === listed.length - 1 ? cols : cols - 2;

    if (candidate.length <= room) {
      current = candidate;
    } else {
      lines.push(`${current} /`);
      current = number;
    }
  }

  lines.push(current);
  return lines;
}

/**
 * The item table's column widths, or null on paper too narrow to hold one.
 *
 * 80 mm gives 42 columns and the table fits with 13 left for the cut's name.
 * 58 mm gives 32, which would leave three - so a narrow till falls back to the
 * stacked layout, name on its own line with the figures beneath it. Better a
 * different shape on the small paper than a column of truncated names.
 */
function itemColumns(cols: number): number[] | null {
  // One header row, so the widest header is `Amount` at six characters and
  // every column is sized by its figures instead. Qty holds ten because a
  // carcass line is `299.000 kg` - at nine it fell out of the table and into
  // the stacked form, which is the shape this table exists to avoid.
  const qty = 10;
  const price = 9;
  const amount = 9;
  const name = cols - qty - price - amount;
  return name >= 12 ? [name, qty, price, amount] : null;
}

/**
 * The same table, for the row that carries only figures.
 *
 * When the cut's name has taken a line of its own, the name cell beneath it is
 * empty - so its width is given to Qty rather than left as whitespace. Price
 * and Amount stay in their own columns, under the headings they belong to,
 * which is the whole point of having a table.
 */
function figureColumns(columns: readonly number[]): number[] {
  return [0, columns[0]! + columns[1]!, columns[2]!, columns[3]!];
}

/** Does every figure fit its column, or does this line need the stacked form? */
function fitsColumns(values: readonly string[], widths: readonly number[]): boolean {
  return values.every((value, i) => value.length <= (widths[i] ?? 0));
}

/** What the customer is being charged for: weight, pieces or packs. */
function lineQuantityText(line: CartLine): string {
  switch (line.pricingMode) {
    case "PER_KG":
      return `${formatKg(line.weightGrams)} kg`;
    case "PER_PIECE":
      return `${line.quantity} ea`;
    case "FIXED_PACK":
      return `${line.quantity} pack`;
  }
}

/** The rate that quantity was charged at - per kg, each, or per pack. */
function lineUnitText(line: CartLine): string {
  return formatCents(line.unitPrice);
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
  const columns = itemColumns(cols);

  // --- masthead -------------------------------------------------------------
  // Everything above the FIRST rule is the logo and nothing else. The
  // on-screen receipt swaps this whole block for the artwork by splitting the
  // text on that rule, so nothing belonging to the sale - or to the shop's
  // address - may be printed up here, or it vanishes from the screen copy.
  b.init().bold(true);
  const [brandName, ...brandTaglines] = shop.brandLines;
  b.doubleHeight(true).centred(brandName ?? shop.name).doubleHeight(false);
  for (const tagline of brandTaglines) b.centred(tagline);
  b.bold(false).rule();

  /*
   * The shop, centred under the logo.
   *
   * The name is printed as TEXT and not left to the logo bitmap alone: a
   * thermal head that cannot raster the artwork, or a receipt re-rendered as
   * plain text, must still say whose shop this is. The halal and quality
   * taglines are not repeated here - the logo carries them, and a till roll
   * has no room for a line that says nothing new.
   */
  b.bold(true).centred(shop.name).bold(false);
  for (const addressLine of shop.addressLines) b.centred(addressLine);
  // Heavier stroke than the address above it, and emphasis off immediately so
  // it cannot bleed into the body of the receipt.
  const telephone = telephoneLines(shop.phoneNumbers ?? [], cols);
  if (telephone.length > 0) {
    b.bold(true);
    for (const telLine of telephone) b.centred(telLine);
    b.bold(false);
  }
  if (shop.kraPin) b.centred(`PIN ${shop.kraPin}`);
  if (data.copyLabel) {
    b.bold(true).centred(`*** ${data.copyLabel.toUpperCase()} ***`).bold(false);
  }
  b.rule();

  // --- who served it, when, on which till -----------------------------------
  b.field("Receipt No:", data.receiptNumber);
  b.field("Date & Time:", formatDateTime(data.at));
  // No Till line. The terminal is already on the receipt: it is the prefix of
  // the receipt number above (T1-000028), which is exactly what keeps two
  // terminals from ever minting the same one.
  b.field("Served By:", data.cashier);
  if (data.customerName) b.field("Customer:", data.customerName);
  if (data.customerPin) b.field("Customer PIN:", data.customerPin);
  b.rule();

  // --- the goods ------------------------------------------------------------
  if (columns) {
    b.cells(["Item", "Qty", "Price", "Amount"], columns);
    b.rule();
    b.line("All amounts in KSh");
  }

  for (const line of totals.lines) {
    const qty = lineQuantityText(line);
    const unit = lineUnitText(line);
    const amount = formatCents(line.gross);

    if (columns && fitsColumns([line.name, qty, unit, amount], columns)) {
      // Everything fits: name and figures on one row.
      b.cells([line.name, qty, unit, amount], columns);
    } else if (columns && fitsColumns(["", "", unit, amount], columns)) {
      // The name is wider than its column - most butchery cuts are. It takes
      // the full width of the paper on its own line, whole and unabbreviated,
      // and the figures follow on the next row, still under their headings.
      // Cutting the name into the column instead left three ragged pieces of
      // "Lamb Leg Netted Boneless" stacked down the receipt.
      b.wrapped(line.name);
      b.cells(["", qty, unit, amount], figureColumns(columns));
    } else {
      // Figures too wide for the table itself. Nothing a butchery sells gets
      // here, but a truncated total would be a receipt nobody can check.
      b.wrapped(line.name);
      b.pair(`  ${qty} @ ${unit}`, amount);
    }

    if (line.discount > 0) b.pair("  Discount", `-${formatCents(line.discount)}`);
    if (line.requestedAmount !== undefined) {
      b.line(`  (cut to order: ${formatCents(line.requestedAmount)})`);
    }
    if (line.notes) b.wrapped(`  ${line.notes}`, 2);
  }

  b.rule();

  // --- what it came to ------------------------------------------------------
  b.totalRow("Subtotal", formatCents(totals.gross));
  if (totals.discount > 0) b.totalRow("Discount", `-${formatCents(totals.discount)}`);
  if (totals.roundingAdjustment !== 0) {
    b.totalRow("Cash rounding", formatCents(totals.roundingAdjustment));
  }
  b.bold(true).totalRow("Total", formatCents(totals.total)).bold(false);
  // No tender line under the Total. On a sale settled in one payment it was
  // the Total again with a method beside it, and a customer reading two
  // identical figures in a column looks for the difference between them.
  // Change stays: that is a different figure and the one being handed back.
  if (data.changeDue > 0) b.bold(true).totalRow("Change", formatCents(data.changeDue)).bold(false);


  // --- how it was paid ------------------------------------------------------
  // The paybill and the code are what the shop and the customer both quote
  // when a payment has to be traced against Safaricom's statement, so they go
  // on the paper rather than only into the database.
  const mpesa = data.tenders.filter((tender) => tender.method === "MPESA");
  const details: [string, string][] = [];
  if (shop.mpesaPaybill) details.push(["M-PESA PAYBILL:", shop.mpesaPaybill]);
  if (shop.mpesaAccount) details.push(["ACCOUNT NUMBER:", shop.mpesaAccount]);
  for (const tender of mpesa) {
    if (tender.reference) details.push(["M-PESA CODE:", tender.reference]);
    if (tender.transactedAt) {
      details.push(["PAID AT:", formatDateTime(new Date(tender.transactedAt))]);
    }
  }

  const showPaymentDetails = mpesa.length > 0;
  if (showPaymentDetails) {
    b.rule();
    // The amount paid is in the totals block, under the Total it settles, and
    // is not repeated here. So with no paybill configured and no code captured
    // there is genuinely nothing to list, and a heading over nothing is worse
    // than no heading: the section becomes just the status line.
    if (details.length > 0) {
      b.bold(true).line("PAYMENT DETAILS").bold(false).line();
      for (const [label, value] of details) b.pair(label, value);
    }
    // Confirmed only once there is a code to check it by. A sale banked before
    // the code arrives says nothing here, rather than promising the customer a
    // confirmation the shop cannot yet stand behind. That sale is on the
    // cashier's list to clear either way, which is where it belongs - on the
    // till, not on the customer's copy.
    if (mpesa.some((tender) => tender.reference)) {
      b.line().line("MPESA Payment Confirmed");
    }
  }

  /*
   * No VAT breakdown on the customer's copy.
   *
   * The figures are still computed and still stored on the sale - the tax
   * buckets go into `Sale.taxBreakdown`, and the VAT return and the eTIMS
   * invoice are built from those, not from what the paper says. This only
   * stops them being printed.
   *
   * Worth knowing before eTIMS goes live: a receipt that charged VAT and does
   * not show it is not a valid tax invoice. Every product is seeded EXEMPT
   * today, so every line here read "0.00" and said nothing - but the moment a
   * category is marked STANDARD, that stops being true.
   */

  if (data.taxInvoiceNumber) {
    b.rule();
    b.centred(`eTIMS Invoice ${data.taxInvoiceNumber}`);
    if (data.taxSignature) {
      b.centred(data.taxSignature);
      b.align("center").qr(data.taxSignature).align("left");
    }
  }

  b.rule();
  for (const footer of shop.footerLines) b.centred(footer);
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
  if (bytes[at] === GS && cmd === 0x56) return 4; // GS V m n - cut
  if (bytes[at] === ESC && cmd === 0x70) return 5; // ESC p m t1 t2 - drawer

  // ESC a / ESC E / ESC d and GS ! all take a single argument byte.
  return 3;
}
