// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILendingPool} from "./ILendingPool.sol";
import {ILendingVault} from "./ILendingVault.sol";
import {IPositionToken} from "./IPositionToken.sol";

/**
 * @title LendingPool
 * @dev One isolated borrowing market per {PositionToken}: deposit position shares as collateral,
 * borrow USDG against them. Deployed as an EIP-1167 clone by {LendingPoolFactory} -- state is set
 * once via {initialize}, not a constructor.
 *
 * The isolation is the point. Liquidity is shared (all of it lives in the one {LendingVault}) but
 * risk is not: this pool can only ever draw what the vault's debt ceiling permits it, so a
 * position token that collapses cannot reach into any other market's collateral.
 *
 * Collateral is priced LIVE off the position token on every read -- nothing is cached here, ever.
 * That is what makes "position gains value -> borrower gets more headroom, with no interaction
 * from anybody" fall out for free, and it is also why a stale price/funding report is a real risk
 * rather than a theoretical one: see {freshOracle} for the guard, and {liquidate} for why that
 * guard deliberately does not cover every function.
 */
contract LendingPool is ILendingPool, Initializable, ReentrancyGuard {
    using Math for uint256;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Health-factor fixed-point scale. HF == WAD means exactly at the liquidation line.
    uint256 public constant WAD = 1e18;

    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ---------------------------------------------------------------------
    // Risk parameters -- protocol-wide, leverage-tiered, NOT per-pool, NOT caller-chosen
    //
    // Structural, not stylistic: {LendingPoolFactory-createPool} is permissionless, so if a
    // pool's risk numbers were initialize() arguments anybody could stand up a 95%-LTV market
    // against any position token and drain the shared vault through it. Instead every clone
    // resolves its numbers itself, inside {initialize}, purely as a function of the collateral's
    // own already-fixed `leverage` -- there is no caller-supplied risk input anywhere.
    //
    // On the numbers: even the least conservative tier sits far below Aave's blue-chip defaults
    // (75-80% LTV), on purpose. Collateral here is a leveraged perp position -- a 5x position's
    // value swings ~5x faster than its underlying, which alone puts it in the volatile/exotic
    // bracket (40-60% LTV in real risk frameworks). Two things push it lower still, and both get
    // WORSE as leverage climbs: (1) if the underlying Arcus position is liquidated the token's
    // value does not drift down, it steps down in one move as close() locks a much-reduced
    // finalNavValue -- higher leverage means a bigger step for the same underlying move; (2)
    // markPrice arrives in periodic backend reports, not continuously, and for the same real-world
    // price move a 20x position's value swings ~4x faster than a 5x position's -- so between two
    // report intervals, a higher-leverage position has a meaningfully higher chance of gapping
    // straight through its liquidation threshold before this pool can react. A flat ratio is
    // leverage-agnostic in value-space and under-protects the high-leverage tier; tiering LTV
    // down and the liquidation bonus up as leverage rises buys more cushion before the trigger
    // and pays liquidators more to prioritize the riskiest tier first when things move fast (the
    // same logic as Aave V4's dynamic bonus).
    //
    // A starting recommendation, not back-tested.
    // ---------------------------------------------------------------------

    /// @dev Resolved once per pool, in {initialize}, from the collateral's own leverage -- never
    /// re-derived on every call. See {_riskTierFor} for the table these come from.
    struct RiskTier {
        uint256 ltvBps;
        uint256 liquidationThresholdBps;
        uint256 liquidationBonusBps;
    }

    uint256 public constant CLOSE_FACTOR_BPS = 5_000; // 50% of debt per liquidation, normally

    /// @dev Under this health factor the close factor jumps to 100%. A position this far gone is
    /// falling faster than repeated half-liquidations can catch; letting one liquidator clear it
    /// in a single transaction is what prevents bad debt.
    uint256 public constant CLOSE_FACTOR_HF_THRESHOLD = 0.95e18;

    /// @dev Below this remaining collateral value, force full liquidation. A leftover position too
    /// small to be worth a liquidator's gas is a position nobody will ever come back for, so it is
    /// cleared in one go instead of being left to rot as unrecoverable dust.
    /// NOTE: denominated in the debt asset's own units, and written assuming a 6-decimal USDG
    /// ($50). If USDG is deployed with 18 decimals this is effectively zero and the dust rule
    /// never fires -- harmless, but re-scale it before mainnet.
    uint256 public constant DUST_THRESHOLD_USD = 50e6;

    /// @dev Flat borrow rate, deliberately not a utilization curve. A kinked curve prices the
    /// scarcity of liquidity within a single market; here liquidity is shared across every pool,
    /// so this pool's own utilization is not the quantity such a curve would want to respond to.
    /// (The spec resolved the rate to a protocol-wide constant but left the number open; 10% is
    /// the chosen starting value for volatile collateral.)
    uint256 public constant BORROW_APR_BPS = 1_000; // 10% APR, simple (non-compounding)

    /**
     * @dev Resolves the report-latency gap risk cited throughout the risk-parameter reasoning
     * above -- not a duplicate of it. There is a single source for this data (the backend's
     * `arcusOperator` wallet), so nothing here protects against that source lying (an integrity
     * problem) -- only against how long ago its last successful report was (a recency problem). A
     * timestamp check against {IPositionToken-lastReportTimestamp} is the actual fix, applied via
     * {freshOracle}, paired on the backend side with a deviation+heartbeat write policy rather than
     * a slow fixed clock (see the reporting job in the backend's `services/reporter.ts`).
     *
     * Sized directly off that heartbeat: the backend's reporting job writes at least every 5
     * minutes, so 7 is that heartbeat plus a buffer for normal execution/confirmation lag, not an
     * independent guess. Still worth revisiting once the live job's actual lag is observed.
     */
    uint256 public constant MAX_REPORT_AGE = 7 minutes;

    // ---------------------------------------------------------------------
    // Wiring -- set once at clone time
    // ---------------------------------------------------------------------

    /// @dev The single {PositionToken} this market accepts. One pool, one collateral type.
    address public collateralToken;

    /// @dev Shared USDG liquidity source.
    address public lendingVault;

    /// @dev The borrowable token, read off the vault at init rather than passed in, so the two can
    /// never disagree about what is being lent.
    address public debtAsset;

    // ---------------------------------------------------------------------
    // Resolved risk tier -- set once at clone time, from the collateral's own leverage
    //
    // Storage, not re-derivation: `leverage` never changes for a given PositionToken (it is set
    // once in ITS OWN initialize() and has no setter), so re-reading positionInfo() and
    // re-resolving the tier on every borrow/liquidate would be pure gas waste for a value that
    // can never move. Resolved once here instead.
    // ---------------------------------------------------------------------

    uint256 public ltvBps;
    uint256 public liquidationThresholdBps;
    uint256 public liquidationBonusBps;

    // ---------------------------------------------------------------------
    // Per-borrower books
    // ---------------------------------------------------------------------

    /// @dev PositionToken shares held on this borrower's behalf.
    mapping(address => uint256) public collateralBalance;

    /// @dev Outstanding principal only. This is the figure the vault's own `currentDebt` mirrors.
    mapping(address => uint256) public debtPrincipal;

    /// @dev Interest accrued but not yet paid. Kept apart from principal because the vault needs
    /// the two separated at repayment time: principal retires debt, interest becomes lender yield.
    mapping(address => uint256) public interestAccrued;

    mapping(address => uint256) public debtLastAccrued;

    event CollateralDeposited(address indexed user, uint256 shares);
    event CollateralWithdrawn(address indexed user, uint256 shares);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 principal, uint256 interest);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        uint256 repayAmount,
        uint256 seizedShares
    );

    /// @dev Implementation-contract constructor only -- clones never run this. Locks the
    /// implementation so it cannot be initialized and mistaken for a live market.
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Called once by the Factory immediately after cloning. Note what is NOT a parameter
     * here: no LTV, no threshold, no bonus, no APR -- the caller (anyone, since {createPool} is
     * permissionless) never gets a say in risk numbers. LTV/threshold/bonus are resolved from
     * `_collateralToken`'s own already-fixed leverage via {_riskTierFor}; APR is the flat
     * protocol-wide constant.
     */
    function initialize(address _collateralToken, address _lendingVault) external initializer {
        require(_collateralToken != address(0), "LendingPool: zero collateral");
        require(_lendingVault != address(0), "LendingPool: zero vault");

        collateralToken = _collateralToken;
        lendingVault = _lendingVault;
        debtAsset = ILendingVault(_lendingVault).asset();

        (, , uint256 leverage, , , ) = IPositionToken(_collateralToken).positionInfo();
        RiskTier memory tier = _riskTierFor(leverage);
        ltvBps = tier.ltvBps;
        liquidationThresholdBps = tier.liquidationThresholdBps;
        liquidationBonusBps = tier.liquidationBonusBps;

        // The vault pulls repayments from this pool (see {ILendingVault-repayTo}), so it needs a
        // standing allowance. Granted once, to the protocol's own vault, whose address is fixed
        // for this clone's lifetime -- there is no later call that can repoint it elsewhere.
        SafeERC20.forceApprove(IERC20(debtAsset), _lendingVault, type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Oracle freshness guard
    // ---------------------------------------------------------------------

    /**
     * @dev Blocks the two actions that OPEN new risk on a possibly-stale price: taking on more
     * debt, or pulling collateral out from under existing debt. Deliberately NOT applied to
     * {liquidate} or {healthFactor} -- see the rationale on {liquidate} itself. Blocking
     * liquidation during a staleness window trades a small risk (acting on a slightly-old price)
     * for a much bigger one (bad debt accumulating unchecked while liquidation sits frozen);
     * liquidating on last-known data is safer than refusing to liquidate at all.
     */
    modifier freshOracle() {
        require(
            block.timestamp - IPositionToken(collateralToken).lastReportTimestamp() <= MAX_REPORT_AGE,
            "LendingPool: stale oracle data"
        );
        _;
    }

    // ---------------------------------------------------------------------
    // Collateral
    // ---------------------------------------------------------------------

    function depositCollateral(uint256 shares) external nonReentrant {
        require(shares > 0, "LendingPool: zero shares");

        collateralBalance[msg.sender] += shares;
        SafeERC20.safeTransferFrom(IERC20(collateralToken), msg.sender, address(this), shares);

        emit CollateralDeposited(msg.sender, shares);
    }

    /// @dev Reverts if the withdrawal would push the caller below the liquidation line. Checked
    /// after the deduction rather than against a projected figure, so the guard reads the same
    /// {healthFactor} a liquidator would. Gated by {freshOracle}: pulling collateral out is,
    /// like {borrow}, a way of increasing risk against a price that might be stale.
    function withdrawCollateral(uint256 shares) external nonReentrant freshOracle {
        require(shares > 0, "LendingPool: zero shares");
        require(collateralBalance[msg.sender] >= shares, "LendingPool: insufficient collateral");

        _accrue(msg.sender);
        collateralBalance[msg.sender] -= shares;
        require(healthFactor(msg.sender) >= WAD, "LendingPool: breaches health factor");

        SafeERC20.safeTransfer(IERC20(collateralToken), msg.sender, shares);

        emit CollateralWithdrawn(msg.sender, shares);
    }

    // ---------------------------------------------------------------------
    // Borrow / repay
    // ---------------------------------------------------------------------

    /**
     * @dev Headroom is checked against LIVE collateral value, which is the whole mechanism: as the
     * underlying position gains value the borrower's limit rises on its own, with no re-appraisal,
     * no oracle push into this contract and no transaction from anybody. Gated by {freshOracle}:
     * that live value is exactly what a stale report would misrepresent, and borrowing is how a
     * misrepresented value turns into real new debt.
     */
    function borrow(uint256 amount) external nonReentrant freshOracle {
        require(amount > 0, "LendingPool: zero amount");

        _accrue(msg.sender);
        require(
            currentDebt(msg.sender) + amount <=
                collateralValue(msg.sender).mulDiv(ltvBps, BPS_DENOMINATOR),
            "LendingPool: exceeds LTV"
        );

        debtPrincipal[msg.sender] += amount;

        ILendingVault(lendingVault).borrowFrom(amount);
        SafeERC20.safeTransfer(IERC20(debtAsset), msg.sender, amount);

        emit Borrowed(msg.sender, amount);
    }

    /**
     * @dev Repays up to `amount`, interest first. Over-payment is trimmed to the outstanding debt
     * rather than reverting, so a borrower clearing a position does not have to race their own
     * interest accrual to compute an exact figure.
     *
     * Interest-before-principal matters beyond ordering: only the principal leg reduces what this
     * pool owes the vault, so the split has to be made explicit at this boundary.
     */
    function repay(uint256 amount) external nonReentrant returns (uint256 repaid) {
        require(amount > 0, "LendingPool: zero amount");

        _accrue(msg.sender);
        (uint256 principalPortion, uint256 interestPortion) = _applyRepayment(msg.sender, amount);
        repaid = principalPortion + interestPortion;
        require(repaid > 0, "LendingPool: nothing to repay");

        SafeERC20.safeTransferFrom(IERC20(debtAsset), msg.sender, address(this), repaid);
        ILendingVault(lendingVault).repayTo(principalPortion, interestPortion);

        emit Repaid(msg.sender, principalPortion, interestPortion);
    }

    // ---------------------------------------------------------------------
    // Liquidation
    // ---------------------------------------------------------------------

    /**
     * @dev PERMISSIONLESS. No role, no allowlist, nothing to configure -- exactly like Aave's. The
     * backend runs this today, and can run several independent wallets doing it, because nothing
     * here treats "liquidator" as an identity. Those wallets are worth funding separately from
     * `arcusOperator` and the deployer precisely because they need none of those privileges.
     *
     * Deliberately NOT gated by {freshOracle}, unlike {borrow} and {withdrawCollateral}. Blocking
     * liquidation during a staleness window trades a small risk (acting on a slightly-old price)
     * for a much bigger one (bad debt accumulating unchecked while liquidation sits frozen).
     * Liquidating on last-known data is safer than refusing to liquidate at all.
     *
     * Seized collateral is transferred out as SHARES, never redeemed. {PositionToken} redemptions
     * are async (ERC-7540): they wait on `arcusOperator` confirming a real Arcus margin reduction.
     * Routing liquidation through redeem() would leave a liquidator having already paid off debt
     * but not yet knowing what they are getting, while the position's real value keeps moving
     * underneath a pending request -- the precise scenario liquidation exists to prevent, walked
     * into on purpose. A plain ERC-20 transfer also removes the entire async path from the
     * liquidation flow. The liquidator picks their own exit afterwards -- redeem and wait, or sell
     * into the equity marketplace -- on their own clock, bearing that timing risk themselves
     * instead of the pool bearing it for them.
     */
    function liquidate(
        address borrower,
        uint256 repayAmount
    ) external nonReentrant returns (uint256 seizedShares) {
        require(repayAmount > 0, "LendingPool: zero amount");

        _accrue(borrower);
        require(healthFactor(borrower) < WAD, "LendingPool: not liquidatable");
        require(repayAmount <= _closeFactorFor(borrower), "LendingPool: exceeds close factor");

        seizedShares = _sharesForRepay(repayAmount);

        // Cap at what the borrower actually holds. Hitting this cap IS the bad-debt case: the
        // liquidator still clears the debt they paid for, but part of the 8% bonus is unfunded, so
        // there is less incentive for the next one. Surfacing that as a short seize rather than a
        // revert at least keeps the position liquidatable at all, which matters more.
        uint256 held = collateralBalance[borrower];
        if (seizedShares > held) seizedShares = held;
        collateralBalance[borrower] = held - seizedShares;

        // The spec sketch passes (repayAmount, 0) here. It cannot: the vault tracks principal
        // only, so booking accrued interest as principal would underflow its `currentDebt`. Split
        // it the same way {repay} does -- the liquidator's payment clears interest first, then
        // principal.
        (uint256 principalPortion, uint256 interestPortion) = _applyRepayment(borrower, repayAmount);

        SafeERC20.safeTransferFrom(IERC20(debtAsset), msg.sender, address(this), repayAmount);
        ILendingVault(lendingVault).repayTo(principalPortion, interestPortion);
        SafeERC20.safeTransfer(IERC20(collateralToken), msg.sender, seizedShares);

        emit Liquidated(msg.sender, borrower, repayAmount, seizedShares);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @dev Ratio of risk-adjusted collateral to debt, in WAD. Below 1e18 the position is seizable.
     *
     * Trusts `markPrice` however old it is, and deliberately so -- this is a view, called from
     * {liquidate} among other places, and {liquidate} must keep working on last-known data during
     * a staleness window (see the rationale on {liquidate}). The staleness guard for the actions
     * that OPEN new risk lives one level up, in {freshOracle} on {borrow} and
     * {withdrawCollateral}, not here.
     */
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = currentDebt(user);
        // No debt is not "infinitely healthy" as a quantity, but every caller compares against
        // 1e18, and max means "cannot be liquidated, cannot block a withdrawal" -- which is right.
        if (debt == 0) return type(uint256).max;

        return collateralValue(user).mulDiv(liquidationThresholdBps * WAD, BPS_DENOMINATOR * debt);
    }

    /// @dev Reads LIVE off the position token, never a cached figure -- this single line is the
    /// mechanism by which a winning position becomes better collateral automatically.
    function collateralValue(address user) public view returns (uint256) {
        return IPositionToken(collateralToken).convertToAssets(collateralBalance[user]);
    }

    /// @dev Principal plus interest, including interest accrued since the last write. Computed
    /// rather than read out of storage so a view caller never sees a stale debt figure.
    function currentDebt(address user) public view returns (uint256) {
        return debtPrincipal[user] + interestAccrued[user] + _pendingInterest(user);
    }

    /// @dev How much more a borrower may take on top of what they owe, at the LTV cap.
    function availableToBorrow(address user) external view returns (uint256) {
        uint256 limit = collateralValue(user).mulDiv(ltvBps, BPS_DENOMINATOR);
        uint256 debt = currentDebt(user);
        return limit > debt ? limit - debt : 0;
    }

    /// @dev Largest `repayAmount` {liquidate} will currently accept for `borrower`; 0 if healthy.
    function maxLiquidatableDebt(address borrower) external view returns (uint256) {
        if (healthFactor(borrower) >= WAD) return 0;
        return _closeFactorFor(borrower);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Simple (non-compounding) interest on principal. Compounding would need a per-borrower
    /// index; at these rates and this timescale that state is not worth carrying.
    function _pendingInterest(address user) internal view returns (uint256) {
        uint256 principal = debtPrincipal[user];
        uint256 last = debtLastAccrued[user];
        if (principal == 0 || last == 0 || block.timestamp <= last) return 0;

        return
            principal.mulDiv(
                BORROW_APR_BPS * (block.timestamp - last),
                BPS_DENOMINATOR * SECONDS_PER_YEAR
            );
    }

    /// @dev Folds pending interest into storage and restarts the clock. Called at the top of every
    /// path that reads or writes a debt figure, so no branch can act on an under-counted debt.
    function _accrue(address user) internal {
        uint256 pending = _pendingInterest(user);
        if (pending > 0) interestAccrued[user] += pending;
        debtLastAccrued[user] = block.timestamp;
    }

    /**
     * @dev Books `amount` against `user`'s debt, interest first, and returns the two legs. Trims
     * to the outstanding total so a caller can never over-collect. Assumes {_accrue} has already
     * run for `user` in this transaction.
     */
    function _applyRepayment(
        address user,
        uint256 amount
    ) internal returns (uint256 principalPortion, uint256 interestPortion) {
        uint256 outstandingInterest = interestAccrued[user];
        uint256 outstandingPrincipal = debtPrincipal[user];

        uint256 total = outstandingInterest + outstandingPrincipal;
        if (amount > total) amount = total;

        interestPortion = amount < outstandingInterest ? amount : outstandingInterest;
        principalPortion = amount - interestPortion;

        interestAccrued[user] = outstandingInterest - interestPortion;
        debtPrincipal[user] = outstandingPrincipal - principalPortion;
    }

    /// @dev Assumes {_accrue} has already run for `borrower`.
    function _closeFactorFor(address borrower) internal view returns (uint256) {
        uint256 debt = currentDebt(borrower);

        // Falling too fast for half-measures, or too small to be worth a second visit: clear it
        // whole. Both branches exist to stop a residue nobody will ever profitably liquidate.
        if (healthFactor(borrower) < CLOSE_FACTOR_HF_THRESHOLD) return debt;
        if (collateralValue(borrower) < DUST_THRESHOLD_USD) return debt;

        return debt.mulDiv(CLOSE_FACTOR_BPS, BPS_DENOMINATOR);
    }

    /// @dev Shares worth `repayAmount` plus this pool's liquidation bonus, at the position
    /// token's live rate. The bonus is what pays a liquidator to show up with their own capital.
    function _sharesForRepay(uint256 repayAmount) internal view returns (uint256) {
        uint256 seizeValue = repayAmount.mulDiv(
            BPS_DENOMINATOR + liquidationBonusBps,
            BPS_DENOMINATOR
        );
        return IPositionToken(collateralToken).convertToShares(seizeValue);
    }

    /**
     * @dev The tier table itself -- three lines, not computed. Returned as a memory struct
     * rather than declared as `constant RiskTier` values because Solidity does not support
     * constant struct types ("Only constants of value type and byte array type are
     * implemented"); this is the closest equivalent that actually compiles, and it is still a
     * pure function with no storage read, so it costs nothing beyond the call itself.
     *
     * Bounds are leverage, not price move: gap risk (see the block comment above the struct
     * definition) scales with how fast the position's OWN value moves per unit of underlying
     * price move, which is leverage, not the size of any single mark-price step.
     */
    function _riskTierFor(uint256 leverage) internal pure returns (RiskTier memory) {
        if (leverage <= 5) return RiskTier(5_000, 6_000, 800); // 1-5x:   50% / 60% / 8%
        if (leverage <= 10) return RiskTier(4_000, 5_000, 1_000); // 6-10x:  40% / 50% / 10%
        // 11-20x: 25% / 35% / 12%. Positions above 20x are not covered by this table -- the
        // leverage cap on PositionToken creation currently keeps this branch's real domain at
        // 11-20x, but nothing here enforces that cap; see README's open items if it ever moves.
        return RiskTier(2_500, 3_500, 1_200);
    }
}
