// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC7540} from "@openzeppelin/community-contracts/contracts/token/ERC20/extensions/ERC7540.sol";
import {ERC7540AdminDeposit} from "@openzeppelin/community-contracts/contracts/token/ERC20/extensions/ERC7540AdminDeposit.sol";
import {ERC7540AdminRedeem} from "@openzeppelin/community-contracts/contracts/token/ERC20/extensions/ERC7540AdminRedeem.sol";
import {Direction} from "./ILaxuTypes.sol";

/**
 * @title PositionToken
 * @dev ERC-4626 vault (async, via ERC-7540) representing pro-rata ownership of one specific
 * Arcus perpetuals position. Deployed as an EIP-1167 minimal proxy clone by a Factory -- state is
 * set once via {initialize}, not a constructor.
 *
 * Built on OpenZeppelin community-contracts' {ERC7540} base combined with the
 * {ERC7540AdminDeposit} / {ERC7540AdminRedeem} fulfillment strategies: `arcusOperator` explicitly
 * transitions a controller's pending request to claimable, providing the exact exchange rate. That
 * matches this vault's real-world constraint -- a request can only become claimable after the
 * backend has actually moved margin on Arcus, not on a timer or a price tick.
 *
 * Two separate off-chain trust roles, kept visibly distinct even though one team runs both today:
 * - {creForwarder}: Chainlink CRE's forwarder. Reports price/funding only via {onReport}. Never
 *   moves capital.
 * - {arcusOperator}: confirms real capital movement on Arcus before a request becomes claimable,
 *   via {fulfillDepositRequest} / {fulfillRedeemRequest}, and closes the position via {close}.
 *   Never sets price.
 */
