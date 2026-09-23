// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC7540} from "./vendor/ERC7540.sol";
import {ERC7540AdminDeposit} from "./vendor/ERC7540AdminDeposit.sol";
import {ERC7540AdminRedeem} from "./vendor/ERC7540AdminRedeem.sol";
import {Direction} from "./ILaxuTypes.sol";

/**
 * @title PositionToken
 * @dev ERC-4626 vault (async, via ERC-7540) representing pro-rata ownership of one specific
 * Arcus perpetuals position. Deployed as an EIP-1167 minimal proxy clone by a Factory -- state is
 * set once via {initialize}, not a constructor.
 *
 * Built on OpenZeppelin community-contracts' {ERC7540} base combined with the
 * {ERC7540AdminDeposit} / {ERC7540AdminRedeem} fulfillment strategies (vendored under ./vendor/ so
 * {cancelDepositRequest} / {cancelRedeemRequest} can reach the pending-request state):
 * `arcusOperator` explicitly fulfils a controller's pending request, providing the exact exchange
 * rate, and the request settles in the same transaction. That matches this vault's real-world
 * constraint -- a request can only settle after the backend has actually moved margin on Arcus,
 * not on a timer or a price tick.
 *
 * `arcusOperator` is the one off-chain trust role: it reports price/funding via {applyReport},
 * confirms real capital movement on Arcus before a request settles (via
 * {fulfillDepositRequest} / {fulfillRedeemRequest}), and closes the position via {close}. It is the
 * same backend wallet as the Factory's `deployer`, same trust level as everything else it does.
 *
 * The creator controls two moments: {list} opens the position to buy-ins (and sets the nickname),
 * and {requestClose} asks the backend to unwind an unlisted position they wholly own.
 */
