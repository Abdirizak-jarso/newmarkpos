-- Two roles, and M-Pesa payment details.
--
-- 1. The shop has two kinds of person: the cashier at the counter and the
--    admin who runs the place. SUPERVISOR, MANAGER and OWNER all become ADMIN
--    — they could each already authorise a void, so nobody gains anything they
--    did not have. Anyone unrecognised is demoted to CASHIER rather than left
--    with a role the application no longer understands.
--
-- 2. An M-Pesa payment now records the customer's confirmation code and the
--    time from their message. Those two together are what the shop matches
--    against Safaricom's statement; without them a payment cannot be proved.
--    The column is nullable because cash and card lines have no such time, and
--    because payments taken before this change never captured one.

UPDATE "User" SET "role" = 'ADMIN'   WHERE "role" IN ('OWNER', 'MANAGER', 'SUPERVISOR');
UPDATE "User" SET "role" = 'CASHIER' WHERE "role" NOT IN ('ADMIN', 'CASHIER');

ALTER TABLE "Payment" ADD COLUMN "transactedAt" DATETIME;
