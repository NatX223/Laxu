-- CreateTable
CREATE TABLE "users" (
    "wallet_address" TEXT NOT NULL,
    "privy_user_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("wallet_address")
);

-- CreateTable
CREATE TABLE "operator_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "evm_signer_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subaccount_slots" (
    "id" TEXT NOT NULL,
    "operator_wallet_id" TEXT NOT NULL,
    "account_index" INTEGER NOT NULL,
    "arcus_api_key" TEXT NOT NULL,
    "arcus_api_secret_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'free',
    "reserved_for_user" TEXT,
    "reserved_at" TIMESTAMP(3),
    "reservation_expires_at" TIMESTAMP(3),
    "position_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subaccount_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "position_token_address" TEXT,
    "lending_pool_address" TEXT,
    "user_wallet_address" TEXT NOT NULL,
    "arcus_position_id" TEXT,
    "arcus_order_id" TEXT,
    "arcus_client_id" TEXT,
    "market" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "leverage" INTEGER NOT NULL,
    "requested_amount" TEXT NOT NULL,
    "deposited_amount" TEXT,
    "entry_price" TEXT,
    "size" TEXT,
    "capital" TEXT,
    "funding_settled" TEXT NOT NULL DEFAULT '0',
    "mark_price" TEXT,
    "funding_accrued" TEXT NOT NULL DEFAULT '0',
    "listed" BOOLEAN NOT NULL DEFAULT false,
    "nickname" TEXT NOT NULL DEFAULT '',
    "default_stop_loss" TEXT,
    "default_take_profit" TEXT,
    "defaults_active" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "failure_reason" TEXT,
    "liquidated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_open_requests" (
    "id" TEXT NOT NULL,
    "user_wallet_address" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "leverage" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "stop_loss" TEXT,
    "take_profit" TEXT,
    "payment_tx_hash" TEXT,
    "arcus_deposit_tx_hash" TEXT,
    "credited_amount" TEXT,
    "status" TEXT NOT NULL DEFAULT 'awaiting_payment',
    "arcus_client_id" TEXT,
    "arcus_order_id" TEXT,
    "entry_price" TEXT,
    "filled_size" TEXT,
    "position_token_address" TEXT,
    "lending_pool_address" TEXT,
    "refund_withdrawal_id" TEXT,
    "refund_tx_hash" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "position_open_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_reports" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "mark_price" TEXT NOT NULL,
    "funding" TEXT NOT NULL,
    "total_assets" TEXT NOT NULL,
    "total_supply" TEXT NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "arcus_status" TEXT NOT NULL DEFAULT 'pending',
    "onchain_request_id" TEXT,
    "tx_hash" TEXT,
    "log_index" INTEGER,
    "controller" TEXT,
    "onchain_fulfilled_at" TIMESTAMP(3),
    "arcus_request_id" TEXT,
    "request_amount" TEXT,
    "arcus_client_id" TEXT,
    "filled_size" TEXT,
    "fill_price" TEXT,
    "batch" JSONB,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "laxu_market" TEXT NOT NULL,
    "arcus_market_id" INTEGER NOT NULL,
    "display_symbol" TEXT NOT NULL,
    "base_asset" TEXT NOT NULL,
    "full_asset_name" TEXT NOT NULL,
    "asset_class" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "logo_url" TEXT,
    "initial_margin_fraction" TEXT NOT NULL,
    "off_hours_initial_margin_fraction" TEXT NOT NULL,
    "is_outside_rth" BOOLEAN NOT NULL DEFAULT false,
    "regular_trading_hours" JSONB,
    "tick_size" TEXT NOT NULL,
    "step_size" TEXT NOT NULL,
    "min_order_size" TEXT NOT NULL,
    "max_order_size" TEXT NOT NULL,
    "min_order_notional" TEXT NOT NULL,
    "maintenance_margin_fraction" TEXT NOT NULL DEFAULT '0',
    "mark_price" TEXT NOT NULL,
    "price_change_24h" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("laxu_market")
);

-- CreateTable
CREATE TABLE "lending_pools" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "position_token_address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lending_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "borrowers" (
    "id" TEXT NOT NULL,
    "lending_pool_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "collateral_shares" TEXT NOT NULL DEFAULT '0',
    "debt" TEXT NOT NULL DEFAULT '0',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "borrowers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holdings" (
    "position_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "balance" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("position_id","address")
);

-- CreateTable
CREATE TABLE "flows" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "trigger" TEXT,
    "address" TEXT NOT NULL,
    "assets" TEXT NOT NULL,
    "fee_assets" TEXT NOT NULL DEFAULT '0',
    "shares" TEXT NOT NULL,
    "nav_per_share" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holder_triggers" (
    "position_id" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "stop_loss" TEXT,
    "take_profit" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holder_triggers_pkey" PRIMARY KEY ("position_id","holder")
);

-- CreateTable
CREATE TABLE "buy_in_fees" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "controller" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "flow_id" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buy_in_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "position_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "final_mark_price" TEXT,
    "final_funding" TEXT,
    "close_tx_hash" TEXT,
    "withdraw_started_at" TIMESTAMP(3),
    "withdrawal_id" TEXT,
    "recovered_assets" TEXT,
    "fund_tx_hash" TEXT,
    "settle_tx_hash" TEXT,
    "recover_tx_hash" TEXT,
    "claims_pushed_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'closing',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("position_id")
);

