"use client";

/**
 * The offline outbox.
 *
 * The till is local-first. When the network is down — which at Bishan Plaza is
 * a normal Tuesday, not a disaster — a completed sale is written to IndexedDB
 * and the customer walks out with their meat and their receipt. The outbox
 * drains to the server the moment the connection comes back.
 *
 * Two rules make this safe:
 *
 *   1. Every sale carries a client-generated idempotency key, so replaying the
 *      outbox after a half-successful sync cannot bank the same sale twice.
 *   2. Receipt numbers are minted per terminal with a prefix, so an offline
 *      till never collides with another one.
 */

const DB_NAME = "newmark-pos";
const DB_VERSION = 1;
const STORE = "outbox";

export interface OutboxEntry {
  /** The sale's idempotency key. Also the primary key here. */
  id: string;
  kind: "SALE";
  body: unknown;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => database.close();
  });
}

export async function queueSale(id: string, body: unknown): Promise<void> {
  const entry: OutboxEntry = {
    id,
    kind: "SALE",
    body,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  await withStore("readwrite", (store) => store.put(entry));
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const all = await withStore<OutboxEntry[]>("readonly", (store) => store.getAll() as IDBRequest<OutboxEntry[]>);
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function outboxCount(): Promise<number> {
  try {
    return await withStore<number>("readonly", (store) => store.count());
  } catch {
    // A browser with IndexedDB blocked must not take the till down; it just
    // means this terminal cannot sell offline, which the banner will show.
    return 0;
  }
}

async function removeEntry(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

async function noteFailure(entry: OutboxEntry, error: string): Promise<void> {
  await withStore("readwrite", (store) =>
    store.put({ ...entry, attempts: entry.attempts + 1, lastError: error }),
  );
}

/**
 * What to do with a sale the server has just answered on.
 *
 * The three outcomes are not interchangeable and getting them the wrong way
 * round is how a till loses a day's takings:
 *
 *   keep   — banked. Take it out of the outbox.
 *   drop   — the server has judged it and will judge it the same way forever
 *            (a deleted product, a malformed body). Retrying wedges the whole
 *            queue behind one bad row, so it comes out and is reported loudly.
 *   retry  — the server is broken or unreachable, which says nothing about the
 *            sale. Leave it, stop, and try the whole queue again later.
 *
 * 408 and 429 are the ones worth being careful about: they are 4xx by number
 * but "ask again later" by meaning, so they retry rather than being thrown away.
 */
export type OutboxDisposition = "keep" | "drop" | "retry";

export function outboxDisposition(status: number): OutboxDisposition {
  if (status >= 200 && status < 300) return "keep";
  if (status === 408 || status === 429) return "retry";
  if (status >= 400 && status < 500) return "drop";
  return "retry";
}

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  lastError?: string;
}

/**
 * Push everything in the outbox to the server, oldest first.
 *
 * A 4xx means the server has judged the sale and will keep judging it the same
 * way — retrying forever would wedge the queue behind one bad row, so it is
 * dropped and reported. A 5xx or a network failure is left to try again.
 */
export async function flushOutbox(): Promise<FlushResult> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { sent: 0, failed: 0, remaining: await outboxCount() };
  }

  const entries = await listOutbox();
  let sent = 0;
  let failed = 0;
  let lastError: string | undefined;

  for (const entry of entries) {
    try {
      const response = await fetch("/api/sales", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.body),
      });

      const disposition = outboxDisposition(response.status);

      if (disposition === "keep") {
        await removeEntry(entry.id);
        sent += 1;
        continue;
      }

      const detail = await response.text();

      if (disposition === "drop") {
        // Rejected on its merits. Keep it out of the way but do not lose the
        // fact that it happened — the message names the receipt.
        await removeEntry(entry.id);
        failed += 1;
        lastError = `Sale rejected by the server: ${detail.slice(0, 200)}`;
        console.error("[outbox] dropped rejected sale", entry.id, detail);
        continue;
      }

      await noteFailure(entry, detail.slice(0, 200));
      failed += 1;
      lastError = "Server error — will retry";
      break;
    } catch (error) {
      // Still offline. Stop; the next online event will call this again.
      lastError = error instanceof Error ? error.message : String(error);
      await noteFailure(entry, lastError);
      break;
    }
  }

  return { sent, failed, remaining: await outboxCount(), lastError };
}

/** Client-side idempotency key. Also becomes the sale's primary key. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
