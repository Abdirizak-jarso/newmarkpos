-- Signing in with a PIN alone.
--
-- The PIN now identifies the person as well as authorising them, so it has to
-- be findable and it has to be unique. `pinLookup` holds a keyed HMAC of the
-- PIN (see lib/auth.ts): indexed so a PIN finds its owner in one query rather
-- than scrypt-testing every member of staff, and unique so two people can
-- never share one.
--
-- The column is nullable because existing rows cannot be backfilled: a PIN is
-- stored as a scrypt hash and is not recoverable by design. Anyone whose
-- pinLookup is NULL cannot sign in until their PIN is set again from
-- Admin -> Staff. On a live shop, plan for every member of staff to be given a
-- new PIN when this migration is applied.

ALTER TABLE "User" ADD COLUMN "pinLookup" TEXT;

CREATE UNIQUE INDEX "User_pinLookup_key" ON "User"("pinLookup");
