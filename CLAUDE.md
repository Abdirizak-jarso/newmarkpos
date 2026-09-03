# CLAUDE.md

Project guidance for AI assistants working in this repository.

## What this is

A point-of-sale system for **Newmark Butchery** (Newmark Prime Meat) — a premium halal
butchery at Bishan Plaza, Westlands, Nairobi, Kenya. It runs the physical shop counter:
weight-based sales, thermal receipt printing, stock in kilograms, and back-office
administration. A separate e-commerce site already exists at newmarkprimemeat.com.

There are two distinct surfaces in one codebase:

- **Till (cashier)** — touch-optimised, speed-first, resilient to a dropped request (not to
  a counter with no internet at all — see Offline, below). `app/till`
- **Admin (back office)** — catalogue, pricing, stock, staff, reports, audit. `app/admin`

## Domain rules — read these before writing any business logic

These are the rules that make this a butchery POS rather than a generic retail POS. Do not
work around them.

### Weight

- Products are priced **per kilogram**. `line_total = price_per_kg × weight_kg`.
- Weight is stored to **3 decimal places** (gram precision). Never round to 2 dp.
  Internally weight is an integer number of grams — see `lib/weight.ts`.
- Three pricing modes exist and all three must be handled everywhere a line item is
  processed: `PER_KG`, `PER_PIECE`, `FIXED_PACK`. A per-piece or fixed-pack product still
  moves stock in kilograms, via its `unitWeightGrams`.
- **The till quotes no prices.** The product grid names cuts and says how each one sells
  (by the kilo, each, by the pack); the cashier types the **rate and the quantity** on the
  entry pad for every line. `line_total = typed_rate × weight`. The catalogue price is a
  reference — offered as one tap on the pad ("board price"), never prefilled.
- Cashiers can enter a **shilling amount** and have the weight back-calculated
  (`weightForAmount`), at the rate they just typed. This is a primary flow, not an edge
  case — it is a tab on the till's entry pad, not a hidden option.
- Scale access always goes through the `ScaleAdapter` interface. `ManualScaleAdapter` must
  remain a working fallback — no code path may require hardware to be present.

### Money

- Currency is KSh. **Store all money as integer cents.** Floats for money are a bug.
- Rounding rule: round-half-up at the line-item level, then sum lines. It lives in one
  place (`lib/money.ts`) and is used by the till, the receipt, and every report. If you
  find yourself rounding somewhere else, you're introducing a discrepancy.
- Optional cash rounding to the nearest 5 shillings is a setting, shown as its own line.
- Prices are quoted **VAT-inclusive**, so tax is extracted with `taxFromInclusive`, not
  added on top.

### Stock

- Stock is tracked in **kilograms**, not units.
- **Carcass breakdown** converts a bulk intake into multiple products with a recorded
  yield and a shrinkage/loss percentage. Yields never sum to the input weight — loss is
  expected and must be recorded, not silently discarded. `lib/breakdown.ts`
- The carcass cost is spread across the outputs by weight, so shrinkage correctly makes
  every recovered cut dearer instead of vanishing.
- By-products (Soup Bones, Meaty Bones, Cat Food) come out of breakdown, not purchasing.
- Every stock movement has a reason code and an actor. Nothing changes stock anonymously —
  all writes go through `move()` in `lib/services/stock.ts`, which writes the
  `StockMovement` row in the same transaction. Never write `product.stockGrams` directly.
- Selling below zero is allowed. The meat physically left the shop; a negative balance is
  the signal that the count is wrong, not something to hide by refusing a sale in front of
  a customer.

### Tax

- VAT is **configurable per product** (exempt / zero-rated / standard). Never hard-code a
  single rate across the catalogue — meat categories are treated differently and the
  correct treatment is the owner's accountant's call, not ours. The seed marks everything
  `EXEMPT` as a starting position; that is a placeholder, not an answer.
- Invoicing is designed for **KRA eTIMS**. All tax-authority interaction goes through
  `TaxAuthorityAdapter`; the no-op implementation must keep the shop trading. Submission
  happens after the sale, from `POST /api/etims/flush`, never inside checkout.

### Printing

- 80mm ESC/POS thermal is the target; 58mm supported via a width setting.
- All printing goes through the `ReceiptPrinter` interface.
- **A printer failure must never block or roll back a sale.** Queue the job, surface a
  retry, let the cashier carry on. Nothing in `lib/adapters/printer.ts` throws at its
  caller; `print()` resolves with a result the till can display.
- Checkout only *queues* the receipt. `POST /api/print/flush` drains the queue, and it is
  called automatically when the sale-complete screen appears and again whenever the till
  regains a connection — nobody is going to press retry on yesterday's stuck receipts.
- `drainPrintQueue` stops at the first failure rather than working through the queue. The
  printer is down, not that one job; burning every job's retry budget against a printer
  that is switched off is how a backlog becomes unrecoverable.
- The flush response carries `connected`, so the till can distinguish "printed" from
  "there is no printer". `NoopPrinter` reports success — the queue must drain rather than
  grow forever — but telling a cashier "printed" when no paper came out is a lie they
  will act on in front of a customer.

