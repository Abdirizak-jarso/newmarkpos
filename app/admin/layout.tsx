import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can, isBackOffice, ROLE_LABELS, type Permission } from "@/lib/permissions";

/**
 * Back office shell.
 *
 * Light, dense and read sitting down — the opposite of the till. Nav items are
 * filtered by permission, but that is only tidiness: every page behind them
 * checks the same permission again on the server.
 */

const NAV: { href: string; label: string; permission: Permission }[] = [
  { href: "/admin", label: "Overview", permission: "report.sales" },
  { href: "/admin/sales", label: "Sales", permission: "report.sales" },
  { href: "/admin/products", label: "Catalogue", permission: "product.view" },
  { href: "/admin/stock", label: "Stock", permission: "stock.view" },
  { href: "/admin/breakdown", label: "Carcass breakdown", permission: "stock.breakdown" },
  { href: "/admin/reports", label: "Reports", permission: "report.sales" },
  { href: "/admin/staff", label: "Staff", permission: "staff.view" },
  { href: "/admin/audit", label: "Audit log", permission: "audit.view" },
  { href: "/admin/settings", label: "Settings", permission: "settings.edit" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // The back office is the admin's. A cashier who follows a link here — or
  // types the URL — goes back to the till. Gated on the ROLE rather than on a
  // permission a cashier happens to share (they can see stock levels on the
  // till), so every page under /admin is covered by this one check.
  if (!isBackOffice(user.role)) redirect("/till");

  const items = NAV.filter((item) => can(user.role, item.permission));

  return (
    <div className="flex min-h-screen bg-tile text-char-900">
      <aside className="flex w-60 shrink-0 flex-col border-r border-char-200 bg-char-50">
        <div className="border-b border-char-200 px-5 py-4">
          {/* Same fascia as the counter, set in the same wide cut. */}
          <p className="wide text-lg font-bold tracking-tight text-char-900">Newmark</p>
          <p className="mt-1.5 text-xs text-char-500">
            {user.name}, {ROLE_LABELS[user.role].toLowerCase()}
          </p>
        </div>

        <nav className="flex-1 space-y-0.5 p-3">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block sheet px-3 py-2 text-sm text-char-700 transition-colors hover:bg-char-100 hover:text-char-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-char-200 p-3">
          {can(user.role, "sale.create") && (
            <Link
              href="/till"
              className="mb-1 block sheet bg-brass-500 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-brass-400"
            >
              Open till
            </Link>
          )}
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="w-full sheet px-3 py-2 text-left text-sm text-char-600 hover:bg-char-100"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
    </div>
  );
}
