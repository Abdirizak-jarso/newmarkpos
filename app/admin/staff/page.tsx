import { db } from "@/lib/db";
import { requirePagePermission, getCurrentUser } from "@/lib/session";
import { can, permissionsFor, ROLES, ROLE_LABELS, isRole } from "@/lib/permissions";
import { Badge, Card, PageHeader, Table } from "@/components/admin/ui";
import { StaffForm } from "./StaffForm";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  await requirePagePermission("staff.view");
  const user = await getCurrentUser();
  const mayManage = user ? can(user.role, "staff.manage") : false;

  const staff = await db.user.findMany({
    orderBy: [{ active: "desc" }, { role: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <PageHeader
        title="Staff"
        description="Each person signs in with their PIN alone — no two may share one. Permissions are enforced on the server; hiding a button is not authorisation."
      />

      <div className="space-y-6 p-8">
        {mayManage && <StaffForm />}

        <Card title="People">
          <Table
            headers={["Name", "Employee no.", "Role", "Last seen", "Status", ""]}
            empty="No staff accounts yet."
          >
            {staff.map((member) => (
              <tr key={member.id} className={member.active ? "" : "opacity-50"}>
                <td className="px-3 py-2 font-medium text-char-900">{member.name}</td>
                <td className="tabular px-3 py-2 text-char-600">{member.staffCode}</td>
                <td className="px-3 py-2 text-char-600">
                  {isRole(member.role) ? ROLE_LABELS[member.role] : member.role}
                  <span className="ml-2 text-xs text-char-400">
                    {isRole(member.role) ? `${permissionsFor(member.role).length} permissions` : ""}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-char-500">
                  {member.lastSeen
                    ? member.lastSeen.toLocaleString("en-KE", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "Never signed in"}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={member.active ? "good" : "neutral"}>
                    {member.active ? "active" : "inactive"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {mayManage && (
                    <StaffForm
                      inline
                      existing={{
                        id: member.id,
                        name: member.name,
                        staffCode: member.staffCode,
                        role: member.role,
                        active: member.active,
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="What each role can do">
          <div className="grid gap-4 md:grid-cols-2">
            {ROLES.map((role) => (
              <div key={role}>
                <h3 className="text-sm font-semibold text-char-900">{ROLE_LABELS[role]}</h3>
                <ul className="mt-1.5 space-y-0.5 text-xs text-char-600">
                  {permissionsFor(role).map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
