"use client";

import Link from "next/link";
import { can } from "@/lib/permissions";
import type { CurrentUser } from "@/lib/session";

/**
 * The status strip.
 *
 * Everything a cashier needs to know without asking: whether the till is
 * online, how many sales are waiting to sync, and
 * whether receipts are stuck in the print queue. All four are things that
 * silently go wrong on a counter, so none of them are hidden behind a menu.
 */
export function TillHeader({
  user,
  terminalId,
  online,
  queued,
  pendingPrints,
  awaitingCodes,
  onShowCodeQueue,
  parkedCount,
}: {
  user: CurrentUser;
  terminalId: string;
  online: boolean;
  queued: number;
  pendingPrints: number;
  awaitingCodes: number;
  onShowCodeQueue: () => void;
  parkedCount: number;
}) {
  return (
    <header className="flex shrink-0 items-center gap-5 border-b border-char-800 bg-char-900 px-4 py-2.5">
      {/* The fascia, then who is on the counter. No logo tile, no initial. */}
      <span className="wide shrink-0 text-lg font-bold tracking-tight text-bone">Newmark</span>

      <div className="shrink-0 border-l border-char-800 pl-5 leading-tight">
        <p className="text-sm font-medium text-char-100">{user.name}</p>
        <p className="text-[11px] text-char-400">
          {user.role.charAt(0) + user.role.slice(1).toLowerCase()} on till {terminalId}
        </p>
      </div>

      <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <Status
          tone={online ? "ok" : "warn"}
          label={online ? "Online" : "Offline — still selling"}
        />
        {queued > 0 && <Status tone="warn" label={`${queued} to sync`} />}
        {/*
          Money taken with nothing yet to prove it arrived. It is a button
          because the cashier clears these between customers, and burying it in
          a menu is how a day ends with twenty of them outstanding.
        */}
        {awaitingCodes > 0 && (
          <button
            type="button"
            onClick={onShowCodeQueue}
            className="sheet flex items-center gap-1.5 px-2 py-1 text-[11px] text-brass-200 hover:bg-char-800"
          >
            <span className="h-1.5 w-1.5 shrink-0 bg-brass-400" aria-hidden />
            {awaitingCodes} waiting for a code
          </button>
        )}
        {pendingPrints > 0 && <Status tone="warn" label={`${pendingPrints} to print`} />}
        {parkedCount > 0 && <Status tone="neutral" label={`${parkedCount} parked`} />}
      </div>

      <nav className="flex items-center gap-2">
        {can(user.role, "report.sales") && <HeaderLink href="/admin">Back office</HeaderLink>}
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="sheet px-3 py-2 text-sm text-char-300 transition-colors hover:bg-char-800 hover:text-bone"
          >
            Sign out
          </button>
        </form>
      </nav>
    </header>
  );
}

function HeaderLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="sheet px-3 py-2 text-sm text-char-300 transition-colors hover:bg-char-800 hover:text-bone"
    >
      {children}
    </Link>
  );
}

/**
 * An indicator lamp.
 *
 * Square, not a pill: this is the row of lamps along the top of a machine,
 * telling the cashier at a glance what is and is not working. The lamp carries
 * the colour so the label can stay plain and legible across the counter.
 */
function Status({ tone, label }: { tone: "ok" | "warn" | "alert" | "neutral"; label: string }) {
  const lamps = {
    ok: "bg-emerald-400",
    warn: "bg-brass-400",
    alert: "bg-meat-500",
    neutral: "bg-char-500",
  } as const;

  return (
    <span className="flex items-center gap-1.5 text-[11px] text-char-300">
      <span className={`h-1.5 w-1.5 shrink-0 ${lamps[tone]}`} aria-hidden />
      {label}
    </span>
  );
}
