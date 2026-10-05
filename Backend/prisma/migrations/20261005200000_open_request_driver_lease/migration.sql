-- Spec 03 Phase 5: one driver per open request across processes.
ALTER TABLE "position_open_requests" ADD COLUMN "driver_id" TEXT;
ALTER TABLE "position_open_requests" ADD COLUMN "driver_lease_until" TIMESTAMP(3);