contract PositionToken is Initializable, ERC7540AdminDeposit, ERC7540AdminRedeem {
    using Math for uint256;
    using Strings for uint256;

    /// @dev Fixed-point scale for entryPrice/markPrice, matching whatever the backend reports in.
    uint256 public constant PRICE_SCALE = 1e18;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    uint256 public constant BUY_IN_FEE_BPS = 200; // 2%, protocol-wide, paid to the creator

    uint256 public constant MAX_NICKNAME_LENGTH = 32; // bytes

    /// @dev How long a request must sit unfulfilled before its controller can cancel it and take
    /// the money back -- the escape hatch if the backend is down or the Arcus leg fails.
    uint256 public constant REQUEST_CANCEL_TIMEOUT = 20 minutes;

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
    /// @dev Optional, empty until {list}, which sets it once and for good -- see {name} for why
    /// there is deliberately no other setter, even gated to `creator`.
    string public nickname;

    // ---------------------------------------------------------------------
    // Listing -- the creator decides when others can buy in
    // ---------------------------------------------------------------------

    /// @dev One-way, flipped by {list}. Before listing only the creator can deposit (e.g. topping up
    /// margin); after, anyone can buy in, and the creator exits by redeeming rather than {requestClose}.
    bool public listed;

    // ---------------------------------------------------------------------
    // Live oracle state -- written only via `applyReport`, gated to `arcusOperator`
    // ---------------------------------------------------------------------

    uint256 public markPrice;
    int256 public fundingAccrued;
    uint256 public lastReportTimestamp;

    // ---------------------------------------------------------------------
    // Off-chain trust role
    // ---------------------------------------------------------------------

    address public arcusOperator;

    // ---------------------------------------------------------------------
    // Request timestamps -- start the {REQUEST_CANCEL_TIMEOUT} clock
    // ---------------------------------------------------------------------

    /// @dev The library sums a controller's requests into one pending amount, so any new request
    /// restarts that controller's clock.
    mapping(address => uint256) public lastDepositRequestAt;
    mapping(address => uint256) public lastRedeemRequestAt;

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @dev Only meaningful once `closed` is true; defaults to `UserClosed` before that.
    enum ClosedReason {
        UserClosed,
        Liquidated
    }

    bool public closed;
    /// @dev Set by the creator via {requestClose}; {close} requires it unless recording a liquidation.
    bool public closeRequested;
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
    event Listed(string nickname);
    event CloseRequested(address indexed creator);
    event DepositRequestCancelled(address indexed controller, uint256 assets);
    event RedeemRequestCancelled(address indexed controller, uint256 shares);

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

    /**
     * @dev Real metadata can't live in constructor-set storage (clones skip the constructor), so
     * these are `view` and derived from each clone's own storage (set via {initialize}), the same
     * way `entryPrice`/`size`/etc. already work per-clone -- otherwise every clone would
     * `delegatecall` into the same shared logic bytecode and return an identical hardcoded string.
     *
     * The structured part ("Laxu ETH Long 5x #<id>") always leads and is never replaced -- wherever
     * this token surfaces (Etherscan, a wallet, a third-party marketplace), that's the first thing
     * shown. `nickname` is strictly an optional suffix, so a self-chosen name like "Official Laxu
     * Treasury" can only ever render as "Laxu ETH Long 5x #<id> · Official Laxu Treasury" --
     * obviously self-appointed flavor text, never a credible standalone claim.
     */
    function name() public view override(ERC20, IERC20Metadata) returns (string memory) {
        string memory base = string.concat(
            "Laxu ",
            marketLabel(),
            " ",
            directionLabel(),
            " ",
            leverageLabel(),
            " #",
            _bytes32ToString(arcusPositionId)
        );
        if (bytes(nickname).length == 0) return base;
        return string.concat(base, unicode" · ", nickname);
    }

    function symbol() public view override(ERC20, IERC20Metadata) returns (string memory) {
        return string.concat("l", marketLabel(), "-", leverageLabel(), direction == Direction.Short ? "S" : "L");
    }

    function marketLabel() internal view returns (string memory) {
        return _bytes32ToString(market);
    }

    function directionLabel() internal view returns (string memory) {
        return direction == Direction.Short ? "Short" : "Long";
    }

    function leverageLabel() internal view returns (string memory) {
        return string.concat(leverage.toString(), "x");
    }

    /// @dev `market` and `arcusPositionId` are both null-padded short ASCII strings (see
    /// {ethers-encodeBytes32String} on the caller side); trims the trailing null bytes back into a
    /// normal string.
    function _bytes32ToString(bytes32 raw) internal pure returns (string memory) {
        uint256 length;
        while (length < 32 && raw[length] != 0) {
            length++;
        }
        bytes memory result = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            result[i] = raw[i];
        }
        return string(result);
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
        address _arcusOperator
    ) external initializer {
        require(_creator != address(0), "PositionToken: zero creator");
        // asset() reads the immutable set at implementation-deploy time (see constructor); this is
        // a sanity check that the Factory is wiring up the asset it thinks it is, not a live setter.
        require(_asset == asset(), "PositionToken: asset mismatch");
        require(_arcusOperator != address(0), "PositionToken: zero operator");
        require(_entryPrice > 0, "PositionToken: zero entry price");
        require(_initialDeposit > 0, "PositionToken: zero deposit");

        creator = _creator;
        market = _market;
        direction = _direction;
        leverage = _leverage;
        entryPrice = _entryPrice;
        size = _size;
        initialDeposit = _initialDeposit;
        arcusPositionId = _arcusPositionId;
        arcusOperator = _arcusOperator;
        // `nickname` stays empty until {list}.

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
        // backend should have already called close(..., wasLiquidated: true) -- a
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
    // Price/funding reporting -- backend only, never capital movement
    // ---------------------------------------------------------------------

    function applyReport(uint256 newMarkPrice, int256 newFunding, uint256 reportTimestamp) external {
        require(msg.sender == arcusOperator, "PositionToken: not arcusOperator");
        require(!closed, "PositionToken: position closed");
        require(reportTimestamp > lastReportTimestamp, "PositionToken: stale report");

        markPrice = newMarkPrice;
        fundingAccrued = newFunding;
        lastReportTimestamp = reportTimestamp;

        emit FundingUpdated(newMarkPrice, newFunding, reportTimestamp);
    }

    /// @dev One combined read so the backend's reporting job is not making three separate calls
    /// per position to decide whether a report has moved enough to be worth pushing an update for.
    function getLastReport() external view returns (uint256, int256, uint256) {
        return (markPrice, fundingAccrued, lastReportTimestamp);
    }

    // ---------------------------------------------------------------------
    // Listing
    // ---------------------------------------------------------------------

    /// @dev One-way. The nickname is set here, once, and never again. Pass "" for no nickname.
    function list(string calldata _nickname) external {
        require(msg.sender == creator, "PositionToken: not creator");
        require(!listed, "PositionToken: already listed");
        require(!closed, "PositionToken: position closed");
        require(bytes(_nickname).length <= MAX_NICKNAME_LENGTH, "PositionToken: nickname too long");
        listed = true;
        nickname = _nickname;
        emit Listed(_nickname);
    }

    // ---------------------------------------------------------------------
    // Deposit / redeem -- async, with a real off-chain leg
    // ---------------------------------------------------------------------

    /**
     * @dev Skims the flat {BUY_IN_FEE_BPS} from `assets` before the request enters the
     * pending-deposit queue: the depositor's wallet is debited `assets` total, but only
     * `assets - fee` becomes their position (fee taken from assets, not shares -- the depositor
     * bears the cost up front rather than receiving fewer shares later). The creator topping up
     * their own position pays no fee to themselves.
     */
    function requestDeposit(
        uint256 assets,
        address controller,
        address owner
    ) public override returns (uint256 requestId) {
        require(!closed, "PositionToken: position closed");
        // Auto-settle mints to whoever asked, so the caller must be both payer and recipient.
        require(
            controller == msg.sender && owner == msg.sender,
            "PositionToken: caller must be owner and controller"
        );
        // Before listing, only the creator can add to their own position (e.g. topping up margin).
        require(listed || msg.sender == creator, "PositionToken: not listed");

        uint256 fee = msg.sender == creator ? 0 : assets.mulDiv(BUY_IN_FEE_BPS, BPS_DENOMINATOR);
        uint256 netAssets = assets - fee;

        requestId = super.requestDeposit(netAssets, controller, owner);
        lastDepositRequestAt[controller] = block.timestamp;

        if (fee > 0) {
            SafeERC20.safeTransferFrom(IERC20(asset()), owner, creator, fee);
            emit CreatorFeeCollected(fee);
        }

        emit DepositRequested(controller, netAssets, requestId);
    }

    function requestRedeem(uint256 shares, address controller, address owner) public override returns (uint256 requestId) {
        require(!closed, "PositionToken: position closed");
        require(
            controller == msg.sender && owner == msg.sender,
            "PositionToken: caller must be owner and controller"
        );
        requestId = super.requestRedeem(shares, controller, owner);
        lastRedeemRequestAt[controller] = block.timestamp;
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
     * fixed-point -- matching the genesis bootstrap price of `PRICE_SCALE` == 1:1), and settles it
     * in the same transaction: the shares are minted straight to the buyer, so nothing is ever left
     * claimable-but-unclaimed and there is no claim step.
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

        // Auto-settle: mint the shares straight to the buyer ({requestDeposit} guarantees
        // controller == the address that requested).
        uint256 minted = _consumeClaimableDeposit(assets, controller);
        _deposit(controller, controller, assets, minted);

        emit DepositFulfilled(requestId, fulfillmentPrice);
    }

    /**
     * @dev Called AFTER the backend confirms the Arcus margin-reduction succeeded AND has sent the
     * freed USDG back into this contract. Fulfills the controller's entire pending redeem at
     * `fulfillmentPrice` (NAV per share, in PRICE_SCALE fixed-point) and pays the USDG straight to
     * the redeemer in the same transaction. See {fulfillDepositRequest} for why `controller` is
     * required alongside `requestId`.
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

        // Auto-settle: send the USDG straight to the redeemer.
        uint256 paid = _consumeClaimableRedeem(shares, controller);
        _withdraw(controller, controller, controller, paid, shares);

        emit RedeemFulfilled(requestId, fulfillmentPrice);
    }

    // ---------------------------------------------------------------------
    // Cancel -- the user's escape hatch when a request is never fulfilled
    // ---------------------------------------------------------------------

    /**
     * @dev No separate double-processing guard is needed against the fulfil functions: both sides
     * require a non-zero pending amount, so whichever transaction lands first wins and the other
     * reverts. Fulfils settle instantly, so a fulfilled request leaves nothing here to cancel.
     *
     * NOTE: the buy-in fee was already paid to the creator at {requestDeposit} and is not refunded.
     */
    function cancelDepositRequest() external returns (uint256 assets) {
        address controller = msg.sender;
        require(
            block.timestamp >= lastDepositRequestAt[controller] + REQUEST_CANCEL_TIMEOUT,
            "PositionToken: too early to cancel"
        );
        assets = _deposits[controller].pendingAssets;
        require(assets > 0, "PositionToken: no pending deposit");

        _deposits[controller].pendingAssets = 0;
        _totalPendingDepositAssets -= assets;
        SafeERC20.safeTransfer(IERC20(asset()), controller, assets);

        emit DepositRequestCancelled(controller, assets);
    }

    function cancelRedeemRequest() external returns (uint256 shares) {
        address controller = msg.sender;
        require(
            block.timestamp >= lastRedeemRequestAt[controller] + REQUEST_CANCEL_TIMEOUT,
            "PositionToken: too early to cancel"
        );
        shares = _redeems[controller].pendingShares;
        require(shares > 0, "PositionToken: no pending redeem");

        _redeems[controller].pendingShares = 0;
        _totalPendingRedeemShares -= shares;
        _mint(controller, shares); // shares were burned at request time; give them back

        emit RedeemRequestCancelled(controller, shares);
    }

    // ---------------------------------------------------------------------
    // Position lifecycle
    // ---------------------------------------------------------------------

    /**
     * @dev What each check covers:
     * - `!listed`: once listed, the creator exits by redeeming like everyone else.
     * - full supply: also fails while the creator's tokens are posted as {LendingPool} collateral,
     *   since the pool holds them -- the creator repays and withdraws before closing.
     * - no pending deposit: a pending top-up has to settle first.
     */
    function requestClose() external {
        require(msg.sender == creator, "PositionToken: not creator");
        require(!closed, "PositionToken: already closed");
        require(!closeRequested, "PositionToken: close already requested");
        require(!listed, "PositionToken: listed - exit via requestRedeem");
        require(balanceOf(creator) == totalSupply(), "PositionToken: creator must hold full supply");
        require(totalPendingDepositAssets() == 0, "PositionToken: deposit pending");
        closeRequested = true;
        emit CloseRequested(creator);
    }

    function close(uint256 finalMarkPrice, int256 finalFunding, bool wasLiquidated) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(!closed, "PositionToken: already closed");
        // Normal closes need the creator's request. Liquidations don't: Arcus already closed the
        // position, and the backend is only recording it.
        require(closeRequested || wasLiquidated, "PositionToken: no close request");

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
