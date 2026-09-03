import { z } from "zod";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "./pin";
import { ROLES } from "./permissions";

/**
 * Server-side validation for every mutation, regardless of what the client
 * already checked. The till is a browser on a shop counter; its validation is
 * a courtesy to the cashier, not a guarantee to the server.
 */

/** Money must arrive as integer cents. A float here means a bug upstream. */
export const cents = z
  .number()
  .int("Money must be whole cents — a decimal here means a float leaked in")
  .finite();

export const positiveCents = cents.positive();
export const nonNegativeCents = cents.nonnegative();

/** Weight must arrive as integer grams — 3 dp of kilograms. */
export const grams = z.number().int("Weight must be whole grams").finite();
export const positiveGrams = grams.positive();
export const nonNegativeGrams = grams.nonnegative();

export const pricingMode = z.enum(["PER_KG", "PER_PIECE", "FIXED_PACK"]);
export const taxClass = z.enum(["EXEMPT", "ZERO_RATED", "STANDARD"]);
export const tenderMethod = z.enum(["CASH", "MPESA", "CARD", "ACCOUNT", "VOUCHER"]);
export const role = z.enum(ROLES);

export const discountSchema = z.object({
  kind: z.enum(["PERCENT", "AMOUNT"]),
  value: z.number().int().nonnegative(),
  reason: z.string().trim().max(200).optional(),
});

