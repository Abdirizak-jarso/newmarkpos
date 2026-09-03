# Newmark POS

Point of sale for **Newmark Butchery** — Bishan Plaza, Westlands, Nairobi.

A weight-first till for a halal butchery counter: sells by the kilogram, cuts to a shilling
budget, breaks carcasses down into cuts with recorded loss, prints on 80mm thermal, and
keeps trading when the network, the printer or the scale is unavailable.

## Getting started

```bash
npm install
cp .env.example .env          # then set SESSION_SECRET and TERMINAL_ID
npx prisma migrate dev        # create the database
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

## Tests

```bash
npm test                 # 98 unit tests — pricing, weight, money, breakdown, receipts, auth
npm run test:integration # 45 integration tests against a seeded throwaway database
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
