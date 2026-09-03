import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The client/server boundary.
 *
 * A "use client" component that imports a module using `node:crypto` compiles
 * without complaint and then throws at module evaluation in the browser — the
 * bundler substitutes an empty stub, `scrypt` is undefined, and `promisify`
 * blows up before the page renders. Nothing in typecheck or build catches it.
 *
 * So it is checked here. The rule: modules that touch node builtins are
 * server-only, and anything a client component needs from them belongs in a
 * pure module (lib/pin.ts is the PIN example).
 */

const ROOT = process.cwd();

/** Modules that must never end up in the browser bundle. */
const SERVER_ONLY = [
  "@/lib/auth",
  "@/lib/db",
  "@/lib/session",
  "@/lib/audit",
  "@/lib/settings",
  "@/lib/receipt-number",
  "@/lib/services/",
  "@/lib/adapters/printer",
  "@/lib/adapters/scale",
  "@/lib/adapters/tax-authority",
  "@/lib/adapters/payments",
];

const NODE_BUILTINS = /from\s+"node:(crypto|fs|net|util|path|os|child_process)"/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "generated") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = [path.join(ROOT, "app"), path.join(ROOT, "components"), path.join(ROOT, "lib")]
  .flatMap((dir) => walk(dir))
  .map((file) => ({ file: path.relative(ROOT, file), source: readFileSync(file, "utf8") }));

const clientComponents = sourceFiles.filter(({ source }) =>
  /^\s*["']use client["']/m.test(source),
);

describe("client components", () => {
  it("exist, so this suite is actually checking something", () => {
    expect(clientComponents.length).toBeGreaterThan(5);
  });

  it("never import a server-only module for its VALUES", () => {
    const offenders: string[] = [];

    for (const { file, source } of clientComponents) {
      for (const line of source.split("\n")) {
        // `import type { X } from "..."` is erased at compile time and never
        // reaches the bundle, so it is safe and common — a client component
        // legitimately needs the shape of a server type. Only value imports
        // pull the module in.
        if (/^\s*import\s+type\s/.test(line)) continue;

        for (const module of SERVER_ONLY) {
          if (line.includes(`from "${module}`)) {
            offenders.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }

    // The failure this guards: LoginPad importing lib/auth for the PIN length
    // constants, which pulled node:crypto into the browser and threw
    // "The original argument must be of type Function" before the page drew.
    expect(offenders).toEqual([]);
  });

  it("never import a node builtin directly", () => {
    const offenders = clientComponents
      .filter(({ source }) => NODE_BUILTINS.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

describe("lib/pin", () => {
  it("stays free of node builtins, because client components depend on it", () => {
    const source = readFileSync(path.join(ROOT, "lib/pin.ts"), "utf8");
    expect(NODE_BUILTINS.test(source)).toBe(false);
    expect(source).not.toContain("process.env");
  });
});
