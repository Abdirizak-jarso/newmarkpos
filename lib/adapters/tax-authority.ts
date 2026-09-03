/**
 * KRA eTIMS.
 *
 * All tax-authority interaction goes through TaxAuthorityAdapter. The no-op
 * implementation must keep the shop trading: if eTIMS is down, unreachable, or
 * not yet onboarded, the sale still completes, the receipt still prints, and
 * the invoice sits in the queue marked PENDING until it can be submitted.
 *
 * Submission is therefore always asynchronous and always retryable. Nothing in
 * the checkout path awaits a response from KRA.
 */

import type { SaleTotals } from "../pricing";
import { formatCents } from "../money";
import { formatKg } from "../weight";

export interface TaxInvoiceRequest {
  saleId: string;
  receiptNumber: string;
  at: Date;
  totals: SaleTotals;
  customerName?: string;
  /** Customer KRA PIN, when they have asked for a tax invoice. */
  customerPin?: string;
  /** True when this reverses an earlier invoice. */
  isCreditNote?: boolean;
  originalInvoiceNumber?: string;
}

export interface TaxInvoiceResult {
  status: "ACCEPTED" | "REJECTED" | "PENDING" | "NOT_APPLICABLE";
  invoiceNumber?: string;
  /** Control unit signature, printed on the receipt and encoded in the QR. */
  signature?: string;
  qrUrl?: string;
  error?: string;
}

export interface TaxAuthorityAdapter {
  readonly name: string;
  readonly enabled: boolean;
  submit(request: TaxInvoiceRequest): Promise<TaxInvoiceResult>;
}

/**
 * Not onboarded to eTIMS, or deliberately switched off. Invoices are recorded
 * locally and marked NOT_APPLICABLE. The shop trades normally.
 */
export class NoopTaxAuthority implements TaxAuthorityAdapter {
  readonly name = "noop";
  readonly enabled = false;

  async submit(): Promise<TaxInvoiceResult> {
    return { status: "NOT_APPLICABLE" };
  }
}

/**
 * eTIMS via the OSCU/VSCU local interface.
 *
 * The exact endpoint shape depends on the device Newmark is issued at
 * onboarding, which is still an open decision. The request mapping below is
 * kept in one place so only this file changes when that is confirmed — and it
 * degrades to PENDING rather than throwing, so a KRA outage cannot stop a sale.
 */
export class EtimsTaxAuthority implements TaxAuthorityAdapter {
  readonly name = "etims";
  readonly enabled = true;

  constructor(
    private readonly config: {
      baseUrl: string;
      kraPin: string;
      branchId: string;
      deviceSerial: string;
      timeoutMs?: number;
    },
  ) {}

  async submit(request: TaxInvoiceRequest): Promise<TaxInvoiceResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8000);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/trnsSales/saveSales`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.toEtimsPayload(request)),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { status: "PENDING", error: `eTIMS returned ${response.status}` };
      }

      const body = (await response.json()) as {
        resultCd?: string;
        resultMsg?: string;
        data?: { rcptNo?: string; rcptSign?: string; intrlData?: string };
      };

      // "000" is success in the eTIMS result code convention.
      if (body.resultCd !== "000") {
        return { status: "REJECTED", error: body.resultMsg ?? `Result code ${body.resultCd}` };
      }

      const signature = body.data?.rcptSign;
      return {
        status: "ACCEPTED",
        invoiceNumber: body.data?.rcptNo,
        signature,
        qrUrl: signature ? this.verificationUrl(signature) : undefined,
      };
    } catch (error) {
      // A timeout, a DNS failure, no network at all: all PENDING, all retried
      // later by the invoice queue. Never an error the cashier has to resolve.
      return {
        status: "PENDING",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private verificationUrl(signature: string): string {
    return `https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=${encodeURIComponent(signature)}`;
  }

  private toEtimsPayload(request: TaxInvoiceRequest) {
    return {
      tin: this.config.kraPin,
      bhfId: this.config.branchId,
      deviceSerial: this.config.deviceSerial,
      invcNo: request.receiptNumber,
      // Credit notes carry the original invoice so KRA can match the reversal.
      rcptTyCd: request.isCreditNote ? "R" : "S",
      orgInvcNo: request.originalInvoiceNumber ?? "0",
      custNm: request.customerName ?? "",
      custTin: request.customerPin ?? "",
      salesDt: formatEtimsDate(request.at),
      // Money is sent in shillings with two decimals; internally it stays cents.
      totAmt: formatCents(request.totals.total),
      taxAmt: formatCents(request.totals.tax),
      itemList: request.totals.lines.map((line, index) => ({
        itemSeq: index + 1,
        itemCd: line.sku,
        itemNm: line.name,
        // eTIMS tax codes: A exempt, B standard, C zero-rated.
        taxTyCd: line.taxClass === "STANDARD" ? "B" : line.taxClass === "ZERO_RATED" ? "C" : "A",
        qty: line.pricingMode === "PER_KG" ? formatKg(line.weightGrams) : String(line.quantity),
        qtyUnitCd: line.pricingMode === "PER_KG" ? "KG" : "U",
        prc: formatCents(line.unitPrice),
        splyAmt: formatCents(line.gross),
        dcAmt: formatCents(line.discount),
        taxblAmt: formatCents(line.net),
        taxAmt: formatCents(line.tax),
        totAmt: formatCents(line.net),
      })),
    };
  }
}

function formatEtimsDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

export function createTaxAuthority(env: NodeJS.ProcessEnv = process.env): TaxAuthorityAdapter {
  if ((env.TAX_AUTHORITY_ADAPTER ?? "noop").toLowerCase() !== "etims") {
    return new NoopTaxAuthority();
  }
  const baseUrl = env.ETIMS_BASE_URL ?? "";
  const kraPin = env.ETIMS_KRA_PIN ?? "";
  // Half-configured eTIMS would fail every submission and fill the queue with
  // noise. Treat it as not configured until the details are actually present.
  if (baseUrl === "" || kraPin === "") return new NoopTaxAuthority();

  return new EtimsTaxAuthority({
    baseUrl,
    kraPin,
    branchId: env.ETIMS_BRANCH_ID ?? "00",
    deviceSerial: env.ETIMS_DEVICE_SERIAL ?? "",
  });
}