-- CreateTable
CREATE TABLE "position_stats" (
    "position_id" TEXT NOT NULL,
    "nav_per_share" TEXT NOT NULL,
    "total_assets" TEXT NOT NULL,
    "total_supply" TEXT NOT NULL,
    "pnl_bps" INTEGER NOT NULL,
    "mark_price" TEXT NOT NULL,
    "funding_net" TEXT NOT NULL,
    "effective_leverage" TEXT NOT NULL,
    "holder_count" INTEGER NOT NULL,
    "buy_in_volume" TEXT NOT NULL,
    "buy_in_volume_24h" TEXT NOT NULL,
    "buyer_count_24h" INTEGER NOT NULL,
    "is_at_risk" BOOLEAN NOT NULL,
    "is_collateralized" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "position_stats_pkey" PRIMARY KEY ("position_id")
);

-- CreateTable
CREATE TABLE "indexer_checkpoint" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_processed_block" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_privy_user_id_key" ON "users"("privy_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tag_key" ON "users"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "operator_wallets_address_key" ON "operator_wallets"("address");

-- CreateIndex
CREATE UNIQUE INDEX "subaccount_slots_position_id_key" ON "subaccount_slots"("position_id");

-- CreateIndex
CREATE INDEX "subaccount_slots_status_idx" ON "subaccount_slots"("status");

-- CreateIndex
CREATE UNIQUE INDEX "subaccount_slots_operator_wallet_id_account_index_key" ON "subaccount_slots"("operator_wallet_id", "account_index");

-- CreateIndex
CREATE UNIQUE INDEX "positions_position_token_address_key" ON "positions"("position_token_address");

-- CreateIndex
CREATE UNIQUE INDEX "positions_arcus_client_id_key" ON "positions"("arcus_client_id");

-- CreateIndex
CREATE INDEX "positions_status_idx" ON "positions"("status");

-- CreateIndex
CREATE INDEX "positions_user_wallet_address_idx" ON "positions"("user_wallet_address");

-- CreateIndex
CREATE INDEX "positions_liquidated_idx" ON "positions"("liquidated");

-- CreateIndex
CREATE INDEX "positions_listed_idx" ON "positions"("listed");

-- CreateIndex
CREATE UNIQUE INDEX "position_open_requests_payment_tx_hash_key" ON "position_open_requests"("payment_tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "position_open_requests_arcus_client_id_key" ON "position_open_requests"("arcus_client_id");

-- CreateIndex
CREATE INDEX "position_open_requests_status_idx" ON "position_open_requests"("status");

-- CreateIndex
CREATE INDEX "position_open_requests_slot_id_idx" ON "position_open_requests"("slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "position_reports_position_id_timestamp_key" ON "position_reports"("position_id", "timestamp");

-- CreateIndex
CREATE INDEX "ledger_entries_position_id_type_idx" ON "ledger_entries"("position_id", "type");

-- CreateIndex
CREATE INDEX "ledger_entries_arcus_status_idx" ON "ledger_entries"("arcus_status");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_tx_hash_log_index_key" ON "ledger_entries"("tx_hash", "log_index");

-- CreateIndex
CREATE UNIQUE INDEX "markets_arcus_market_id_key" ON "markets"("arcus_market_id");

-- CreateIndex
CREATE UNIQUE INDEX "markets_display_symbol_key" ON "markets"("display_symbol");

-- CreateIndex
CREATE UNIQUE INDEX "markets_base_asset_key" ON "markets"("base_asset");

-- CreateIndex
CREATE INDEX "markets_status_idx" ON "markets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "lending_pools_pool_address_key" ON "lending_pools"("pool_address");

-- CreateIndex
CREATE UNIQUE INDEX "borrowers_lending_pool_id_address_key" ON "borrowers"("lending_pool_id", "address");

-- CreateIndex
CREATE INDEX "holdings_address_idx" ON "holdings"("address");

-- CreateIndex
CREATE INDEX "flows_position_id_timestamp_idx" ON "flows"("position_id", "timestamp");

-- CreateIndex
CREATE INDEX "flows_address_idx" ON "flows"("address");

-- CreateIndex
CREATE UNIQUE INDEX "flows_tx_hash_log_index_key" ON "flows"("tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "buy_in_fees_position_id_controller_idx" ON "buy_in_fees"("position_id", "controller");

-- CreateIndex
CREATE UNIQUE INDEX "buy_in_fees_tx_hash_log_index_key" ON "buy_in_fees"("tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "settlements_status_idx" ON "settlements"("status");

-- AddForeignKey
ALTER TABLE "subaccount_slots" ADD CONSTRAINT "subaccount_slots_operator_wallet_id_fkey" FOREIGN KEY ("operator_wallet_id") REFERENCES "operator_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subaccount_slots" ADD CONSTRAINT "subaccount_slots_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_wallet_address_fkey" FOREIGN KEY ("user_wallet_address") REFERENCES "users"("wallet_address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_reports" ADD CONSTRAINT "position_reports_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrowers" ADD CONSTRAINT "borrowers_lending_pool_id_fkey" FOREIGN KEY ("lending_pool_id") REFERENCES "lending_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holder_triggers" ADD CONSTRAINT "holder_triggers_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_stats" ADD CONSTRAINT "position_stats_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
