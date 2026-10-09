# Laxu Contracts

Tokenized Perpl perp positions (`PositionToken`) and an isolated lending market that accepts them as collateral (`LendingVault` / `LendingPool`), deployed on **Monad testnet (chain 10143)**. The asset is **AUSD**, Perpl's collateral token (6 decimals).

The design rationale, invariants and trust model are in the [litepaper](../docs/LITEPAPER.md); deployed addresses are in the [root README](../README.md#deployed-contracts) and [`deployments/monadTestnet.json`](deployments/monadTestnet.json).

```bash
npm install
cp .env.example .env
npx hardhat compile
npx hardhat test          # 143 passing, 2 pending
npx hardhat run scripts/deploy.js --network monadTestnet
```

**Tests** (9 Oct 2026): 143 passing: `test/PositionToken.js` 76, `test/Lending.js` 38, `test/Venue.js` 29. The 2 pending tests in `test/fork/PerplReader.fork.js` run only against a live Monad RPC (`MONAD_FORK_RPC`).

## Contracts

| Contract | Role |
|---|---|
| `PerplReader` | Reads Perpl's exchange: the mark (with paused, halted and price-age checks), a position by account, venue equity; converts Perpl units to Laxu's. Market mapping is owner-set, once per market. |
| `PositionToken` | One EIP-1167 clone per trade. ERC-20 shares, ERC-7540 async buy-ins and redeems, close → settle → claim, per-holder stop-loss / take-profit. |
| `PositionTokenFactory` | Creates tokens. Operator-only, leverage 1–20 (`MAX_LEVERAGE`). |
| `LendingVault` | Synchronous ERC-4626 AUSD vault (`lxAUSD`). Lenders deposit; registered pools draw against a per-pool debt ceiling. |
| `LendingPool` | One isolated market per token: deposit shares, borrow AUSD, repay, get liquidated. EIP-1167 clone. |
| `LendingPoolFactory` | Clones a pool and registers it with the vault in one call. Permissionless. |
| `vendor/` | OpenZeppelin community ERC-7540 files, vendored with four storage fields made `internal` (see each header). |
| `mocks/` | Test-only: a mock Perpl exchange and mock ERC-20s. |

## Position token

```
totalAssets = capital + size × (mark − entry) / 1e18   (negated for shorts) + (fundingAccrued − fundingSettled)
```

- **The mark is read, not reported.** `currentMark()` reads Perpl's mark through `PerplReader` on every valuation. If the read fails, the last cached mark is used, so `totalAssets` never reverts. There is no function that lets the operator set a price.
- **Creation is checked against Perpl.** `initialize` reads the slot's Perpl position: direction and size must match exactly, entry within 0.5% (`ENTRY_TOLERANCE_BPS = 50`).
- **Funding is the one reported value** (`applyFunding`), because Perpl resets its funding accumulator when a position grows. Report timestamps must strictly increase and be at most 60 seconds ahead.
- **Freshness.** `isPriceFresh()` is true for a closed position, or when funding is under `FUNDING_MAX_AGE` (2 hours) and the mark is live, valid and under `MARK_MAX_AGE` (5 minutes).
- **Buy-ins and redeems** are ERC-7540 requests that the operator fulfils after the Perpl side has moved; both settle in the fulfil transaction and keep NAV per share constant. Either can be cancelled after 20 minutes (`REQUEST_CANCEL_TIMEOUT`). Non-creator buy-ins pay 2% (`BUY_IN_FEE_BPS`) to the creator at request time.

**What the operator supplies:** trade details at creation (checked against Perpl), funding, fill size and price on `fulfillDepositRequest` / `fulfillRedeemRequest` / `executeTrigger`, final funding on `close`, and the recovered amount on `settle`.
**What it cannot do:** set a price; mint a token for a trade Perpl does not hold; mint itself shares; exit a holder whose level is not crossed at the live mark; pay a claim to anyone but the holder; take pending buy-ins or unclaimed settlement funds (`recoverExcess` returns only the balance above both); block `repay()`, `liquidate()` or `claim()`.

## Lending

**Liquidity is shared, risk is isolated.** One `LendingVault` holds all lenders' AUSD; many `LendingPool` clones, one per token, each capped by its own debt ceiling (10,000 AUSD per new pool on testnet). A position that goes bad can burn at most its own pool's ceiling.

### Deployment wiring

The factory must hold the vault's `registrar` role before any pool is created; an unregistered pool accepts collateral and then reverts on every borrow. `scripts/deploy.js` does this in order:

```
1. PerplReader(exchange)                       // then setMarket(...) per market
2. PositionToken(asset)                        // implementation only
3. PositionTokenFactory(impl, operator, asset, reader)
4. LendingVault(asset, name, symbol, owner)
5. LendingPool()                               // implementation only
6. LendingPoolFactory(poolImpl, vault, defaultDebtCeiling, owner)
7. vault.setRegistrar(factory)                 // required before any createPool
```

### Risk parameters

Resolved once in `LendingPool.initialize()` from the token's fixed leverage; no caller chooses them, so permissionless pool creation is safe.

| Leverage | LTV | Liquidation threshold | Liquidation bonus |
|---|---|---|---|
| 1–5× | 50% | 60% | 8% |
| 6–10× | 40% | 50% | 10% |
| 11–20× | 25% | 35% | 12% |

Flat across tiers: close factor 50% (100% below health 0.95, or below the dust threshold of 50 units of the asset), borrow APR 10% simple. Deliberately far below blue-chip lending LTVs: a leveraged position moves several times faster than its underlying and can be liquidated on Perpl in one step. A starting point, not back-tested.

### Freshness guard

`borrow()` and `withdrawCollateral()` carry `freshOracle`, which requires `isPriceFresh()`. Both open new risk, so both need recent data. A closed position is exempt, so borrowers can always withdraw collateral to claim.

`repay()`, `liquidate()` and `healthFactor()` are **not** gated, on purpose: blocking liquidation while data is stale would let bad debt grow while nobody can act. Liquidating on last-known data beats not liquidating.

### Two choices that look like shortcuts

- **Liquidation transfers shares; it does not call `redeem()`.** Redemptions are async and wait on a real Perpl margin reduction. A liquidator who had already repaid debt would not know what they were getting while the position kept moving. They pick their own exit afterwards.
- **`liquidate()` is a plain public function.** No role, no allowlist. The backend's liquidator bot (`ENABLE_LIQUIDATOR`, off by default) uses a wallet with no protocol role; `test/Lending.js` asserts an address with no role can liquidate.

## Known gaps

1. **Bad debt is not absorbed.** If seized collateral cannot cover a loan, `LendingVault.totalAssets()` stays overstated by the shortfall. `liquidate` caps the seizure at the collateral held rather than reverting, but nothing repairs the vault's books afterwards. No insurance fund. **The vault is not loss-proof.**
2. **Fills, funding and settlement amounts are operator-reported.** `settle(assets)` checks that the token holds `assets` plus pending buy-ins, not that `assets` equals what Perpl returned. Fill prices passed on fulfil move `entryPrice` for every holder.
3. **Duplicate pools per token are allowed.** Risk resolves the same way for each, so it is fragmentation, not a safety hole; `factory.primaryPool()` gives the UI one answer.
4. **Positions open only on a 6-decimal asset.** PnL lands in asset base units, so `size` must be in 10^assetDecimals units; the deployed `PerplReader` sizes at 1e6. The backend refuses to open a position otherwise (`assertPnlScaleSupported` in `Backend/src/venue/perpl/units.ts`). True for AUSD.
5. **Every token depends on `PerplReader`.** The owner can point the factory at a new reader for future positions only (`setVenueReader`).

## Perpl venue facts

- **Market ids.** Perpl's API market has `id` (used in orders) and `perpetual_id` (the on-chain `perpId` for `getPerpetualInfo` / `getPosition`). `PerplReader.setMarket` takes `perpetual_id`. `scripts/perplMarkets.js` snapshots both into `deployments/perplMarkets.testnet.json`; `deploy.js` maps from it and `scripts/checkReader.js` audits the live reader. On testnet the two ids are equal for every market.
- **Direction.** On-chain `positionType` is `0 = Long, 1 = Short`; the API's `sd` is `1 = Long, 2 = Short`. `PerplReader` reads the on-chain field.
- **Collateral units.** Perpl's `…CNS` amounts scale by `getExchangeInfo().collateralDecimals`. `deploy.js` refuses to deploy if that differs from the asset's `decimals()` (both 6 for AUSD).
- **Venue equity** is `depositCNS + pnlCNS`; `pnlCNS` already includes the funding premium, so adding `premiumPnlCNS` would count funding twice (confirmed on testnet, `docs/perpl-findings.md#v-adapter-277`).
- **Interface.** `interfaces/IPerplExchange.sol` is generated from Perpl's Exchange ABI (`abi/perpl/Exchange.json`, trimmed from `PerplFoundation/dex-sdk` commit `01b9910`) by `scripts/gen-perpl-iface.js`. Field order is load-bearing; the fork test checks it against the live exchange.
