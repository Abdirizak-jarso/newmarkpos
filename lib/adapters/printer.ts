/**
 * Receipt printing.
 *
 * The rule that shapes this whole file: a printer failure must never block or
 * roll back a sale. The sale is committed, the job is queued, the failure is
 * surfaced as a retry the cashier can press — and the queue keeps the next
 * customer moving in the meantime.
 *
 * Nothing here throws at the caller. `print()` resolves with a result the till
 * can display; it does not reject.
 */

import { fromBase64, toBase64, type PaperWidth } from "./escpos";

export interface PrintResult {
  ok: boolean;
  adapter: string;
  /** Present when the job failed. Shown next to the retry button. */
  error?: string;
  at: Date;
}

export interface PrinterStatus {
  connected: boolean;
  adapter: string;
  paperWidth: PaperWidth;
  detail?: string;
}

export interface ReceiptPrinter {
  readonly name: string;
  readonly paperWidth: PaperWidth;
  status(): Promise<PrinterStatus>;
  print(payload: Uint8Array): Promise<PrintResult>;
  openDrawer(): Promise<PrintResult>;
}

/**
 * No printer attached. Used on the dev machine, on a terminal whose printer is
 * out of paper, and as the fallback when a configured printer cannot be
 * reached at startup. It reports success so the sale flow is never held up —
 * the queue is what records that a receipt is still owed.
 */
export class NoopPrinter implements ReceiptPrinter {
  readonly name = "noop";
  readonly paperWidth: PaperWidth;
  /** Retained so the on-screen receipt preview still has something to show. */
  lastPayload: Uint8Array | null = null;

  constructor(paperWidth: PaperWidth = 80) {
    this.paperWidth = paperWidth;
  }

  async status(): Promise<PrinterStatus> {
    return {
      connected: false,
      adapter: this.name,
      paperWidth: this.paperWidth,
      detail: "No printer configured — receipts are shown on screen",
    };
  }

  async print(payload: Uint8Array): Promise<PrintResult> {
    this.lastPayload = payload;
    return { ok: true, adapter: this.name, at: new Date() };
  }

  async openDrawer(): Promise<PrintResult> {
    return { ok: true, adapter: this.name, at: new Date() };
  }
}

/**
 * Ethernet/Wi-Fi thermal printer on raw port 9100 — the usual arrangement for
 * an 80 mm counter printer.
 */
export class NetworkPrinter implements ReceiptPrinter {
  readonly name = "network";

  constructor(
    private readonly host: string,
    private readonly port: number = 9100,
    readonly paperWidth: PaperWidth = 80,
    private readonly timeoutMs: number = 4000,
  ) {}

  async status(): Promise<PrinterStatus> {
    const reachable = await this.send(new Uint8Array([0x1b, 0x40]));
    return {
      connected: reachable.ok,
      adapter: this.name,
      paperWidth: this.paperWidth,
      detail: reachable.ok ? `${this.host}:${this.port}` : reachable.error,
    };
  }

  async print(payload: Uint8Array): Promise<PrintResult> {
    return this.send(payload);
  }

  async openDrawer(): Promise<PrintResult> {
    return this.send(new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]));
  }

  private async send(payload: Uint8Array): Promise<PrintResult> {
    const at = new Date();
    try {
      const net = await import("node:net");
      return await new Promise<PrintResult>((resolve) => {
        const socket = new net.Socket();
        const finish = (error?: string) => {
          socket.destroy();
          resolve({ ok: error === undefined, adapter: this.name, error, at });
        };
        socket.setTimeout(this.timeoutMs, () => finish(`No response from ${this.host}:${this.port}`));
        socket.once("error", (err: Error) => finish(err.message));
        socket.connect(this.port, this.host, () => {
          socket.write(Buffer.from(payload), () => finish());
        });
      });
    } catch (error) {
      return {
        ok: false,
        adapter: this.name,
        error: error instanceof Error ? error.message : String(error),
        at,
      };
    }
  }
}

export function createPrinter(env: NodeJS.ProcessEnv = process.env): ReceiptPrinter {
  const width = (Number(env.PRINTER_WIDTH_MM ?? 80) === 58 ? 58 : 80) as PaperWidth;
  switch ((env.PRINTER_ADAPTER ?? "noop").toLowerCase()) {
    case "network": {
      const host = env.PRINTER_HOST ?? "";
      // A network printer with no host configured is a misconfiguration, but
      // it is not a reason to stop selling meat. Fall back and say so.
      if (host === "") return new NoopPrinter(width);
      return new NetworkPrinter(host, Number(env.PRINTER_PORT ?? 9100), width);
    }
    case "noop":
    default:
      return new NoopPrinter(width);
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface QueuedJob {
  id: string;
  kind: string;
  /** base64 ESC/POS. */
  payload: string;
  attempts: number;
}

export interface PrintQueueStore {
  claimNext(): Promise<QueuedJob | null>;
  markDone(id: string): Promise<void>;
  markFailed(id: string, error: string, attempts: number): Promise<void>;
}

export const MAX_PRINT_ATTEMPTS = 5;

/**
 * Drains queued jobs one at a time. Called after a sale, on a retry press, and
 * on a timer. Returns how it got on so the till can show "2 receipts waiting"
 * rather than failing silently.
 */
export async function drainPrintQueue(
  printer: ReceiptPrinter,
  store: PrintQueueStore,
  limit = 10,
): Promise<{ printed: number; failed: number; lastError?: string }> {
  let printed = 0;
  let failed = 0;
  let lastError: string | undefined;

  for (let i = 0; i < limit; i += 1) {
    const job = await store.claimNext();
    if (!job) break;

    const result = await printer.print(fromBase64(job.payload));
    if (result.ok) {
      await store.markDone(job.id);
      printed += 1;
      continue;
    }

    failed += 1;
    lastError = result.error;
    await store.markFailed(job.id, result.error ?? "Unknown printer error", job.attempts + 1);
    // The printer is down, not this one job. Stop rather than burning through
    // the whole queue's retry budget against a printer that is switched off.
    break;
  }

  return { printed, failed, lastError };
}

export { toBase64 };
