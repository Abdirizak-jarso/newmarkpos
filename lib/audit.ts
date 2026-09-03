import "server-only";
import { db } from "./db";

/**
 * The audit log.
 *
 * Append-only: this module exposes `record` and nothing else. There is no
 * update, no delete, and no "clean up old events" helper — if one is ever
 * added, the log stops being evidence. Retention is a database-level decision
 * for the owner and their accountant, not something the app does quietly.
 *
 * Both the before and after values are kept. An entry that only records the
 * new price cannot answer "what did they change it from", which is the whole
 * question when stock walks out of a butchery.
 */

export type AuditAction =
  | "VOID_SALE"
  | "REFUND"
  | "LINE_DISCOUNT"
  | "SALE_DISCOUNT"
  /** A rate typed at the counter instead of taken from the catalogue. */
  | "SALE_PRICE_OVERRIDE"
  | "RECEIPT_REPRINT"
  | "RECORD_MPESA_CODE"
  | "PRICE_CHANGE"
  | "PRODUCT_CREATED"
  | "PRODUCT_EDITED"
  | "STOCK_INTAKE"
  | "STOCK_ADJUSTMENT"
  | "STOCK_WASTE"
  | "STOCK_COUNT"
  | "BREAKDOWN"
  | "USER_CREATED"
  | "ROLE_CHANGED"
  | "PIN_CHANGED"
  | "USER_DEACTIVATED"
  | "SETTING_CHANGED"
  | "LOGIN"
  | "LOGIN_FAILED"
  | "DRAWER_OPENED";

export interface AuditInput {
  action: AuditAction;
  entity: string;
  entityId?: string;
  /** Values before the change. Omit for a creation. */
  before?: unknown;
  /** Values after the change. Omit for a deletion. */
  after?: unknown;
  actorId: string;
  /** The manager who authorised it, when the action needed a PIN. */
  approverId?: string;
  reason?: string;
  terminalId?: string;
}

/**
 * Write an audit event.
 *
 * Never let an audit write take down the operation it is recording *silently*:
 * a failure here is logged loudly to the server console and rethrown for
 * mutations that must not proceed unrecorded (voids, price changes), while
 * `recordSafely` exists for the incidental ones (a login) where losing the
 * line is preferable to blocking the counter.
 */
export async function record(input: AuditInput): Promise<void> {
  await db.auditEvent.create({
    data: {
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      before: input.before === undefined ? null : JSON.stringify(input.before, redactSecrets),
      after: input.after === undefined ? null : JSON.stringify(input.after, redactSecrets),
      actorId: input.actorId,
      approverId: input.approverId,
      reason: input.reason,
      terminalId: input.terminalId ?? process.env.TERMINAL_ID ?? null,
    },
  });
}

export async function recordSafely(input: AuditInput): Promise<void> {
  try {
    await record(input);
  } catch (error) {
    console.error("[audit] failed to record", input.action, error);
  }
}

/**
 * PIN hashes and session tokens must never reach the audit log — it is the one
 * table people are given broad read access to.
 */
const SECRET_KEYS = new Set(["pin", "pinHash", "pinSalt", "token", "password", "passkey", "consumerSecret"]);

function redactSecrets(key: string, value: unknown): unknown {
  return SECRET_KEYS.has(key) ? "[redacted]" : value;
}