### Offline

- **This deployment runs against a remote Postgres database (Neon), on a counter with
  internet.** The till is no longer local-first in the original sense — there is no
  per-terminal SQLite file, and a terminal with no network at all cannot load the till or
  sign in. What survives is resilience to a *dropped request*, which is a different and
  smaller guarantee than "sells with no network":
  - Sales are priced client-side by the same pure `priceSale` the server uses, banked to an
    IndexedDB outbox (`lib/offline.ts`) when a checkout request fails, and replayed to
    `POST /api/sales` when it succeeds.
  - Every sale carries a client-generated **idempotency key**, which becomes the sale's
    primary key. A replayed sync must never bank the same sale twice.
  - Receipt numbers carry a per-terminal prefix so terminals can never collide, offline
    outbox or not.
- The original single-SQLite-file-per-terminal design (true offline trading, `SyncQueue`
  draining to a central server) is preserved in git history and in
  `prisma/migrations-sqlite/` for whichever shop needs it later — it is not what is running
  now. See Stack, below.

### Authorisation

- Voids, refunds, discounts above a threshold, catalogue price changes and stock
  adjustments all require a manager PIN and are logged with actor, timestamp and
  before/after values. A price typed at the till is the exception — logged, never gated.
- Permissions are enforced **server-side**. Hiding a button is not authorisation.
  - `requirePermission` (throws → 403) for every server action and route handler.
  - `requirePagePermission` (redirects) for pages, so a cashier who follows a link into
    the back office lands back at the till rather than on an error.
  - `verifyApprover` for the manager-PIN-at-the-till case; the approver is never signed in.
- A typed rate is the **one** price figure the client may send, and it travels in its own
  field (`unitPriceOverride`). Everything else about money — line totals, the subtotal,
  tax, change — `checkout()` recomputes from the catalogue and the typed rate, and
  whatever the browser claimed is discarded. There is no path by which a price arrives
  *silently*.
- Every line records both rates: `SaleLine.unitPrice` is what was charged,
  `catalogueUnitPrice` is what the board said, and `priceOverridden` marks the difference.
  A receipt reprinted next month shows the rate the customer actually paid.
- **A typed rate needs no approval, in either direction.** The counter sets its own
  prices, so a PIN in front of every line would be a PIN in front of every sale. Nothing
  blocks a rate; every one is written to the audit log as `SALE_PRICE_OVERRIDE`, one
  record per line, carrying the board rate, the rate charged and the gap between them.
  **That log is now the only control on counter pricing** — the review happens in the
  evening instead of at the counter, so a change that stops those records being written
  removes the last thing standing between the shop and a cut sold at half price.
- No approver is ever recorded on a price. A sale can carry an approved discount on one
  line and a typed rate on another; the discount's approver must not leak onto the price
  record, or it reads for ever as an admin having signed off a price they never saw.
- Discounts are still gated. `reductionNeedsApproval` in `lib/pricing.ts` is that rule and
  it governs discounts only; it is pure so the till and the server ask the same question —
  the till so a manager is fetched while they are still standing there, the server because
  that is what actually enforces it.
- The audit log is append-only. `lib/audit.ts` exposes `record` and nothing else — no
  update, no delete, no retention helper.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript (strict) + Tailwind v4, deployed to Vercel.
- Prisma 7 with the `@prisma/adapter-neon` driver adapter, over **Postgres (Neon)**. The
  connection lives in `prisma.config.ts` and `lib/db.ts`, not the schema (Prisma 7 moved it).
- `DATABASE_URL` must be Neon's **pooled** connection string (`-pooler` in the host) — a
  Vercel function is a short-lived process spun up by the hundred, and without the pooler
  that exhausts Postgres' connection limit under real load. `DIRECT_DATABASE_URL` (no
  `-pooler`) is for migrations only: a pooler cannot hold the advisory lock
  `prisma migrate deploy` takes. `npm run build` runs `migrate deploy` before `next build`,
  so a deploy that adds a column never serves a page against a schema that lacks it.
- `lib/db.ts` builds the Prisma client lazily, on first use, not at import — `next build`
  imports every server module to collect routes, and a build machine legitimately has no
  database. A missing `DATABASE_URL` still throws loudly, the first time anything queries.
- This was originally a one-SQLite-file-per-terminal design (see Offline, above, and
  `prisma/migrations-sqlite/` for that history). The models were written to be portable and
  this is that port, done because the counter has internet — not a change forced by Vercel.
- Vitest for unit and integration tests. Integration tests need their own scratch Postgres
  database in `TEST_DATABASE_URL` (a Neon branch is the easy way to get one) — it is wiped
  on every run, so it must never be the shop's database.

## Commands

