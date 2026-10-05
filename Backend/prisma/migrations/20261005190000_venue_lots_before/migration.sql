-- Spec 03 Phase 3: decide an unknown order outcome by the on-chain lot delta.
ALTER TABLE "position_open_requests" ADD COLUMN "venue_size_before" TEXT;
ALTER TABLE "position_open_requests" ADD COLUMN "venue_entry_before" TEXT;
ALTER TABLE "position_open_requests" ADD COLUMN "venue_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ledger_entries" ADD COLUMN "venue_size_before" TEXT;
ALTER TABLE "ledger_entries" ADD COLUMN "venue_entry_before" TEXT;
