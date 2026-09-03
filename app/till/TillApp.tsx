"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  lineDiscountAmount,
  lineGross,
  priceSale,
  reductionNeedsApproval,
  type CartLineInput,
} from "@/lib/pricing";
import { formatCents } from "@/lib/money";
import { flushOutbox, newIdempotencyKey, outboxCount, queueSale } from "@/lib/offline";
import type { CurrentUser } from "@/lib/session";
import { ProductGrid } from "@/components/till/ProductGrid";
import { Cart } from "@/components/till/Cart";
import { EntryPad } from "@/components/till/EntryPad";
import { PaymentPad } from "@/components/till/PaymentPad";
import { ManagerPinDialog } from "@/components/till/ManagerPinDialog";
import { SaleComplete } from "@/components/till/SaleComplete";
import { TillHeader } from "@/components/till/TillHeader";
import { MpesaCodeQueue } from "@/components/till/MpesaCodeQueue";
import type {
  CheckoutResponse,
  ManagerApproval,
  TillCategory,
  TillLine,
  TillProduct,
  TillSettings,
  TillTender,
} from "./types";

type Screen = "SELLING" | "PAYING" | "DONE";

export function TillApp({
  user,
  terminalId,
  products,
  categories,
  settings,
  parkedCount,
  pendingPrints,
  awaitingCodes,
}: {
  user: CurrentUser;
  terminalId: string;
  products: TillProduct[];
  categories: TillCategory[];
  settings: TillSettings;
  parkedCount: number;
  pendingPrints: number;
  awaitingCodes: number;
}) {
  const [lines, setLines] = useState<TillLine[]>([]);
  const [screen, setScreen] = useState<Screen>("SELLING");
  const [entryProduct, setEntryProduct] = useState<TillProduct | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [result, setResult] = useState<CheckoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  // Kept in state rather than read from the prop alone, so clearing a code
  // updates the lamp without a round trip through the server.
  const [waitingForCodes, setWaitingForCodes] = useState(awaitingCodes);
  const [showCodeQueue, setShowCodeQueue] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<{
    reason: string;
    onApprove: (approval: ManagerApproval) => void;
  } | null>(null);

  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  /**
   * A basket line as the pricing engine wants it.
   *
   * One place builds this, so the figure on the readout, the figure the
   * approval gate measures and the figure the server recomputes are all the
   * same arithmetic rather than three hand-rolled multiplications that drift.
   */
  const toPricingInput = useCallback(
    (line: TillLine, product: TillProduct): CartLineInput => ({
      lineId: line.lineId,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      pricingMode: product.pricingMode,
      // The board rate, always. What the cashier typed rides alongside it, so
      // the gap between the two stays visible right through to the audit log.
      unitPrice: product.price,
      unitPriceOverride: line.unitPriceOverride,
      weightGrams: line.weightGrams,
      quantity: line.quantity,
      unitWeightGrams: product.unitWeightGrams ?? undefined,
      taxClass: product.taxClass,
      discount: line.discount,
      requestedAmount: line.requestedAmount,
      notes: line.notes,
    }),
    [],
  );

  // --- Pricing --------------------------------------------------------------
  // The same pure function the server uses. The client's figure is what the
  // customer is shown; the server's is what they are charged, and they agree
  // because it is one implementation, not two.
  const totals = useMemo(() => {
    const inputs: CartLineInput[] = lines.flatMap((line) => {
      const product = productsById.get(line.productId);
      return product ? [toPricingInput(line, product)] : [];
    });

    try {
      return priceSale(inputs, {
        standardVatRatePercent: settings.standardVatRatePercent,
        cashRoundingStep: settings.cashRoundingStep,
      });
    } catch {
      // A half-entered line (a per-kg product with no weight yet) is normal
      // mid-basket; show an empty total rather than crashing the till.
      return null;
    }
  }, [lines, productsById, settings, toPricingInput]);

  // --- Connectivity ---------------------------------------------------------
  useEffect(() => {
    const refresh = async () => setQueued(await outboxCount());
    const goOnline = async () => {
      setOnline(true);
      const flushed = await flushOutbox();
      setQueued(flushed.remaining);
      if (flushed.sent > 0) {
        setError(null);
      }
      // Receipts stack up behind a printer that was switched off or out of
      // paper. Nobody is going to go and press retry on yesterday's sales, so
      // the till clears the backlog itself whenever it has a connection.
      void fetch("/api/print/flush", { method: "POST" }).catch(() => {});
    };
    const goOffline = () => setOnline(false);

    setOnline(navigator.onLine);
    void refresh();
    if (navigator.onLine) void goOnline();

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // Also retry on a timer: "online" fires when the interface comes up, which
    // is not the same as the shop's router having a route to the internet.
    const timer = setInterval(() => {
      if (navigator.onLine) void goOnline();
    }, 60_000);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      clearInterval(timer);
    };
  }, []);

  // --- Basket ---------------------------------------------------------------
  const addLine = useCallback((line: TillLine) => {
    setLines((current) => [...current, line]);
    setEntryProduct(null);
    setEditingLineId(null);
    setError(null);
  }, []);

  const updateLine = useCallback((lineId: string, patch: Partial<TillLine>) => {
    setLines((current) => current.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l)));
    setEntryProduct(null);
    setEditingLineId(null);
  }, []);

  const removeLine = useCallback((lineId: string) => {
    setLines((current) => current.filter((l) => l.lineId !== lineId));
  }, []);

  const clearBasket = useCallback(() => {
    setLines([]);
    setScreen("SELLING");
    setResult(null);
    setError(null);
  }, []);

  /**
   * Discounts above the shop's threshold need a manager standing at the till.
   * The client asks for the PIN; the server verifies it. Skipping this dialog
   * by editing the page gets you a rejected checkout, not a discount.
   */
  /**
   * Is this discount the cashier's to make, or an admin's?
   *
   * Discounts only — a rate typed on the entry pad goes through unasked. The
   * rule itself is the server's, imported rather than restated here, because
   * two copies of it would eventually disagree and the one that disagreed
   * would be the one letting money out of the shop. The server asks it again
   * over the whole basket before it banks anything; this asks it early, so the
   * manager is fetched while the customer is still at the counter rather than
   * after the payment pad has already been filled in.
   */
  const needsManagerFor = useCallback(
    (amount: number, catalogueGross: number) =>
      reductionNeedsApproval(amount, catalogueGross, settings),
    [settings],
  );

  const applyDiscount = useCallback(
    (lineId: string, discount: TillLine["discount"]) => {
      const line = lines.find((l) => l.lineId === lineId);
      const product = line ? productsById.get(line.productId) : undefined;
      if (!line || !product || !discount) return;

      const input = toPricingInput(line, product);
      let charged = 0;
      try {
        charged = lineGross(input);
      } catch {
        // Half-entered line — there is nothing to discount yet.
        return;
      }

      // Measured against the line as priced at the counter, because that is
      // the figure the discount actually comes off.
      const amount = lineDiscountAmount(charged, discount);

      if (!needsManagerFor(amount, charged)) {
        updateLine(lineId, { discount });
        return;
      }

      setApprovalRequest({
        reason: `Discount of ${formatCents(amount, { symbol: true })} on ${product.name}`,
        onApprove: (approval) => {
          updateLine(lineId, { discount });
          setPendingApproval(approval);
          setApprovalRequest(null);
        },
      });
    },
    [lines, productsById, needsManagerFor, toPricingInput, updateLine],
  );

  // Held only until the sale is sent, then discarded. Never persisted.
  const [pendingApproval, setPendingApproval] = useState<ManagerApproval | null>(null);

  // --- Checkout -------------------------------------------------------------
  const completeSale = useCallback(
    async (tenders: TillTender[], customer: { name?: string; phone?: string; pin?: string }) => {
      if (!totals || lines.length === 0) return;
      setBusy(true);
      setError(null);

      const idempotencyKey = newIdempotencyKey();
      const body = {
        lines: lines.map((line) => ({
          lineId: line.lineId,
          productId: line.productId,
          unitPriceOverride: line.unitPriceOverride,
          weightGrams: line.weightGrams,
          quantity: line.quantity,
          requestedAmount: line.requestedAmount,
          discount: line.discount,
          notes: line.notes,
        })),
        tenders,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerPin: customer.pin,
        approval: pendingApproval ?? undefined,
        idempotencyKey,
        offlineAt: new Date().toISOString(),
      };

      try {
        const response = await fetch("/api/sales", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const detail = await response.json().catch(() => ({ error: "Checkout failed" }));
          // A 4xx is the server's judgement — a bad discount, a product pulled
          // from sale. Show it; do not queue it and pretend the sale went
          // through, because the customer is still standing there.
          setError(detail.error ?? "Checkout failed");
          setBusy(false);
          return;
        }

        const completed = (await response.json()) as CheckoutResponse;
        setResult(completed);
        setScreen("DONE");
      } catch {
        // No network. Bank it locally, give the customer their receipt, move on.
        await queueSale(idempotencyKey, body);
        setQueued(await outboxCount());
        setResult({
          saleId: idempotencyKey,
          receiptNumber: `${terminalId}-OFFLINE`,
          total: totals.total,
          changeDue: Math.max(0, tenders.reduce((t, x) => t + x.amount, 0) - totals.total),
          receiptPayload: "",
          warnings: ["Sold offline. This sale will sync when the connection is back."],
          queuedOffline: true,
        });
        setScreen("DONE");
      } finally {
        setBusy(false);
        setPendingApproval(null);
      }
    },
    [lines, pendingApproval, terminalId, totals],
  );

  // --- Render ---------------------------------------------------------------
  if (screen === "DONE" && result) {
    return (
      <SaleComplete
        result={result}
        onNext={clearBasket}
        shopName={settings.shopName}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-char-950">
      <TillHeader
        user={user}
        terminalId={terminalId}
        online={online}
        queued={queued}
        pendingPrints={pendingPrints}
        awaitingCodes={waitingForCodes}
        onShowCodeQueue={() => setShowCodeQueue(true)}
        parkedCount={parkedCount}
      />

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {screen === "SELLING" ? (
            <ProductGrid
              products={products}
              categories={categories}
              lowStockGrams={settings.lowStockWarningGrams}
              onSelect={(product) => {
                setEntryProduct(product);
                setEditingLineId(null);
              }}
            />
          ) : (
            <PaymentPad
              totals={totals}
              busy={busy}
              error={error}
              onCancel={() => setScreen("SELLING")}
              onComplete={completeSale}
            />
          )}
        </section>

        <aside className="flex w-[26rem] shrink-0 flex-col border-l border-char-800 bg-char-900">
          <Cart
            lines={lines}
            totals={totals}
            productsById={productsById}
            onEdit={(lineId) => {
              const line = lines.find((l) => l.lineId === lineId);
              const product = line ? productsById.get(line.productId) : undefined;
              if (product) {
                setEntryProduct(product);
                setEditingLineId(lineId);
              }
            }}
            onRemove={removeLine}
            onDiscount={applyDiscount}
            onClear={clearBasket}
            onPay={() => setScreen("PAYING")}
            payDisabled={screen === "PAYING" || lines.length === 0 || !totals}
          />
        </aside>
      </div>

      {entryProduct && (
        <EntryPad
          product={entryProduct}
          existing={editingLineId ? lines.find((l) => l.lineId === editingLineId) : undefined}
          onCancel={() => {
            setEntryProduct(null);
            setEditingLineId(null);
          }}
          /*
           * A line goes into the basket at whatever rate was typed, with no
           * approval step. The board rate travels with it and the server
           * records both, so the price is reviewable in the evening rather
           * than gated at the counter.
           */
          onSubmit={(values) => {
            if (editingLineId) {
              updateLine(editingLineId, values);
              return;
            }
            addLine({
              lineId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
              productId: entryProduct.id,
              ...values,
            });
          }}
        />
      )}

      {showCodeQueue && (
        <MpesaCodeQueue
          onClose={() => setShowCodeQueue(false)}
          onChanged={setWaitingForCodes}
        />
      )}

      {approvalRequest && (
        <ManagerPinDialog
          reason={approvalRequest.reason}
          onCancel={() => setApprovalRequest(null)}
          onSubmit={approvalRequest.onApprove}
        />
      )}
    </div>
  );
}
