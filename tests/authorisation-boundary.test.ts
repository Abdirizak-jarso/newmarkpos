import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The authorisation boundary.
 *
 * "Permissions are enforced server-side. Hiding a button is not authorisation."
 * That rule is only true while every server entry point actually checks. A new
 * route handler or server action that forgets is invisible: it typechecks, it
 * builds, it works perfectly in testing — because the person testing it is
 * signed in as the admin — and it ships as a hole.
 *
 * So the boundary is checked mechanically rather than by remembering. Every
 * route handler and every server action must reach a gate:
 *
 *   requirePermission      throws, for route handlers and actions
 *   requirePagePermission  redirects, for pages
 *   verifyApprover         the manager-PIN-at-the-till case
 *
 * When something genuinely must be open, it goes in OPEN below with the reason
 * written down, so opening a door is a deliberate act somebody can review.
 */

const ROOT = process.cwd();

const GATES = [
  "requirePermission",
  "requirePagePermission",
  "verifyApprover",
  "getCurrentUser",
];

/** Entry points that are deliberately reachable without a permission. */
const OPEN: Record<string, string> = {
  "app/api/auth/logout/route.ts":
    "Signing out must work for anyone holding a session, including one whose role has since been revoked.",
  "app/login/actions.ts":
    "Signing in is how you get a session; it authenticates rather than authorises, and rate-limits itself.",
};

function walk(dir: string, match: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "generated") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const isGated = (source: string) => GATES.some((gate) => source.includes(gate));

describe("every API route checks who is calling", () => {
  const routes = walk(path.join(ROOT, "app/api"), (f) => f.endsWith("route.ts"));

  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  for (const route of walk(path.join(ROOT, "app/api"), (f) => f.endsWith("route.ts"))) {
    const name = rel(route);
    it(`${name} reaches a permission gate`, () => {
      const source = readFileSync(route, "utf8");
      if (name in OPEN) {
        expect(isGated(source), `${name} is listed as open: ${OPEN[name]}`).toBe(false);
        return;
      }
      expect(isGated(source), `${name} has no permission check`).toBe(true);
    });
  }
});

describe("every server action checks who is calling", () => {
  const actions = walk(path.join(ROOT, "app"), (f) => f.endsWith("actions.ts")).filter((f) =>
    readFileSync(f, "utf8").includes("use server"),
  );

  it("finds the actions", () => {
    expect(actions.length).toBeGreaterThan(3);
  });

  for (const action of walk(path.join(ROOT, "app"), (f) => f.endsWith("actions.ts"))) {
    const name = rel(action);
    it(`${name} reaches a permission gate`, () => {
      const source = readFileSync(action, "utf8");
      if (name in OPEN) return;
      expect(isGated(source), `${name} has no permission check`).toBe(true);
    });
  }
});

describe("every admin page is gated", () => {
  for (const page of walk(path.join(ROOT, "app/admin"), (f) => f.endsWith("page.tsx"))) {
    const name = rel(page);
    it(`${name} checks before it renders`, () => {
      const source = readFileSync(page, "utf8");
      // The admin layout redirects a cashier out of the whole section, but a
      // page carrying figures the cashier may not see states its own rule too.
      expect(isGated(source), `${name} relies entirely on the layout`).toBe(true);
    });
  }
});

/**
 * The audit log is append-only.
 *
 * "lib/audit.ts exposes record and nothing else — no update, no delete, no
 * retention helper." A log somebody can edit is not evidence, and the whole
 * point of recording the approver on a void is that it cannot be tidied away
 * afterwards.
 */
describe("the audit log cannot be rewritten", () => {
  it("exposes no way to change or remove an entry", () => {
    const source = readFileSync(path.join(ROOT, "lib/audit.ts"), "utf8");
    for (const forbidden of ["auditEvent.update", "auditEvent.delete", "auditEvent.upsert"]) {
      expect(source, `lib/audit.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is not edited from anywhere else either", () => {
    const sources = [
      ...walk(path.join(ROOT, "lib"), (f) => f.endsWith(".ts")),
      ...walk(path.join(ROOT, "app"), (f) => f.endsWith(".ts") || f.endsWith(".tsx")),
    ];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of ["auditEvent.update", "auditEvent.delete", "auditEvent.deleteMany"]) {
        expect(source, `${rel(file)} rewrites the audit log`).not.toContain(forbidden);
      }
    }
  });
});

/**
 * Stock never moves anonymously.
 *
 * "Never write product.stockGrams directly" — every change goes through move(),
 * which writes the StockMovement row in the same transaction. A direct write
 * leaves stock that changed with no reason and no actor, and the first anyone
 * knows is a count that will not reconcile.
 */
describe("stock only moves through move()", () => {
  it("has no direct stockGrams write outside the stock service", () => {
    const sources = [
      ...walk(path.join(ROOT, "lib"), (f) => f.endsWith(".ts")),
      ...walk(path.join(ROOT, "app"), (f) => f.endsWith(".ts") || f.endsWith(".tsx")),
    ].filter((f) => rel(f) !== "lib/services/stock.ts");

    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      // A product update that sets stockGrams, anywhere but the stock service.
      expect(
        /product\.update\([^)]*stockGrams/s.test(source),
        `${rel(file)} writes stockGrams without a StockMovement`,
      ).toBe(false);
    }
  });
});
