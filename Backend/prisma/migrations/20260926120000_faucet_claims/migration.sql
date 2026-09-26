-- CreateTable
CREATE TABLE "faucet_claims" (
    "id" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "ip" TEXT,
    "usdg_amount" TEXT NOT NULL,
    "eth_amount_wei" TEXT NOT NULL,
    "usdg_tx_hash" TEXT,
    "eth_tx_hash" TEXT,
    "eth_skipped" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faucet_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "faucet_claims_wallet_address_created_at_idx" ON "faucet_claims"("wallet_address", "created_at");

-- CreateIndex
CREATE INDEX "faucet_claims_ip_created_at_idx" ON "faucet_claims"("ip", "created_at");

-- AddForeignKey
ALTER TABLE "faucet_claims" ADD CONSTRAINT "faucet_claims_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "users"("wallet_address") ON DELETE RESTRICT ON UPDATE CASCADE;

