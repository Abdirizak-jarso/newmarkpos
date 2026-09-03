"use client";

import { useActionState } from "react";
import { saveSettings, type SettingsState } from "./actions";
import { centsToShillings } from "@/lib/money";
import { gramsToKg } from "@/lib/weight";
import type { ShopSettings } from "@/lib/settings";

const input = "h-10 w-full sheet border border-char-300 px-2 text-sm";
const area = "min-h-20 w-full sheet border border-char-300 p-2 text-sm";

export function SettingsForm({ settings }: { settings: ShopSettings }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(saveSettings, {});

  return (
    <form action={action} className="space-y-6">
      <section className="sheet border border-char-200 bg-char-50">
        <h2 className="border-b border-char-200 px-4 py-3 text-sm font-semibold text-char-800">
          Shop details
        </h2>
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <Field label="Shop name">
            <input name="shopName" defaultValue={settings.shopName} className={input} />
          </Field>
          <Field label="Tagline">
            <input name="tagline" defaultValue={settings.tagline} className={input} />
          </Field>
          <Field label="Address (one line per row)">
            <textarea
              name="addressLines"
              defaultValue={settings.addressLines.join("\n")}
              className={area}
            />
          </Field>
          <Field label="Receipt footer (one line per row)">
            <textarea
              name="receiptFooter"
              defaultValue={settings.receiptFooter.join("\n")}
              className={area}
            />
          </Field>
          <Field label="Phone">
            <input name="phone" defaultValue={settings.phone} className={input} />
          </Field>
          <Field label="KRA PIN">
            <input name="kraPin" defaultValue={settings.kraPin} className={`uppercase ${input}`} />
          </Field>
        </div>
      </section>

      <section className="sheet border border-char-200 bg-char-50">
        <h2 className="border-b border-char-200 px-4 py-3 text-sm font-semibold text-char-800">
          Tax and rounding
        </h2>
        <div className="grid gap-4 p-4 md:grid-cols-3">
          <Field
            label="Standard VAT rate (%)"
            hint="Applies only to products marked STANDARD. Most fresh meat is not."
          >
            <input
              name="standardVatRatePercent"
              type="number"
              step="0.5"
              min="0"
              max="100"
              defaultValue={settings.standardVatRatePercent}
              className={`tabular ${input}`}
            />
          </Field>
          <Field
            label="Cash rounding (KSh)"
            hint="0 disables it. 5 rounds the total to the nearest 5 shillings, shown as its own line."
          >
            <input
              name="cashRoundingStep"
              inputMode="decimal"
              defaultValue={centsToShillings(settings.cashRoundingStep)}
              className={`tabular ${input}`}
            />
          </Field>
          <Field label="Receipt paper">
            <select name="paperWidthMm" defaultValue={settings.paperWidthMm} className={input}>
              <option value={80}>80 mm (42 columns)</option>
              <option value={58}>58 mm (32 columns)</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="sheet border border-char-200 bg-char-50">
        <h2 className="border-b border-char-200 px-4 py-3 text-sm font-semibold text-char-800">
          Approvals and warnings
        </h2>
        <div className="grid gap-4 p-4 md:grid-cols-3">
          <Field
            label="Discount needing approval (KSh)"
            hint="A discount at or above this amount needs a manager PIN."
          >
            <input
              name="discountApprovalThreshold"
              inputMode="decimal"
              defaultValue={centsToShillings(settings.discountApprovalThreshold)}
              className={`tabular ${input}`}
            />
          </Field>
          <Field
            label="Discount needing approval (%)"
            hint="A discount at or above this share of the sale also needs a PIN."
          >
            <input
              name="discountApprovalPercent"
              type="number"
              step="1"
              min="0"
              max="100"
              defaultValue={settings.discountApprovalPercent}
              className={`tabular ${input}`}
            />
          </Field>
          <Field label="Low stock warning (kg)">
            <input
              name="lowStockWarningKg"
              inputMode="decimal"
              defaultValue={gramsToKg(settings.lowStockWarningGrams)}
              className={`tabular ${input}`}
            />
          </Field>
        </div>
      </section>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 sheet bg-brass-500 px-6 text-sm font-semibold text-white hover:bg-brass-400 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        {state.error && <p className="text-sm text-meat-700">{state.error}</p>}
        {state.success && <p className="text-sm text-emerald-700">{state.success}</p>}
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-char-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-char-500">{hint}</span>}
    </label>
  );
}
