/**
 * Payment capture beyond cash.
 *
 * M-Pesa is the majority of non-cash takings at a Nairobi butchery counter.
 * Whether Newmark uses a Till or a Paybill, and whether Daraja API access has
 * been granted, are both open decisions — so the manual adapter (cashier reads
 * the confirmation SMS and types the code) is the default and must keep
 * working. It is what the counter falls back to whenever Safaricom's API is
 * slow, which is often.
 */

import type { Cents } from "../money";
import type { TenderMethod } from "../pricing";

export interface PaymentRequest {
  method: TenderMethod;
  amount: Cents;
  /** Customer phone in 2547XXXXXXXX form, for an STK push. */
  phone?: string;
  saleReference: string;
}

export interface PaymentResult {
  /** CONFIRMED settles the tender. PENDING keeps the sale on the payment pad. */
  status: "CONFIRMED" | "PENDING" | "FAILED";
  /** M-Pesa confirmation code, card auth code. Printed on the receipt. */
  reference?: string;
  /** Provider-side id used to poll a pending push. */
  checkoutId?: string;
  error?: string;
}

export interface PaymentAdapter {
  readonly name: string;
  /** True when the adapter can initiate a charge rather than just record one. */
  readonly canInitiate: boolean;
  charge(request: PaymentRequest): Promise<PaymentResult>;
  /** Poll a PENDING push. Adapters that cannot initiate never see this. */
  confirm(checkoutId: string): Promise<PaymentResult>;
}

/**
 * The cashier watches for the customer's confirmation SMS and types the code.
 * No API, no network, no waiting on Safaricom.
 */
export class ManualPaymentAdapter implements PaymentAdapter {
  readonly name = "manual";
  readonly canInitiate = false;

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    // The tender is recorded as taken; the reference the cashier typed is
    // carried through to the receipt and the day's reconciliation.
    return { status: "CONFIRMED", reference: request.saleReference };
  }

  async confirm(): Promise<PaymentResult> {
    return { status: "CONFIRMED" };
  }
}

/**
 * Safaricom Daraja STK push.
 *
 * Deliberately never awaited inside the checkout transaction: a push takes 5
 * to 40 seconds and the customer is standing at the counter. The till records
 * a PENDING tender, polls, and lets the cashier fall back to the manual code
 * at any point.
 */
export class DarajaPaymentAdapter implements PaymentAdapter {
  readonly name = "daraja";
  readonly canInitiate = true;

  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: {
      baseUrl: string;
      shortcode: string;
      passkey: string;
      consumerKey: string;
      consumerSecret: string;
      callbackUrl: string;
      /** CustomerPayBillOnline for a Paybill, CustomerBuyGoodsOnline for a Till. */
      transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
    },
  ) {}

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    if (!request.phone) return { status: "FAILED", error: "No customer phone number" };

    try {
      const token = await this.accessToken();
      const timestamp = darajaTimestamp(new Date());
      const password = Buffer.from(
        `${this.config.shortcode}${this.config.passkey}${timestamp}`,
      ).toString("base64");

      const response = await fetch(`${this.config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: this.config.shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: this.config.transactionType,
          // Daraja takes whole shillings. Internally the amount stays in cents;
          // the checkout blocks a push that is not a whole shilling so the
          // customer is never charged a rounded-down figure.
          Amount: Math.round(request.amount / 100),
          PartyA: request.phone,
          PartyB: this.config.shortcode,
          PhoneNumber: request.phone,
          CallBackURL: this.config.callbackUrl,
          AccountReference: request.saleReference,
          TransactionDesc: `Newmark ${request.saleReference}`,
        }),
      });

      const body = (await response.json()) as {
        CheckoutRequestID?: string;
        ResponseCode?: string;
        errorMessage?: string;
      };

      if (body.ResponseCode !== "0") {
        return { status: "FAILED", error: body.errorMessage ?? "STK push refused" };
      }
      return { status: "PENDING", checkoutId: body.CheckoutRequestID };
    } catch (error) {
      // Falls back to the cashier typing the code. Never blocks the sale.
      return { status: "FAILED", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async confirm(checkoutId: string): Promise<PaymentResult> {
    try {
      const token = await this.accessToken();
      const timestamp = darajaTimestamp(new Date());
      const password = Buffer.from(
        `${this.config.shortcode}${this.config.passkey}${timestamp}`,
      ).toString("base64");

      const response = await fetch(`${this.config.baseUrl}/mpesa/stkpushquery/v1/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: this.config.shortcode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutId,
        }),
      });

      const body = (await response.json()) as { ResultCode?: string; ResultDesc?: string };
      if (body.ResultCode === "0") return { status: "CONFIRMED", checkoutId };
      // 1032 is the customer cancelling on their handset.
      if (body.ResultCode === "1032") return { status: "FAILED", error: "Cancelled by customer" };
      return { status: "PENDING", checkoutId, error: body.ResultDesc };
    } catch (error) {
      return { status: "PENDING", checkoutId, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;

    const credentials = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`,
    ).toString("base64");
    const response = await fetch(
      `${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { authorization: `Basic ${credentials}` } },
    );
    const body = (await response.json()) as { access_token?: string; expires_in?: string };
    if (!body.access_token) throw new Error("Daraja did not return an access token");

    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Number(body.expires_in ?? 3599) * 1000,
    };
    return this.token.value;
  }
}

function darajaTimestamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/** An STK push cannot carry cents, so the till must not offer one that would. */
export function canPushExactly(amount: Cents): boolean {
  return amount % 100 === 0;
}

export function createPaymentAdapter(env: NodeJS.ProcessEnv = process.env): PaymentAdapter {
  if ((env.MPESA_ADAPTER ?? "manual").toLowerCase() !== "daraja") return new ManualPaymentAdapter();

  const required = [
    env.MPESA_SHORTCODE,
    env.MPESA_PASSKEY,
    env.MPESA_CONSUMER_KEY,
    env.MPESA_CONSUMER_SECRET,
    env.MPESA_CALLBACK_URL,
  ];
  if (required.some((value) => !value)) return new ManualPaymentAdapter();

  return new DarajaPaymentAdapter({
    baseUrl: env.MPESA_BASE_URL ?? "https://api.safaricom.co.ke",
    shortcode: env.MPESA_SHORTCODE!,
    passkey: env.MPESA_PASSKEY!,
    consumerKey: env.MPESA_CONSUMER_KEY!,
    consumerSecret: env.MPESA_CONSUMER_SECRET!,
    callbackUrl: env.MPESA_CALLBACK_URL!,
    transactionType:
      (env.MPESA_SHORTCODE_TYPE ?? "till").toLowerCase() === "paybill"
        ? "CustomerPayBillOnline"
        : "CustomerBuyGoodsOnline",
  });
}
