import "server-only";
import { db } from "./db";
import type { PricingSettings } from "./pricing";
import type { ShopDetails } from "./adapters/escpos";

/**
 * Shop settings, stored as key/value rows and read through typed accessors.
 *
 * The VAT rate lives here rather than in code because it changes and because
 * the correct treatment per meat category is the owner's accountant's call.
 */

export interface ShopSettings extends PricingSettings {
  shopName: string;
  tagline: string;
  addressLines: string[];
  phone: string;
  kraPin: string;
  receiptFooter: string[];
  /** Line discounts above this, in cents, need a manager PIN. */
  discountApprovalThreshold: number;
  /** Percentage discounts above this need a manager PIN. */
  discountApprovalPercent: number;
  paperWidthMm: 58 | 80;
  lowStockWarningGrams: number;
}

export const DEFAULT_SETTINGS: ShopSettings = {
  shopName: "Newmark Butchery",
  tagline: "Premium Halal Meat",
  addressLines: ["Bishan Plaza, Westlands", "Nairobi, Kenya"],
  phone: "",
  kraPin: "",
  receiptFooter: ["Thank you for shopping with us", "newmarkprimemeat.com"],
  // Fresh meat is largely exempt in Kenya; the standard rate here only applies
  // to products a manager has explicitly marked STANDARD.
  standardVatRatePercent: 16,
  cashRoundingStep: 0,
  discountApprovalThreshold: 50_000, // KSh 500
  discountApprovalPercent: 10,
  paperWidthMm: 80,
  lowStockWarningGrams: 2000,
};

type SettingKey = keyof ShopSettings;

export async function getSettings(): Promise<ShopSettings> {
  const rows = await db.setting.findMany();
  const settings = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    const key = row.key as SettingKey;
    if (!(key in settings)) continue;
    try {
      // Values are stored as JSON so an array of address lines round-trips
      // without inventing a separator that a Nairobi address might contain.
      (settings as Record<string, unknown>)[key] = JSON.parse(row.value);
    } catch {
      console.error(`[settings] ${row.key} is not valid JSON; using the default`);
    }
  }

  return settings;
}

export async function getPricingSettings(): Promise<PricingSettings> {
  const settings = await getSettings();
  return {
    standardVatRatePercent: settings.standardVatRatePercent,
    cashRoundingStep: settings.cashRoundingStep,
  };
}

export async function getShopDetails(): Promise<ShopDetails> {
  const settings = await getSettings();
  return {
    name: settings.shopName,
    tagline: settings.tagline,
    addressLines: settings.addressLines,
    phone: settings.phone,
    kraPin: settings.kraPin,
    footerLines: settings.receiptFooter,
  };
}

/**
 * Settings changes are audited by the caller — this only writes the value.
 * It returns the previous value so the caller has a `before` to record.
 */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: ShopSettings[K],
): Promise<ShopSettings[K]> {
  const existing = await db.setting.findUnique({ where: { key } });
  const previous = existing ? (JSON.parse(existing.value) as ShopSettings[K]) : DEFAULT_SETTINGS[key];

  const serialised = JSON.stringify(value);
  await db.setting.upsert({
    where: { key },
    create: { key, value: serialised },
    update: { value: serialised },
  });

  return previous;
}
