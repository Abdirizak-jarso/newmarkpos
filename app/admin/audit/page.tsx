import { db } from "@/lib/db";
import { requirePagePermission } from "@/lib/session";
import { Badge, Card, PageHeader, Table } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

/** Actions worth colouring red in a list somebody scans for trouble. */
const SERIOUS = new Set(["VOID_SALE", "REFUND", "PRICE_CHANGE", "STOCK_ADJUSTMENT", "LOGIN_FAILED"]);

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  await requirePagePermission("audit.view");
  const params = await searchParams;

  const events = await db.auditEvent.findMany({
    where: params.action ? { action: params.action } : {},
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: true, approver: true },
  });

  const actions = await db.auditEvent.groupBy({ by: ["action"], _count: true });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only. Nothing in this application deletes or edits an audit entry."
        action={
          <form className="flex gap-2">
            <select
              name="action"
              defaultValue={params.action ?? ""}
              className="h-9 sheet border border-char-300 px-2 text-sm"
            >
              <option value="">All actions</option>
              {actions
                .sort((a, b) => a.action.localeCompare(b.action))
                .map((row) => (
                  <option key={row.action} value={row.action}>
                    {row.action.replace(/_/g, " ").toLowerCase()} ({row._count})
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className="h-9 sheet bg-char-800 px-4 text-sm font-medium text-white hover:bg-char-700"
            >
              Filter
            </button>
          </form>
        }
      />

      <div className="p-8">
        <Card>
          <Table
            headers={["When", "Action", "By", "Approved by", "What changed", "Reason"]}
            empty="Nothing recorded yet."
          >
            {events.map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-char-500">
                  {event.createdAt.toLocaleString("en-KE", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={SERIOUS.has(event.action) ? "bad" : "neutral"}>
                    {event.action.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-char-700">{event.actor.name}</td>
                <td className="px-3 py-2 text-char-600">
                  {event.approver ? event.approver.name : <span className="text-char-400">—</span>}
                </td>
                <td className="px-3 py-2">
                  <Change before={event.before} after={event.after} />
                </td>
                <td className="px-3 py-2 text-xs text-char-600">{event.reason ?? "—"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}

/**
 * Both sides of the change, side by side. An entry that only showed the new
 * value could not answer "what did they change it from", which is the whole
 * question this log exists to answer.
 */
function Change({ before, after }: { before: string | null; after: string | null }) {
  const parse = (value: string | null) => {
    if (!value) return null;
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const from = parse(before);
  const to = parse(after);
  if (!from && !to) return <span className="text-char-400">—</span>;

  const keys = [...new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])].slice(0, 4);

  return (
    <ul className="space-y-0.5 text-xs">
      {keys.map((key) => {
        const oldValue = from?.[key];
        const newValue = to?.[key];
        const same = JSON.stringify(oldValue) === JSON.stringify(newValue);

        return (
          <li key={key} className="tabular">
            <span className="text-char-500">{key}: </span>
            {oldValue !== undefined && !same && (
              <>
                <span className="text-meat-700 line-through">{format(oldValue)}</span>{" "}
                <span className="text-char-400">→</span>{" "}
              </>
            )}
            <span className="text-char-800">{format(newValue ?? oldValue)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 60);
  return String(value);
}
