# Laxu Contracts

Tokenized Arcus perp positions (`PositionToken`) and an isolated lending market that accepts them
as collateral (`LendingVault` / `LendingPool` / `LendingPoolFactory`).

```
npm run compile
npm test
```

---

## Lending system

**Liquidity is shared, risk is isolated.** One `LendingVault` holds all USDG that lenders deposit —
a single deep book, so rates are worth having. Many `LendingPool` clones, one per `PositionToken`,
each capped by its own debt ceiling at the vault. A position that goes bad can burn at most its own
pool's ceiling, never the whole book.

| Contract | Role |
| --- | --- |
| `LendingVault` | Synchronous ERC-4626 USDG vault. Lenders deposit; pools draw against a per-pool debt ceiling. |
| `LendingPool` | One isolated market per `PositionToken`. Deposit shares, borrow USDG, get liquidated. EIP-1167 clone. |
| `LendingPoolFactory` | Clones a pool and registers it with the vault in one call. Permissionless. |

### Deployment wiring

Order matters in one place: **the factory must hold the vault's `registrar` role before any pool is
created.** A pool that was never registered will accept collateral and then revert on every borrow.

```
1. deploy LendingVault(usdg, name, symbol, owner)
2. deploy LendingPool()                     // implementation only, never initialized
3. deploy LendingPoolFactory(poolImpl, vault, defaultDebtCeiling, owner)
4. vault.setRegistrar(factory)              // <- required before step 5
5. factory.createPool(positionToken)        // permissionless from here on
```

### Risk parameters

Protocol-wide, leverage-tiered, and resolved into each pool's own storage once — inside
`LendingPool.initialize()`, purely as a function of the collateral token's already-fixed
`leverage` — never a per-pool argument. That is what makes permissionless pool creation safe: no
caller, including whoever calls `createPool`, ever gets to choose a pool's risk numbers; a
duplicate pool for the same token resolves to the identical tier and behaves identically to the
first.

| Leverage | LTV | Liquidation threshold | Liquidation bonus |
| --- | --- | --- | --- |
| 1–5× | 50% | 60% | 8% |
| 6–10× | 40% | 50% | 10% |
| 11–20× | 25% | 35% | 12% |

Plus, flat across every tier: close factor 50% (100% below HF 0.95 or below dust), borrow APR 10%
simple interest.

Far below Aave's blue-chip defaults (75–80% LTV) even at the least conservative tier, deliberately.
Collateral here is a leveraged perp position — a 5× position swings ~5× faster than its underlying,
which alone puts it in the volatile/exotic bracket. Two things push it lower still, and both get
**worse as leverage climbs**, which is the reason for tiering rather than one flat number: the
underlying Arcus position can be liquidated, which steps `PositionToken` value down in one move
rather than letting it drift, and a bigger step at higher leverage; and `markPrice` arrives in
periodic CRE reports, not continuously, so for the same real-world price move a 20× position's
value swings ~4× faster than a 5× position's — a higher-leverage position has a meaningfully higher
chance of gapping straight through its liquidation threshold between two report intervals. Lower
LTV at higher leverage buys more cushion before the trigger; the rising bonus pays liquidators more
to prioritize the riskiest tier first when things move fast (same logic as Aave V4's dynamic
bonus).

Starting recommendation, not back-tested. The tier table is resolved once, at pool-creation time,
and never re-read — a `PositionToken`'s `leverage` never changes after its own `initialize()`, so
re-deriving the tier on every borrow/liquidate would just be gas spent computing the same answer.

---

## Known gaps

Stated rather than hidden. None of these are solved in this codebase.

**1. Bad debt is not absorbed.** If a pool's collateral is fully seized and still cannot cover the
debt, that pool's `currentDebt` never fully zeroes out, and `LendingVault.totalAssets()` stays
overstated by the shortfall — lenders are owed marginally more than exists. `LendingPool.liquidate`
surfaces this honestly (it caps the seizure at collateral actually held rather than reverting, so
the position stays liquidatable) but nothing repairs the vault's books afterward. Production
protocols use an insurance fund or governance write-offs. Out of scope for hackathon timeline.
**The vault is not loss-proof.**

**2. Leverage above 20× is not covered by the tier table.** `LendingPool._riskTierFor` has three
brackets (1–5×, 6–10×, 11–20×) and no upper bound check — a position above 20× silently falls
through to the 11–20× tier rather than reverting or getting its own bracket. Not a live problem
today because `PositionToken` creation currently keeps leverage within that range, but nothing in
`LendingPool` itself enforces that cap, so this is a real gap if the platform ever supports higher
leverage. Revisit then; `test/Lending.js` documents the current fall-through behavior explicitly
rather than leaving it implicit.

**3. `DUST_THRESHOLD_USD` assumes a 6-decimal USDG.** It is `50e6` per spec. If USDG ships with 18
decimals (as `MockUSDG` does) the constant is effectively zero and the force-full-liquidation dust
rule never fires. Harmless in testing, re-scale before mainnet.

**4. Duplicate pools per token are allowed.** `createPool` does not reject a `PositionToken` that
already has a pool. Because risk parameters resolve deterministically from the collateral's own
leverage, duplicates are a liquidity-fragmentation inefficiency, not a safety hole —
`factory.primaryPool()` gives the UI one canonical answer.

**5. `MAX_REPORT_AGE` (15 minutes) is a starting guess, not tuned against real CRE cadence.** See
"Oracle staleness guard" below for what it does and doesn't cover — the gap here is purely the
number itself, which needs revisiting once the off-chain reporting workflow's actual interval is
known.

---

## Oracle staleness guard

`LendingPool.borrow()` and `withdrawCollateral()` are gated by a `freshOracle` modifier: both
revert if `block.timestamp - PositionToken.lastReportTimestamp() > MAX_REPORT_AGE` (15 minutes).
Both are actions that *open* new risk against a live collateral read, so both need that read to be
recent.

`liquidate()` and `healthFactor()` are deliberately **not** gated, and this is not an oversight.
Multiple/whitelisted CRE nodes don't fix this either way — a DON reaching consensus protects
against one node lying about the data (an integrity problem), not against how long ago the last
successful report was (a recency problem); every node calls the same backend endpoint, so more
nodes just means more agreement on the same stale number. Blocking liquidation during a staleness
window would trade a small risk (acting on a slightly-old price) for a much bigger one (bad debt
accumulating unchecked while liquidation sits frozen) — liquidating on last-known data is safer
than refusing to liquidate at all, so `liquidate()` keeps working exactly as spec'd, unguarded.

---

## Two notes on design that are easy to misread as shortcuts

**Liquidation transfers shares, it does not call `redeem()`.** `PositionToken` redemptions are async
(ERC-7540) — they wait on `arcusOperator` confirming a real Arcus margin reduction. Routing
liquidation through `redeem()` would leave a liquidator having already paid off debt but not yet
knowing what they are getting, while the position's real value keeps moving underneath a pending
request. That is the precise scenario liquidation exists to prevent. Transferring seized shares
directly is also strictly less code. The liquidator picks their own exit afterwards, on their own
clock, bearing that timing risk themselves.

**`liquidate()` is a plain public function.** No allowlist, no role, nothing to configure. The
backend runs this today and can run several independent wallets doing it, because nothing in the
contract treats "liquidator" as an identity. Worth funding those wallets separately from
`arcusOperator` and the deployer: they hold none of the protocol's privileged roles and can still
liquidate. `test/Lending.js` asserts exactly that.