export const pinSchema = z
  .string()
  .regex(new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`), `PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits`);

/** Manager approval is the manager's PIN and nothing else. */
export const managerApprovalSchema = z.object({
  pin: pinSchema,
});

// ---------------------------------------------------------------------------
// Till
// ---------------------------------------------------------------------------

export const saleLineSchema = z
  .object({
    lineId: z.string().min(1).max(64),
    productId: z.string().min(1),
    /**
     * The rate the cashier typed at the counter, in cents per kg / piece / pack.
     *
     * This is the one figure the client is allowed to put a price in, and it is
     * not an exception to "never trust the client for prices" so much as a
     * different rule: the server still reads the catalogue rate, still records
     * it against the line, still measures the gap, and still makes an admin
     * approve a gap that goes the shop's way. What the client cannot do is
     * change a price SILENTLY — an override arrives explicitly, or not at all.
     */
    unitPriceOverride: positiveCents.optional(),
    weightGrams: positiveGrams.optional(),
    quantity: z.number().int().positive().optional(),
    /** Set when the cashier typed a shilling target and cut to it. */
    requestedAmount: positiveCents.optional(),
    discount: discountSchema.optional(),
    notes: z.string().trim().max(200).optional(),
  })
  .refine((line) => line.weightGrams !== undefined || line.quantity !== undefined, {
    message: "A sale line needs either a weight or a quantity",
  });

/**
 * Safaricom confirmation codes are ten characters, letters and digits, e.g.
 * SJH4K2L9XZ. Kept a little loose either side of that — the format has changed
 * before and a cashier holding a valid code must never be blocked by us.
 */
export const mpesaCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{8,15}$/, "Enter the M-Pesa code from the customer's message");

/**
 * A payment on a sale.
 *
 * An M-Pesa tender may arrive here WITHOUT a code, and that is deliberate. The
 * customer's confirmation SMS lands seconds to minutes after they authorise the
 * payment, and the shop is not going to hold a queue at the counter while the
 * cashier waits for a phone to buzz. The sale is banked and the receipt printed
 * on the payment; the code is recorded afterwards against the sale, which moves
 * the payment from PENDING to CONFIRMED.
 *
 * That is not the same as not caring about the code. An M-Pesa payment with no
 * code is money the shop cannot prove it received, so it stays PENDING, it is
 * counted and listed until somebody clears it.
 */
export const tenderSchema = z
  .object({
    method: tenderMethod,
    amount: positiveCents,
    // Normalised on the way in: a cashier copying a code off a customer's phone
    // may type it either case, and the stored value is what a later
    // reconciliation searches on, so it has to be canonical.
    reference: z.string().trim().toUpperCase().max(64).optional(),
    /** ISO timestamp of the M-Pesa transaction, from the customer's message. */
    transactedAt: z.string().datetime().optional(),
  })
  .superRefine((tender, ctx) => {
    // No code is fine — it is recorded later. A code that cannot be an M-Pesa
    // code is not: it would file as reconciled against something that will
    // never appear on the statement. Other methods carry their own kinds of
    // reference (a card auth code), so this shape is checked for M-Pesa only.
    if (tender.method !== "MPESA" || tender.reference === undefined) return;

    const code = mpesaCode.safeParse(tender.reference);
    if (!code.success) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: code.error.issues[0]?.message ?? "Check the M-Pesa transaction code",
      });
    }
  });

/**
 * Recording the code against a sale that has already been paid and printed.
 *
 * Both fields are required here, unlike at checkout: the cashier is looking at
 * the customer's message when they do this, so there is nothing to wait for.
 */
export const recordMpesaCodeSchema = z.object({
  saleId: z.string().min(1),
  paymentId: z.string().min(1),
  reference: mpesaCode,
  transactedAt: z.string().datetime(),
});

export type RecordMpesaCodeInput = z.infer<typeof recordMpesaCodeSchema>;

export const checkoutSchema = z.object({
  lines: z.array(saleLineSchema).min(1, "A sale needs at least one line"),
  tenders: z.array(tenderSchema).min(1, "A sale needs at least one payment"),
  saleDiscount: discountSchema.optional(),
  customerName: z.string().trim().max(120).optional(),
  customerPhone: z
    .string()
    .trim()
    .regex(/^(?:\+?254|0)?7\d{8}$/, "Enter a Kenyan mobile number")
    .optional()
    .or(z.literal("")),
  customerPin: z.string().trim().max(20).optional(),
  /** Present when the sale needed a manager to authorise a discount. */
  approval: managerApprovalSchema.optional(),
  /** Client-generated id so a retried sync cannot bank the same sale twice. */
  idempotencyKey: z.string().min(8).max(64),
  /** When the till was offline, the time the sale actually happened. */
  offlineAt: z.string().datetime().optional(),
});

export const voidSaleSchema = z.object({
  saleId: z.string().min(1),
  reason: z.string().trim().min(3, "Say why the sale is being voided").max(200),
  approval: managerApprovalSchema,
});

export const refundSchema = z.object({
  saleId: z.string().min(1),
  /** Line ids and the weight/quantity coming back. Empty means the whole sale. */
  lines: z
    .array(
      z.object({
        saleLineId: z.string().min(1),
        weightGrams: positiveGrams.optional(),
        quantity: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  reason: z.string().trim().min(3, "Say why the sale is being refunded").max(200),
  /** Refunds go back the way they came unless a manager says otherwise. */
  // The shop pays refunds back the way it was paid.
  method: tenderMethod.default("MPESA"),
  approval: managerApprovalSchema,
});

export const parkSaleSchema = z.object({
  lines: z.array(saleLineSchema).min(1),
  customerName: z.string().trim().max(120).optional(),
  note: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const productSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9-]+$/i, "SKU may only contain letters, numbers and hyphens"),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).optional(),
    categoryId: z.string().min(1),
    pricingMode: pricingMode,
    price: positiveCents,
    comparePrice: positiveCents.optional().nullable(),
    unitWeightGrams: positiveGrams.optional().nullable(),
    taxClass: taxClass,
    reorderLevelGrams: nonNegativeGrams.optional().nullable(),
    costPerKg: nonNegativeCents.default(0),
    isByProduct: z.boolean().default(false),
    isBreakdownSource: z.boolean().default(false),
    active: z.boolean().default(true),
    showOnTill: z.boolean().default(true),
    featured: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
  })
  .refine(
    (p) => p.pricingMode === "PER_KG" || (p.unitWeightGrams ?? 0) > 0,
    {
      message: "A per-piece or fixed-pack product needs a unit weight, or it cannot move stock",
      path: ["unitWeightGrams"],
    },
  );

export const priceChangeSchema = z.object({
  productId: z.string().min(1),
  price: positiveCents,
  reason: z.string().trim().max(200).optional(),
  approval: managerApprovalSchema,
});

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export const stockReason = z.enum([
  "INTAKE",
  "SALE",
  "REFUND",
  "BREAKDOWN_IN",
  "BREAKDOWN_OUT",
  "WASTE",
  "ADJUSTMENT",
  "TRANSFER",
  "STAFF_MEAT",
  "COUNT",
]);

export const stockIntakeSchema = z.object({
  productId: z.string().min(1),
  weightGrams: positiveGrams,
  costPerKg: nonNegativeCents.default(0),
  supplier: z.string().trim().max(120).optional(),
  note: z.string().trim().max(200).optional(),
});

export const stockAdjustmentSchema = z.object({
  productId: z.string().min(1),
  /** Signed: negative writes stock off, positive puts it back. */
  deltaGrams: grams.refine((g) => g !== 0, "An adjustment of zero changes nothing"),
  reason: stockReason,
  note: z.string().trim().min(3, "Say why the stock is being adjusted").max(200),
  approval: managerApprovalSchema,
});

export const stockCountSchema = z.object({
  productId: z.string().min(1),
  countedGrams: nonNegativeGrams,
  note: z.string().trim().max(200).optional(),
});

export const breakdownSchema = z
  .object({
    sourceProductId: z.string().min(1),
    inputWeightGrams: positiveGrams,
    inputCost: nonNegativeCents.default(0),
    supplier: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(500).optional(),
    outputs: z
      .array(
        z.object({
          productId: z.string().min(1),
          weightGrams: positiveGrams,
        }),
      )
      .min(1, "A breakdown must produce at least one output"),
  })
  .refine(
    (b) => b.outputs.reduce((total, o) => total + o.weightGrams, 0) <= b.inputWeightGrams,
    {
      message: "Outputs weigh more than the carcass came in at — check the scale",
      path: ["outputs"],
    },
  );

// ---------------------------------------------------------------------------
// Staff and settings
// ---------------------------------------------------------------------------

/** Signing in is the PIN alone — it identifies the person and authorises them. */
export const loginSchema = z.object({
  pin: pinSchema,
});

export const userSchema = z.object({
  name: z.string().trim().min(2).max(120),
  // An employee number for rotas and reports. Never typed to sign in.
  staffCode: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9]+$/i, "Employee number may only contain letters and numbers"),
  role: role,
  pin: pinSchema.optional(),
  active: z.boolean().default(true),
});

export const settingsSchema = z.object({
  shopName: z.string().trim().min(2).max(120).optional(),
  tagline: z.string().trim().max(120).optional(),
  addressLines: z.array(z.string().trim().max(120)).max(4).optional(),
  phone: z.string().trim().max(40).optional(),
  kraPin: z.string().trim().max(20).optional(),
  receiptFooter: z.array(z.string().trim().max(120)).max(4).optional(),
  standardVatRatePercent: z.number().min(0).max(100).optional(),
  cashRoundingStep: nonNegativeCents.optional(),
  discountApprovalThreshold: nonNegativeCents.optional(),
  discountApprovalPercent: z.number().min(0).max(100).optional(),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]).optional(),
  lowStockWarningGrams: nonNegativeGrams.optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type BreakdownFormInput = z.infer<typeof breakdownSchema>;
export type ProductInput = z.infer<typeof productSchema>;
