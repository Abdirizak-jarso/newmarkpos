import type { Discount, PricingMode, TaxClass, TenderMethod } from "@/lib/pricing";

/** The slice of a product the till needs. Sent to the client once, at load. */
export interface TillProduct {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  pricingMode: PricingMode;
  price: number;
  comparePrice: number | null;
  unitWeightGrams: number | null;
  taxClass: TaxClass;
  stockGrams: number;
  isByProduct: boolean;
  featured: boolean;
}

export interface TillCategory {
  id: string;
  name: string;
  slug: string;
  colour: string | null;
}

export interface TillSettings {
  standardVatRatePercent: number;
  cashRoundingStep: number;
  discountApprovalThreshold: number;
  discountApprovalPercent: number;
  lowStockWarningGrams: number;
  shopName: string;
}

/** A line in the basket, before pricing. */
export interface TillLine {
  lineId: string;
  productId: string;
  /**
   * The rate the cashier typed on the entry pad, in cents per kg / piece / pack.
   *
   * The product grid quotes no prices, so in practice every line carries one.
   * Absent means the line falls back to the catalogue rate — which is what an
   * older parked basket or a replayed offline sale from before this change
   * still does.
   */
  unitPriceOverride?: number;
  weightGrams?: number;
  quantity?: number;
  /** Set when the cashier typed a shilling target and cut to it. */
  requestedAmount?: number;
  discount?: Discount;
  notes?: string;
}

export interface TillTender {
  method: TenderMethod;
  amount: number;
  /** M-Pesa confirmation code. Required for M-Pesa. */
  reference?: string;
  /** ISO timestamp from the customer's M-Pesa message. Required for M-Pesa. */
  transactedAt?: string;
}

/** Manager approval travels as the manager's PIN alone; the server identifies them. */
export interface ManagerApproval {
  pin: string;
}

/** What a completed checkout hands back to the till. */
export interface CheckoutResponse {
  saleId: string;
  receiptNumber: string;
  total: number;
  changeDue: number;
  receiptPayload: string;
  warnings: string[];
  /** True when the sale was banked into the offline outbox, not the server. */
  queuedOffline?: boolean;
}
