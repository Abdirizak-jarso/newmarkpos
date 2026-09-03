/**
 * Scale access. Every weight in the system arrives through this interface, so
 * no code path can require hardware to be present.
 *
 * ManualScaleAdapter is not a stub to be replaced later — it is the fallback
 * the counter falls back to when the scale is unplugged, its battery is flat,
 * or the serial cable is being borrowed. It must keep working.
 */

import { kgToGrams, type Grams } from "../weight";

export interface ScaleReading {
  grams: Grams;
  /**
   * Whether the reading has settled. An unstable reading may be shown to the
   * cashier but must never be committed to a sale line.
   */
  stable: boolean;
  /** Grams of tare already subtracted by the scale itself. */
  tareGrams: Grams;
  at: Date;
  source: "manual" | "serial" | "network";
}

export interface ScaleStatus {
  connected: boolean;
  adapter: string;
  detail?: string;
}

export interface ScaleAdapter {
  readonly name: string;
  /** Never throws for "no hardware" — check `connected` on the result. */
  status(): Promise<ScaleStatus>;
  /** A settled weight, or null when no stable reading is available. */
  read(): Promise<ScaleReading | null>;
  /** Zero the scale with a container on the platter. */
  tare(): Promise<void>;
}

/**
 * The cashier reads the dial and types the figure. Always available.
 */
export class ManualScaleAdapter implements ScaleAdapter {
  readonly name = "manual";
  private lastEntry: ScaleReading | null = null;

  async status(): Promise<ScaleStatus> {
    return { connected: true, adapter: this.name, detail: "Weights entered by hand" };
  }

  /**
   * There is nothing to poll. The till reads the weight out of its own input
   * field; this returns the last value the cashier submitted, if any.
   */
  async read(): Promise<ScaleReading | null> {
    return this.lastEntry;
  }

  async tare(): Promise<void> {
    this.lastEntry = null;
  }

  /** Called by the till when the cashier types a weight. */
  submit(kg: string | number): ScaleReading {
    const reading: ScaleReading = {
      grams: kgToGrams(kg),
      stable: true,
      tareGrams: 0,
      at: new Date(),
      source: "manual",
    };
    this.lastEntry = reading;
    return reading;
  }
}

/**
 * Serial scale over a USB adapter. Most counter scales sold in Nairobi speak a
 * continuous ASCII protocol close to the Toledo/CAS format:
 *
 *     ST,GS,   1.235kg\r\n     settled gross
 *     US,NT,   0.480kg\r\n     unsettled net
 *
 * The exact model is still an open decision, so the wire format lives in one
 * parser below and the transport is loaded lazily — the module must import
 * cleanly on a machine with no serial port and no serial library installed.
 */
export class SerialScaleAdapter implements ScaleAdapter {
  readonly name = "serial";
  private port: unknown = null;
  private lastLine = "";
  private lastError: string | undefined;

  constructor(
    private readonly path: string,
    private readonly baudRate: number = 9600,
  ) {}

  async status(): Promise<ScaleStatus> {
    await this.ensureOpen();
    return {
      connected: this.port !== null,
      adapter: this.name,
      detail: this.port ? `${this.path} @ ${this.baudRate}` : (this.lastError ?? "not connected"),
    };
  }

  async read(): Promise<ScaleReading | null> {
    await this.ensureOpen();
    if (!this.port || this.lastLine === "") return null;
    return parseScaleLine(this.lastLine);
  }

  async tare(): Promise<void> {
    await this.ensureOpen();
    if (!this.port) return;
    const writable = this.port as { write?: (data: string) => void };
    // "T" is the tare command in every continuous-output protocol we have seen.
    writable.write?.("T\r\n");
  }

  private async ensureOpen(): Promise<void> {
    if (this.port) return;
    try {
      // Optional dependency, resolved through a variable so the build does not
      // require it to be installed. It is absent on the dev machine and on any
      // till whose scale is read by hand, and that must not be an error.
      const specifier = "serialport";
      const mod = (await import(/* webpackIgnore: true */ specifier).catch(() => null)) as
        | { SerialPort: new (opts: { path: string; baudRate: number }) => unknown }
        | null;
      if (!mod) {
        this.lastError = "serialport not installed — using manual entry";
        return;
      }
      const port = new mod.SerialPort({ path: this.path, baudRate: this.baudRate });
      (port as { on?: (event: string, cb: (chunk: Buffer) => void) => void }).on?.("data", (chunk) => {
        const text = chunk.toString("ascii");
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
        if (lines.length > 0) this.lastLine = lines[lines.length - 1]!;
      });
      this.port = port;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.port = null;
    }
  }
}

/** Exported so the wire format can be tested without a scale on the desk. */
export function parseScaleLine(line: string): ScaleReading | null {
  const match = /(-?\d+(?:\.\d+)?)\s*(kg|g)\b/i.exec(line);
  if (!match) return null;
  const value = Number(match[1]);
  const grams = match[2]!.toLowerCase() === "kg" ? kgToGrams(value) : Math.round(value);
  return {
    grams,
    // ST = stable, US = unstable. Anything unrecognised is treated as unstable:
    // committing a moving weight to a sale line overcharges or undercharges.
    stable: /\bST\b/i.test(line),
    tareGrams: 0,
    at: new Date(),
    source: "serial",
  };
}

export function createScaleAdapter(env: NodeJS.ProcessEnv = process.env): ScaleAdapter {
  switch ((env.SCALE_ADAPTER ?? "manual").toLowerCase()) {
    case "serial":
      return new SerialScaleAdapter(
        env.SCALE_SERIAL_PATH ?? "/dev/tty.usbserial",
        Number(env.SCALE_BAUD_RATE ?? 9600),
      );
    case "manual":
    default:
      return new ManualScaleAdapter();
  }
}
