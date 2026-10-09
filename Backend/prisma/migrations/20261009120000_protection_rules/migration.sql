-- Spec 05 Part 2: loan protection rules and their event log.

-- CreateTable
CREATE TABLE "protection_rules" (
    "id" TEXT NOT NULL,
    "privy_user_id" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "position_token" TEXT NOT NULL,
    "trigger_health" TEXT NOT NULL,
    "target_health" TEXT NOT NULL,
    "max_spend" TEXT NOT NULL,
    "max_per_call" TEXT NOT NULL,
    "spent" TEXT NOT NULL DEFAULT '0',
    "privy_policy_id" TEXT,
    "privy_wallet_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "signer_verified_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "last_action_at" TIMESTAMP(3),
    "last_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protection_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_events" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" TEXT,
    "health_before" TEXT,
    "health_after" TEXT,
    "tx_hash" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protection_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "protection_rules_enabled_idx" ON "protection_rules"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "protection_rules_wallet_address_pool_address_key" ON "protection_rules"("wallet_address", "pool_address");

-- CreateIndex
CREATE INDEX "protection_events_rule_id_created_at_idx" ON "protection_events"("rule_id", "created_at");

-- AddForeignKey
ALTER TABLE "protection_events" ADD CONSTRAINT "protection_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "protection_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