```bash
npm run dev              # start dev server (needs DATABASE_URL — a real Postgres/Neon)
npm run build            # prisma generate && prisma migrate deploy && next build
npm run build:nodb       # prisma generate && next build — compiles with no DATABASE_URL
npm run typecheck        # tsc --noEmit
npm run lint             # lint

npm test                 # unit tests — pure domain logic, no database
npm run test:integration # integration tests, against TEST_DATABASE_URL (scratch, wiped)
npm run test:all         # both

npx prisma migrate dev   # create and apply a migration (needs DIRECT_DATABASE_URL)
npm run db:deploy        # apply pending migrations without prompting (what build runs)
npm run db:studio        # browse the data
npm run seed             # seed catalogue, staff and settings
```

Demo staff (seeded — change the PINs before the till goes on the counter):

| Code | PIN    | Role       |
| ---- | ------ | ---------- |
| 1000 | 907143 | Owner      |
| 2000 | 418205 | Manager    |
| 3000 | 635812 | Supervisor |
| 4001 | 270496 | Cashier    |

## Layout

```
lib/money.ts              integer cents, the one rounding rule
lib/weight.ts             integer grams, 3 dp, amount→weight back-calculation
lib/pricing.ts            the pricing engine — pure, shared by client and server
lib/breakdown.ts          carcass yields, loss, cost allocation
lib/permissions.ts        roles and what each may do
lib/session.ts            sessions and the real authorisation gates
lib/audit.ts              append-only audit writes
lib/adapters/             scale, printer, ESC/POS, eTIMS, M-Pesa
lib/services/             checkout, sales (void/refund/reprint), stock, reports
app/till/                 the counter
app/admin/                the back office
app/api/                  checkout, void, refund, reprint, scale, print, sync, eTIMS
```

## Conventions

- TypeScript strict mode. No `any` in domain code.
- Money: `lib/money.ts`. Weight: `lib/weight.ts`. Do not reimplement either inline.
- Server-side validation with Zod on every mutation, regardless of client validation.
  Schemas live in `lib/validation.ts`.
- Hardware and third-party services sit behind adapter interfaces with a null/manual
  implementation. This is what keeps the system testable and keeps the shop trading when
  something is unplugged.
- Migrations are checked in. Never edit an applied migration.
- Secrets in `.env`, never committed. `.env.example` stays current.
- The pricing engine is pure — no database, no clock, no I/O. Keep it that way; it is what
  lets the till price a basket offline and what makes the arithmetic testable.

## Testing expectations

Any change touching these needs a test:

- money rounding and line-total arithmetic
- weight precision and shilling-amount back-calculation
- carcass yield and shrinkage
- split payments and change due
- the full checkout flow

Unit tests (`tests/`) cover the pure domain. Integration tests (`tests/integration/`) run
against a real seeded database and cover the flows that lose money when they go wrong: the
sale banking twice, stock not moving, a void quietly editing history, an approval that
isn't actually checked.

## Things not to do

- Don't use floating-point arithmetic for money.
- Don't round weight to 2 decimal places.
- Don't assume a scale or printer is connected.
- Don't hard-code a VAT rate.
- Don't let a sale fail because a peripheral or the network failed.
- Don't add client-only permission checks.
- Don't trust a total or tax figure sent by the client — recompute both. A typed rate is
  the single exception, and only through `unitPriceOverride`, and only recorded next to
  the catalogue rate it replaced.
- Don't put an approval step back in front of a typed price without being asked; the shop
  removed it deliberately. Do not weaken the audit record that replaced it either.
- Don't reintroduce shifts, cash-up, X/Z-reports, cash events or drawer variance. They were
  removed deliberately; a sale belongs to a cashier and a terminal, not to a shift. Takings
  are reported over a date range (`salesSummary`), not per shift.
- Don't delete or mutate audit records.
- Don't write `product.stockGrams` without a matching `StockMovement`.
- Don't change the catalogue prices in seed data without saying so — they mirror the
  live shop (`products.json`, scraped from newmarkprimemeat.com).

## Open decisions

Track unresolved choices here rather than guessing in code:

- Printer model and connection method — `NetworkPrinter` (raw 9100) is written and
  untested against real hardware; `PRINTER_ADAPTER=noop` until one is on the counter.
- Scale model and interface — `SerialScaleAdapter` parses the common continuous-ASCII
  format in one function (`parseScaleLine`); confirm against the actual scale.
- M-Pesa: Till vs Paybill, Daraja API access. `MPESA_ADAPTER=manual` until confirmed.
- Number of till terminals — `SYNC_ENDPOINT` is unset, so each till keeps its own records.
- eTIMS integration status and KRA PIN.
- Confirmed per-category VAT treatment — everything is seeded `EXEMPT` as a placeholder.
- Whether the POS shares a catalogue and stock with the website.
- Whether the catalogue price should stay on the entry pad at all. It is currently offered
  as a one-tap "board price" hint so the common case is fast; removing it is one block in
  `components/till/EntryPad.tsx` if the shop would rather the cashier never saw a figure
  they did not type.
- Which products are genuinely `PER_PIECE` / `FIXED_PACK` — only Whole Chicken and the
  1.5 kg Prime Combo are marked so far, and the combo's pack price (KSh 975) is a guess.