contract PositionToken is Initializable, ERC7540AdminDeposit, ERC7540AdminRedeem {
    using Math for uint256;

    /// @dev Fixed-point scale for entryPrice/markPrice, matching whatever CRE reports in.
    uint256 public constant PRICE_SCALE = 1e18;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Sanity cap so a misconfigured Factory call can't set an unreasonable/broken fee.
    uint256 public constant MAX_CREATOR_FEE_BPS = 2_000; // 20%

    // ---------------------------------------------------------------------
    // Position identity -- set once via `initialize`
    // ---------------------------------------------------------------------

    address public creator;
    bytes32 public market;
    Direction public direction;
    uint256 public leverage;
    uint256 public entryPrice;
    uint256 public size;
    /// @dev Actual margin/capital behind the position (not notional) -- minted as shares 1:1 at genesis.
    uint256 public initialDeposit;
    bytes32 public arcusPositionId;

    // ---------------------------------------------------------------------
    // Live oracle state -- written only via `onReport`, gated to `creForwarder`
    // ---------------------------------------------------------------------

    uint256 public markPrice;
    int256 public fundingAccrued;
    uint256 public lastReportTimestamp;

    // ---------------------------------------------------------------------
    // Off-chain trust roles
    // ---------------------------------------------------------------------

    address public creForwarder;
    address public arcusOperator;

    // ---------------------------------------------------------------------
    // Fees
    // ---------------------------------------------------------------------

    /// @dev TODO(fee-mechanic): flat only for now (meaningfully less code). A performance/carry
    /// fee would need a per-depositor high-water-mark; see spec.
    uint256 public creatorFeeBps;

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @dev Only meaningful once `closed` is true; defaults to `UserClosed` before that.
    enum ClosedReason {
        UserClosed,
        Liquidated
    }

    bool public closed;
    /// @dev Locked in once `closed = true`; redemptions after closure use this fixed value
    /// instead of a live (now meaningless) mark price.
    uint256 public finalNavValue;
    ClosedReason public closedReason;

    event PositionInitialized(address indexed creator, bytes32 market, uint256 leverage, uint256 initialDeposit);
    event FundingUpdated(uint256 markPrice, int256 fundingAccrued, uint256 timestamp);
    event DepositRequested(address indexed controller, uint256 assets, uint256 requestId);
    event RedeemRequested(address indexed controller, uint256 shares, uint256 requestId);
    event DepositFulfilled(uint256 requestId, uint256 fulfillmentPrice);
    event RedeemFulfilled(uint256 requestId, uint256 fulfillmentPrice);
    event CreatorFeeCollected(uint256 amount);
    event PositionClosed(uint256 finalNavValue, bool wasLiquidated);

    /**
     * @dev Implementation-contract constructor only -- clones never run this. `asset_` becomes an
     * immutable baked into the shared implementation bytecode, which every clone delegate-calls
     * into. That's safe here because every PositionToken clone (any market, any direction) is
     * denominated in the same underlying asset (USDG); `initialize` sanity-checks the Factory
     * agrees. Disables initializers on the implementation itself so it can't be mistaken for a
     * live position (clones each get their own initializer state and are unaffected).
     */
    constructor(IERC20 asset_) ERC20("", "") ERC7540(asset_) {
        _disableInitializers();
    }

    /// @dev Real metadata can't live in constructor-set storage (clones skip the constructor), so
    /// these are computed instead of stored.
    function name() public pure override(ERC20, IERC20Metadata) returns (string memory) {
        return "Laxu Position";
    }

    function symbol() public pure override(ERC20, IERC20Metadata) returns (string memory) {
        return "LAXU-POS";
    }

    /**
     * @dev Called once by the Factory immediately after cloning. Mints `_initialDeposit` shares to
     * `_creator` at 1:1 (bootstrap price = 1) -- safe from inflation-attack concerns since only the
     * Factory calls this, exactly once, atomically with position creation (no empty-vault window).
     */
    function initialize(
        address _creator,
        bytes32 _market,
        Direction _direction,
        uint256 _leverage,
        uint256 _entryPrice,
        uint256 _size,
        uint256 _initialDeposit,
        bytes32 _arcusPositionId,
        address _asset,
        address _creForwarder,
        address _arcusOperator,
        uint256 _creatorFeeBps
    ) external initializer {
        require(_creator != address(0), "PositionToken: zero creator");
        // asset() reads the immutable set at implementation-deploy time (see constructor); this is
        // a sanity check that the Factory is wiring up the asset it thinks it is, not a live setter.
        require(_asset == asset(), "PositionToken: asset mismatch");
        require(_creForwarder != address(0), "PositionToken: zero forwarder");
        require(_arcusOperator != address(0), "PositionToken: zero operator");
        require(_entryPrice > 0, "PositionToken: zero entry price");
        require(_initialDeposit > 0, "PositionToken: zero deposit");
        require(_creatorFeeBps <= MAX_CREATOR_FEE_BPS, "PositionToken: fee too high");

        creator = _creator;
        market = _market;
        direction = _direction;
        leverage = _leverage;
        entryPrice = _entryPrice;
        size = _size;
        initialDeposit = _initialDeposit;
        arcusPositionId = _arcusPositionId;
        creForwarder = _creForwarder;
        arcusOperator = _arcusOperator;
        creatorFeeBps = _creatorFeeBps;

        // Bootstrap price = 1: mark == entry means PnL == 0 the instant the vault exists, so
        // totalAssets() == initialDeposit right after the mint below.
        markPrice = _entryPrice;
        lastReportTimestamp = block.timestamp;

        _mint(_creator, _initialDeposit);

        emit PositionInitialized(_creator, _market, _leverage, _initialDeposit);
    }

    // ---------------------------------------------------------------------
    // totalAssets() -- the core formula
    // ---------------------------------------------------------------------

    /**
     * @dev Total current value (principal + PnL + funding), not PnL alone -- if this computed
     * PnL alone, totalAssets() / totalSupply() would collapse the share price to near-zero
     * whenever PnL is merely flat.
     */
    function totalAssets() public view override returns (uint256) {
        if (closed) {
            return finalNavValue;
        }

        // TODO(liquidation): if this ever computes <= 0 while `closed` is still false, the
        // backend/CRE path should have already called close(..., wasLiquidated: true) -- a
        // zero-value-but-still-"open" position is a misleading state. Clamping to zero here is a
        // defensive backstop, not the primary liquidation mechanism (see spec's open decision #3).
        int256 value = _computeValue(markPrice, fundingAccrued);
        return value > 0 ? uint256(value) : 0;
    }

    /// @dev Shared PnL/value formula used by {totalAssets}, {close}, and {currentPnLBps}.
    function _computeValue(uint256 mark, int256 funding) internal view returns (int256) {
        int256 pnl = (int256(size) * (int256(mark) - int256(entryPrice))) / int256(PRICE_SCALE);
        if (direction == Direction.Short) pnl = -pnl;
        return int256(initialDeposit) + pnl + funding;
    }

    // ---------------------------------------------------------------------
    // CRE reporting -- price/funding only, never capital movement
    // ---------------------------------------------------------------------

    function onReport(bytes calldata metadata, bytes calldata report) external {
        require(msg.sender == creForwarder, "PositionToken: not CRE forwarder");
        require(!closed, "PositionToken: position closed");

        (uint256 newMarkPrice, int256 newFunding, uint256 reportTimestamp) = abi.decode(
            report,
            (uint256, int256, uint256)
        );
        require(reportTimestamp > lastReportTimestamp, "PositionToken: stale report");

        markPrice = newMarkPrice;
        fundingAccrued = newFunding;
        lastReportTimestamp = reportTimestamp;

        emit FundingUpdated(newMarkPrice, newFunding, reportTimestamp);
    }

    // ---------------------------------------------------------------------
    // Deposit / redeem -- async, with a real off-chain leg
    // ---------------------------------------------------------------------

    /**
     * @dev Skims the flat creator fee from `assets` before the request enters the pending-deposit
     * queue: the depositor's wallet is debited `assets` total, but only `assets - fee` becomes
     * their claimable position (fee taken from assets, not shares -- the depositor bears the cost
     * up front rather than receiving fewer shares later).
     */
    function requestDeposit(
        uint256 assets,
        address controller,
        address owner
    ) public override returns (uint256 requestId) {
        require(!closed, "PositionToken: position closed");

        uint256 fee = assets.mulDiv(creatorFeeBps, BPS_DENOMINATOR);
        uint256 netAssets = assets - fee;

        requestId = super.requestDeposit(netAssets, controller, owner);

        if (fee > 0) {
            SafeERC20.safeTransferFrom(IERC20(asset()), owner, creator, fee);
            emit CreatorFeeCollected(fee);
        }

        emit DepositRequested(controller, netAssets, requestId);
    }

    function requestRedeem(uint256 shares, address controller, address owner) public override returns (uint256 requestId) {
        require(!closed, "PositionToken: position closed");
        requestId = super.requestRedeem(shares, controller, owner);
        emit RedeemRequested(controller, shares, requestId);
    }

    /// @dev Combining ERC7540AdminDeposit and ERC7540AdminRedeem creates a diamond on these two
    /// internal hooks (each parent only overrides the one it cares about); resolve by delegating
    /// to whichever parent implements it, matching OZ's own ERC7540AdminMock pattern.
    function _requestDeposit(
        uint256 assets,
        address controller,
        address owner,
        uint256 requestId
    ) internal override(ERC7540, ERC7540AdminDeposit) returns (uint256) {
        return super._requestDeposit(assets, controller, owner, requestId);
    }

    function _requestRedeem(
        uint256 shares,
        address controller,
        address owner,
        uint256 requestId
    ) internal override(ERC7540, ERC7540AdminRedeem) returns (uint256) {
        return super._requestRedeem(shares, controller, owner, requestId);
    }

    /**
     * @dev Called AFTER the backend confirms the Arcus margin-add succeeded. Fulfills the
     * controller's entire pending deposit at `fulfillmentPrice` (NAV per share, in PRICE_SCALE
     * fixed-point -- matching the genesis bootstrap price of `PRICE_SCALE` == 1:1), moving it from
     * pending to claimable.
     *
     * NOTE: the base {ERC7540AdminDeposit} strategy tracks pending/claimable state per-controller
     * only (all requests share `requestId = 0`), not in a per-request queue, so `controller` is
     * required here to identify whose request to fulfill; `requestId` is kept for interface/event
     * parity with the spec and is always 0.
     */
    function fulfillDepositRequest(uint256 requestId, address controller, uint256 fulfillmentPrice) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(requestId == 0, "PositionToken: invalid requestId");
        require(fulfillmentPrice > 0, "PositionToken: invalid price");

        uint256 assets = pendingDepositRequest(requestId, controller);
        require(assets > 0, "PositionToken: no pending deposit");

        uint256 shares = assets.mulDiv(PRICE_SCALE, fulfillmentPrice);
        _fulfillDeposit(assets, shares, controller);

        emit DepositFulfilled(requestId, fulfillmentPrice);
    }

    /**
     * @dev Called AFTER the backend confirms the Arcus margin-reduction succeeded AND has sent the
     * freed USDG back into this contract. Fulfills the controller's entire pending redeem at
     * `fulfillmentPrice` (NAV per share, in PRICE_SCALE fixed-point), moving it from pending to
     * claimable. See {fulfillDepositRequest} for why `controller` is required alongside `requestId`.
     */
    function fulfillRedeemRequest(uint256 requestId, address controller, uint256 fulfillmentPrice) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(requestId == 0, "PositionToken: invalid requestId");
        require(fulfillmentPrice > 0, "PositionToken: invalid price");

        uint256 shares = pendingRedeemRequest(requestId, controller);
        require(shares > 0, "PositionToken: no pending redeem");

        uint256 assets = shares.mulDiv(fulfillmentPrice, PRICE_SCALE);
        require(
            IERC20(asset()).balanceOf(address(this)) >= assets,
            "PositionToken: insufficient assets to fulfill redeem"
        );

        _fulfillRedeem(shares, assets, controller);

        emit RedeemFulfilled(requestId, fulfillmentPrice);
    }

    // ---------------------------------------------------------------------
    // Position lifecycle
    // ---------------------------------------------------------------------

    function close(uint256 finalMarkPrice, int256 finalFunding, bool wasLiquidated) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(!closed, "PositionToken: already closed");

        int256 value = _computeValue(finalMarkPrice, finalFunding);
        finalNavValue = value > 0 ? uint256(value) : 0;
        closed = true;
        closedReason = wasLiquidated ? ClosedReason.Liquidated : ClosedReason.UserClosed;

        markPrice = finalMarkPrice;
        fundingAccrued = finalFunding;
        lastReportTimestamp = block.timestamp;

        emit PositionClosed(finalNavValue, wasLiquidated);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function positionInfo()
        external
        view
        returns (
            bytes32 market_,
            Direction direction_,
            uint256 leverage_,
            uint256 entryPrice_,
            uint256 markPrice_,
            bool closed_
        )
    {
        return (market, direction, leverage, entryPrice, markPrice, closed);
    }

    /// @dev Live PnL + funding relative to initialDeposit, in basis points. Uses the current
    /// on-chain mark/funding even once closed; for the value locked in at closure use
    /// {finalNavValue} directly.
    function currentPnLBps() external view returns (int256) {
        int256 pnl = _computeValue(markPrice, fundingAccrued) - int256(initialDeposit);
        return (pnl * int256(BPS_DENOMINATOR)) / int256(initialDeposit);
    }
}
