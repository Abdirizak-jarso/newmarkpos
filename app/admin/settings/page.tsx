import { requirePagePermission } from "@/lib/session";
import { getSettings } from "@/lib/settings";
import { createPrinter } from "@/lib/adapters/printer";
import { createScaleAdapter } from "@/lib/adapters/scale";
import { createTaxAuthority } from "@/lib/adapters/tax-authority";
import { createPaymentAdapter } from "@/lib/adapters/payments";
import { terminalId } from "@/lib/receipt-number";
import { Badge, Card, PageHeader } from "@/components/admin/ui";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePagePermission("settings.edit");
  const settings = await getSettings();

  // Ask each adapter how it is doing. None of these throws when the hardware
  // is absent — that is the whole point of the adapter layer.
  const [printerStatus, scaleStatus] = await Promise.all([
    createPrinter().status(),
    createScaleAdapter().status(),
  ]);
  const taxAuthority = createTaxAuthority();
  const payments = createPaymentAdapter();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Shop details, tax treatment and approval thresholds. Every change is audited."
      />

      <div className="space-y-6 p-8">
        <Card title="Peripherals and services">
          <div className="grid gap-4 md:grid-cols-4">
            <Peripheral
              label="Printer"
              adapter={printerStatus.adapter}
              connected={printerStatus.connected}
              detail={printerStatus.detail ?? `${settings.paperWidthMm}mm`}
            />
            <Peripheral
              label="Scale"
              adapter={scaleStatus.adapter}
              connected={scaleStatus.connected}
              detail={scaleStatus.detail}
            />
            <Peripheral
              label="KRA eTIMS"
              adapter={taxAuthority.name}
              connected={taxAuthority.enabled}
              detail={taxAuthority.enabled ? "Submitting invoices" : "Not configured — sales unaffected"}
            />
            <Peripheral
              label="M-Pesa"
              adapter={payments.name}
              connected={payments.canInitiate}
              detail={payments.canInitiate ? "STK push available" : "Codes typed by the cashier"}
            />
          </div>

          <p className="mt-4 text-xs text-char-500">
            Terminal <span className="tabular font-medium">{terminalId()}</span>. Peripherals are
            configured in <code className="rounded bg-char-100 px-1">.env</code> — a missing device
            never stops the shop trading.
          </p>
        </Card>

        <SettingsForm settings={settings} />
      </div>
    </>
  );
}

function Peripheral({
  label,
  adapter,
  connected,
  detail,
}: {
  label: string;
  adapter: string;
  connected: boolean;
  detail?: string;
}) {
  return (
    <div className="sheet border border-char-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-char-900">{label}</span>
        <Badge tone={connected ? "good" : "neutral"}>{connected ? "ready" : "fallback"}</Badge>
      </div>
      <p className="mt-1 text-xs text-char-500">
        {adapter}
        {detail ? ` — ${detail}` : ""}
      </p>
    </div>
  );
}
