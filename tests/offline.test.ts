import { describe, expect, it } from "vitest";
import { newIdempotencyKey, outboxDisposition } from "@/lib/offline";
import { checkoutSchema } from "@/lib/validation";

/**
 * The offline outbox.
 *
 * The till sells with no network and drains to the server when it comes back.
 * Two things must hold or the shop loses money it has already taken:
 *
 *   a replayed sale must never bank twice — the idempotency key is the whole
 *   defence, and it is generated on the client;
 *
 *   a queue must never wedge. One unsendable sale sitting at the head of the
 *   outbox blocking every sale behind it is how a day's takings disappear.
 */

describe("the idempotency key", () => {
  it("is unique across a busy day's worth of sales", () => {
    // Far more than a counter does in a day, generated as fast as possible —
    // the case where a time-based key would collide.
    const keys = new Set<string>();
    for (let i = 0; i < 20_000; i++) keys.add(newIdempotencyKey());
    expect(keys.size).toBe(20_000);
  });

  it("is accepted by the schema that banks the sale", () => {
    // The key becomes the sale's primary key, so a key the server refuses is a
    // sale that can never be synced.
    for (let i = 0; i < 200; i++) {
      const result = checkoutSchema.shape.idempotencyKey.safeParse(newIdempotencyKey());
      expect(result.success).toBe(true);
    }
  });

  it("carries no characters that need escaping anywhere it is used", () => {
    // It goes into a URL, a JSON body and a database primary key.
    for (let i = 0; i < 200; i++) {
      expect(newIdempotencyKey()).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe("what to do with a sale the server answered", () => {
  it("keeps a banked sale out of the outbox", () => {
    for (const status of [200, 201, 204]) {
      expect(outboxDisposition(status)).toBe("keep");
    }
  });

  it("drops a sale the server will refuse every time", () => {
    // A deleted product, a malformed body. Retrying forever wedges the queue.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(outboxDisposition(status)).toBe("drop");
    }
  });

  it("retries when the server is broken rather than the sale", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(outboxDisposition(status)).toBe("retry");
    }
  });

  it("retries a timeout and a rate limit, despite them being 4xx", () => {
    // These say "ask again later", not "never ask again". Dropping them throws
    // away a good sale because the server was busy.
    expect(outboxDisposition(408)).toBe("retry");
    expect(outboxDisposition(429)).toBe("retry");
  });

  it("retries anything it does not recognise", () => {
    // An unknown answer is not licence to throw a sale away.
    for (const status of [0, 100, 306, 599]) {
      expect(outboxDisposition(status)).toBe("retry");
    }
  });
});
