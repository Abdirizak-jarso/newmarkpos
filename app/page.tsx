import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";

/**
 * Where someone lands depends on what they are here to do. A cashier goes
 * straight to the till — the shop opens at 7am and nobody wants a menu.
 */
export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (can(user.role, "sale.create")) redirect("/till");
  redirect("/admin");
}
