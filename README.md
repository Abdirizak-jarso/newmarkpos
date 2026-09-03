# Newmark POS

Point of sale for **Newmark Butchery** — Bishan Plaza, Westlands, Nairobi.

A weight-first till for a halal butchery counter: sells by the kilogram, cuts to a shilling
budget, breaks carcasses down into cuts with recorded loss, prints on 80mm thermal, and
keeps trading when the printer or the scale is unavailable. Runs on Vercel against a Neon
Postgres database — see [Deploying](#deploying-to-vercel--neon) below.

## Getting started

You need a Postgres database to develop against — a free [Neon](https://neon.tech) project
takes a couple of minutes and gives you both connection strings below.

```bash
npm install
cp .env.example .env          # then set DATABASE_URL, DIRECT_DATABASE_URL, SESSION_SECRET,
                               # PIN_PEPPER and TERMINAL_ID
npx prisma migrate dev        # apply migrations to your database
npm run seed                  # load the catalogue, staff and settings
npm run dev
```

Open http://localhost:3000 and sign in.

| Staff code | PIN    | Role       | Lands on     |
| ---------- | ------ | ---------- | ------------ |
| 1000       | 907143 | Owner      | the till     |
| 2000       | 418205 | Manager    | the till     |
| 3000       | 635812 | Supervisor | the till     |
| 4001       | 270496 | Cashier    | the till     |

**Change these PINs before the till goes on a counter** — Admin → Staff.

## What it does

### The till — `/till`

- 47 products from the live shop, colour-coded by category, searchable.
- Weigh a cut and type the figure, **or** type "500 bob" and get the weight to cut to.
  Both are first-class; the receipt records which was asked for.
- Split payments — part M-Pesa, part cash — with change calculated on the cash only.
- Manager PIN prompt for discounts over the shop's threshold.
- Sells with **no network at all**: the basket is priced locally, the sale is banked to an
  IndexedDB outbox, and it syncs when the connection returns. The header says which state
  the till is in and how many sales are waiting.
- The receipt is rendered to ESC/POS at checkout and sent to the printer automatically as
  the sale-complete screen appears. A printer that is off, out of paper or unplugged never
  blocks a sale — the job stays queued, the screen says so plainly rather than claiming it
  printed, and the till clears the backlog itself when the printer comes back.
- With no printer configured, the receipt is shown on screen exactly as it would print.

### The back office — `/admin`

- **Overview** — today's takings, weight sold, what's running low, what's stuck in a queue.
- **Catalogue** — prices, pricing mode and VAT treatment per product. A price change needs
  a manager PIN and records both the old and the new figure.
- **Stock** — receive, write off, and stocktake. Every movement carries a reason and a name.
- **Carcass breakdown** — enter a carcass and the cuts off it; loss updates live as you
  type, the cost is spread across the outputs by weight, and by-products enter stock here.
- **Reports** — takings, payment mix, best sellers, margin by product, and yield per cut so
  an off carcass is visible against the average.
- **Staff** — accounts, roles and PINs. Staff are deactivated, never deleted.
- **Audit log** — append-only, showing the before and after of every consequential action.

## How it is put together

| Concern           | Where                                    |
| ----------------- | ---------------------------------------- |
| Money (cents)     | `lib/money.ts`                           |
| Weight (grams)    | `lib/weight.ts`                          |
| Pricing engine    | `lib/pricing.ts` — pure, client + server |
| Carcass breakdown | `lib/breakdown.ts`                       |
| Permissions       | `lib/permissions.ts`, `lib/session.ts`   |
| Peripherals       | `lib/adapters/`                          |
| Business services | `lib/services/`                          |

Three decisions shape everything else:

**Money is integer cents and weight is integer grams.** No floats anywhere either can
reconcile against the other. There is exactly one rounding rule — round-half-up at the line
— and it lives in one function that the till, the receipt and every report all call.

**Peripherals sit behind adapters with a working manual fallback.** No code path requires a
scale, a printer, a KRA endpoint or Safaricom to be reachable. That is what lets the shop
keep selling on a bad day, and it is what makes the whole thing testable on a laptop.

**The server decides.** The till re-prices nothing it is told; `checkout()` looks every
product up in the catalogue and ignores whatever the browser sent. Permissions are checked
server-side on every mutation.

## Configuration

Everything is in `.env` — see `.env.example`. The defaults run the whole system with no
hardware attached:

```
SCALE_ADAPTER=manual          # or serial
PRINTER_ADAPTER=noop          # or network (raw 9100)
TAX_AUTHORITY_ADAPTER=noop    # or etims
MPESA_ADAPTER=manual          # or daraja
```

`TERMINAL_ID` prefixes this till's receipt numbers (`T1-000412`), so two offline terminals
can never mint the same one.

## Deploying to Vercel + Neon

1. **Push this repo to GitHub, then import it in Vercel** (New Project → your repo).

2. **Connect Neon.** Two ways to do this — pick one:

   - **Vercel's Storage tab → Neon (native integration).** Leave the **custom prefix
     blank**. With no prefix it creates `DATABASE_URL` (pooled) and
     `DATABASE_URL_UNPOOLED` (direct) for you, along with a handful of `PG*`/`POSTGRES_*`
     variables the app doesn't use — `prisma.config.ts` already reads
     `DATABASE_URL_UNPOOLED` as the direct string, so nothing else to set. **If Vercel
     warns that `DATABASE_URL` already exists**, that's because you (or an earlier
     integration attempt) added one by hand — delete that manual `DATABASE_URL` (and any
     `DIRECT_DATABASE_URL`) in Settings → Environment Variables first, then let the
     integration create its own. A custom prefix is only worth setting if you're
     connecting more than one Neon project to this app and need to tell their variables
     apart.

   - **Create the Neon project yourself** (neon.tech) and set the variables by hand in
     Settings → Environment Variables: the **pooled** connection string (host contains
     `-pooler`) → `DATABASE_URL`, the **direct** one (no `-pooler`) → `DIRECT_DATABASE_URL`.

   Either way: the pooled string is what the running app always uses — Vercel's many
   short-lived function instances would exhaust Postgres' connection limit under real load
   without it. The direct string exists only because a migration takes a lock a pooler
   can't hold; `prisma migrate deploy` needs it, the running app never does.

3. **Set the rest of the environment variables**: `SESSION_SECRET`, `PIN_PEPPER`,
   `TERMINAL_ID`, and whichever adapter variables apply (`.env.example` has the full list —
   printer, scale, M-Pesa, eTIMS all default to a working no-hardware setting if you leave
   them unset).

4. **Deploy.** `npm run build` runs `prisma migrate deploy` before `next build`, so the
   first deploy creates every table and each later one applies only what changed.

5. **Seed it once**, from your machine, pointed at the new database:
   ```bash
   DATABASE_URL="<the pooled string from Vercel>" npm run seed
   ```
   This loads the catalogue and the four demo staff PINs in the table above. **Change those
   PINs before the till goes on a real counter** — Admin → Staff.

Every Vercel preview deploy (a PR, a branch) runs against the *same* database unless you
give it its own — there is no branch-per-database wiring here. For a single-till shop that
is usually fine; for a team shipping catalogue changes through PRs, point preview
deployments at a [Neon branch](https://neon.tech/docs/introduction/branching) instead of the
production database.

## Tests

```bash
npm test                 # unit tests — pricing, weight, money, breakdown, receipts, auth
npm run test:integration # integration tests against TEST_DATABASE_URL (a scratch database,
                          # wiped on every run — never point this at the shop's database;
                          # a Neon branch is the easy way to get a throwaway one)
npm run test:all
```

The integration tests exercise the flows that cost a butchery money when they go wrong: a
sale banking twice on an offline replay, stock not moving, a void quietly editing history,
a manager approval that isn't actually checked, a partial refund on a weighed line. They
also stand up a fake thermal printer on a real TCP socket and assert that the bytes of an
actual receipt arrive on it — and that a printer which is switched off costs the shop a
queued job rather than a sale.

## Notes

`products.json` is the live catalogue scraped from newmarkprimemeat.com — 47 products with
their real prices. The seed reads it directly, so a fresh till matches the shop. Re-seeding
never overwrites a price the shop has since changed at the counter, and never resets a PIN.

Open questions (printer and scale models, M-Pesa Till vs Paybill, eTIMS onboarding,
per-category VAT treatment) are tracked at the bottom of `CLAUDE.md` rather than guessed at
in code.
