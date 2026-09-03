/**
 * Roles and permissions.
 *
 * Two roles, because the shop has two kinds of person: the cashier who serves
 * customers, and the admin who runs the place. Anything that can quietly move
 * money or stock — a void, a refund, a price change, a write-off — needs an
 * admin's PIN even when a cashier is the one at the till.
 *
 * Every check here runs on the server. Hiding a button is presentation, not
 * authorisation — the till is a browser on a shop counter and anyone can open
 * the devtools on it. `requirePermission` in lib/session.ts is what actually
 * stops an action; the helpers below are also used by the UI to decide what to
 * show, which is a convenience layered on top of the real check, never
 * instead of it.
 */

export const ROLES = ["CASHIER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Till
  "sale.create",
  "sale.park",
  "sale.discount.small", // up to the configured threshold
  "sale.discount.large", // above the threshold — admin territory
  "sale.void",
  "sale.refund",
  "sale.reprint",
  "sale.mpesa.reconcile", // recording the code that proves an M-Pesa payment arrived
  "drawer.open", // opening the drawer outside a sale is a theft vector

  // Stock
  "stock.view",
  "stock.intake",
  "stock.adjust",
  "stock.waste",
  "stock.breakdown",
  "stock.count",

  // Catalogue
  "product.view",
  "product.create",
  "product.edit",
  "product.price", // changing a price is audited separately from other edits
  "product.delete",

  // Back office
  "report.sales",
  "report.margin",
  "staff.view",
  "staff.manage",
  "settings.edit",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * What a cashier can do without anyone else present: serve customers, park a
 * sale, reprint a receipt, and look things up.
 */
const CASHIER: Permission[] = [
  "sale.create",
  "sale.park",
  "sale.discount.small",
  "sale.reprint",
  "sale.mpesa.reconcile",
  "stock.view",
  "product.view",
];

/** The admin runs the shop, so the admin can do everything. */
const ADMIN: Permission[] = [...PERMISSIONS];

const BY_ROLE: Record<Role, readonly Permission[]> = {
  CASHIER: CASHIER,
  ADMIN: ADMIN,
};

export function permissionsFor(role: Role): readonly Permission[] {
  return BY_ROLE[role] ?? [];
}

export function can(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Actions that need an admin to stand at the till and enter their PIN, over
 * and above the signed-in cashier's own permissions. Each of these is written
 * to the audit log with the approver recorded.
 */
export const REQUIRES_ADMIN_APPROVAL: readonly Permission[] = [
  "sale.void",
  "sale.refund",
  "sale.discount.large",
  "product.price",
  "stock.adjust",
  "drawer.open",
];

export function needsAdminApproval(permission: Permission): boolean {
  return REQUIRES_ADMIN_APPROVAL.includes(permission);
}

/**
 * Who can authorise someone else's action. Only an admin — a cashier
 * approving their own void would make the whole approval step theatre.
 */
export function canApprove(role: Role, permission: Permission): boolean {
  return role === "ADMIN" && can(role, permission);
}

export const ROLE_LABELS: Record<Role, string> = {
  CASHIER: "Cashier",
  ADMIN: "Admin",
};

/** Roles that belong in the back office rather than at the counter. */
export function isBackOffice(role: Role): boolean {
  return role === "ADMIN";
}
