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
 * and {requestClose} asks the backend to unwind a position they wholly own.
 *
 * Closing runs close -> settle -> claim: {close} freezes the value, the backend withdraws the
 * margin from Arcus into this contract and records the amount actually recovered via {settle},
 * then every holder takes their pro-rata slice of it via {claim} (or is pushed it via {claimFor}).
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
    /// Historical record only; the value formula uses {capital}.
    uint256 public initialDeposit;
    bytes32 public arcusPositionId;
    /// @dev Optional, empty until {list}, which sets it once and for good -- see {name} for why
    /// there is deliberately no other setter, even gated to `creator`.
    string public nickname;

    // ---------------------------------------------------------------------
    // Listing -- the creator decides when others can buy in
    // ---------------------------------------------------------------------

    /// @dev One-way, flipped by {list}. Before listing only the creator can deposit (e.g. topping up
    /// margin); after, anyone can buy in. {requestClose} still works once the creator holds 100% again.
    bool public listed;

    // ---------------------------------------------------------------------
    // Live oracle state -- written only via `applyReport`, gated to `arcusOperator`
    // ---------------------------------------------------------------------

    uint256 public markPrice;
    int256 public fundingAccrued;
    uint256 public lastReportTimestamp;

    // ---------------------------------------------------------------------
    // Capital accounting -- buy-ins and redeems resize the position, never re-lever it
    // ---------------------------------------------------------------------

    /// @dev USDG backing the position now. Starts equal to `initialDeposit`, grows by each
    /// buy-in's assets and shrinks by each redeemer's fraction.
    uint256 public capital;
    /// @dev The part of `fundingAccrued` (Arcus's cumulative funding since open) already paid out
    /// to redeemers in cash -- netted out in {_computeValue} so it is never counted twice.
    int256 public fundingSettled;

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
    /// @dev Locked in once `closed = true`: the formula estimate that values the shares until
    /// {settle} replaces it with the USDG actually recovered.
    uint256 public finalNavValue;
    ClosedReason public closedReason;

    // ---------------------------------------------------------------------
    // Settlement -- the USDG actually recovered from Arcus, shared out by {claim}
    // ---------------------------------------------------------------------

    bool public settled;
    /// @dev USDG holders share, set once by {settle}. The real recovery, not the formula estimate
    /// in `finalNavValue` -- a liquidation's leftover after Arcus's penalty is often below it.
    uint256 public settlementAssets;
    /// @dev Paid out of `settlementAssets` so far.
    uint256 public claimedAssets;

    // ---------------------------------------------------------------------
    // Per-holder stop loss / take profit -- a triggered level is an automatic redeem of that one
    // holder's wallet balance, never a stop order on the shared Arcus position
    // ---------------------------------------------------------------------

    /// @dev The creator's levels, set once at creation and never editable: every holder who hasn't
    /// chosen their own relies on them. Underlying-asset prices at PRICE_SCALE; 0 = none.
    uint256 public defaultStopLoss;
    uint256 public defaultTakeProfit;
    /// @dev Switched off by {retireDefaultTriggers} once a default has fired, so later buyers
    /// don't inherit a plan that has already played out.
    bool public defaultsActive;

    struct HolderTriggers {
        bool custom; // false = use the defaults
        uint128 stopLoss; // PRICE_SCALE; 0 = none (only meaningful when custom)
        uint128 takeProfit;
    }

    /// @dev Keyed by address, not attached to tokens: receiving tokens never copies the sender's.
    mapping(address => HolderTriggers) public holderTriggers;

    event PositionInitialized(address indexed creator, bytes32 market, uint256 leverage, uint256 initialDeposit);
    event FundingUpdated(uint256 markPrice, int256 fundingAccrued, uint256 timestamp);
    event DepositRequested(address indexed controller, uint256 assets, uint256 requestId);
    event RedeemRequested(address indexed controller, uint256 shares, uint256 requestId);
    event DepositFulfilled(
        address indexed controller,
        uint256 assets,
        uint256 shares,
        uint256 navPerShare,
        uint256 addedSize,
        uint256 fillPrice
    );
    event RedeemFulfilled(
        address indexed controller,
        uint256 shares,
        uint256 assets,
        uint256 navPerShare,
        uint256 closedSize,
        uint256 fillPrice
    );
    event CreatorFeeCollected(uint256 amount);
    event PositionClosed(uint256 finalNavValue, bool wasLiquidated);
    event Listed(string nickname);
    event CloseRequested(address indexed creator);
    event DepositRequestCancelled(address indexed controller, uint256 assets);
    event RedeemRequestCancelled(address indexed controller, uint256 shares);
    event Settled(uint256 assets, uint256 supply);
    event Claimed(address indexed holder, uint256 shares, uint256 assets);
    event TriggersSet(address indexed holder, uint256 stopLoss, uint256 takeProfit, bool custom);
    event TriggerExecuted(
        address indexed holder,
        bool isStopLoss,
        bool usedDefault,
        uint256 shares,
        uint256 assets,
        uint256 markPrice
    );
    event DefaultTriggersRetired(uint256 markPrice);

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
            _shortId(arcusPositionId)
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

    /// @dev First 4 bytes of `arcusPositionId` as 8 lowercase hex chars, no `0x`. The id is an opaque
    /// hash (keccak256 of the Arcus order id), not text, so it can't be rendered as a string; this
    /// short prefix is enough to tell positions apart in a wallet or explorer.
    function _shortId(bytes32 id) internal pure returns (string memory) {
        bytes memory out = new bytes(8);
        for (uint256 i = 0; i < 4; i++) {
            out[2 * i] = _HEX[uint8(id[i]) >> 4];
            out[2 * i + 1] = _HEX[uint8(id[i]) & 0x0f];
        }
        return string(out);
    }

    bytes16 private constant _HEX = "0123456789abcdef";

    /// @dev `market` is a null-padded short ASCII string (see {ethers-encodeBytes32String} on the
    /// caller side); trims the trailing null bytes back into a normal string.
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
        address _arcusOperator,
        uint256 _defaultStopLoss,
        uint256 _defaultTakeProfit
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
        capital = _initialDeposit;
        arcusPositionId = _arcusPositionId;
        arcusOperator = _arcusOperator;
        // `nickname` stays empty until {list}.

        _validateLevels(_defaultStopLoss, _defaultTakeProfit, _entryPrice);
        defaultStopLoss = _defaultStopLoss;
        defaultTakeProfit = _defaultTakeProfit;
        defaultsActive = _defaultStopLoss != 0 || _defaultTakeProfit != 0;

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
        // Every claim burns shares and pays the matching assets, so totalAssets / totalSupply stays
        // constant through the claim period -- collateral valuation holds until the last claim.
        if (settled) return settlementAssets - claimedAssets;
        if (closed) return finalNavValue; // estimate until settled

        // TODO(liquidation): if this ever computes <= 0 while `closed` is still false, the
        // backend should have already called close(..., wasLiquidated: true) -- a
        // zero-value-but-still-"open" position is a misleading state. Clamping to zero here is a
        // defensive backstop, not the primary liquidation mechanism (see spec's open decision #3).
        int256 value = _computeValue(markPrice, fundingAccrued);
        return value > 0 ? uint256(value) : 0;
    }

    /// @dev Shared PnL/value formula used by {totalAssets} and {close}. `funding` is Arcus's
    /// cumulative total for the whole position; the part already paid to redeemers is netted out.
    function _computeValue(uint256 mark, int256 funding) internal view returns (int256) {
        int256 pnl = (int256(size) * (int256(mark) - int256(entryPrice))) / int256(PRICE_SCALE);
        if (direction == Direction.Short) pnl = -pnl;
        return int256(capital) + pnl + (funding - fundingSettled);
    }

    /// @dev USDG per share, PRICE_SCALE fixed point. `totalSupply()` includes shares with a redeem
    /// pending (library behaviour), so a redeemer is priced against the pre-redeem supply.
    function navPerShare() public view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? PRICE_SCALE : totalAssets().mulDiv(PRICE_SCALE, supply);
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
     * @dev Called AFTER the backend has grown the Arcus position for this buy-in. The contract
     * prices the shares itself at the current {navPerShare} (the backend pushes a fresh
     * {applyReport} first) and settles in the same transaction: the shares are minted straight to
     * the buyer, so nothing is ever left claimable-but-unclaimed and there is no claim step.
     *
     * A buy-in changes how big the position is, never how leveraged: `addedSize` is the actual
     * Arcus fill (the buyer's proportional share of the current size) at `fillPrice`, and the entry
     * becomes the size-weighted average. `addedSize` is 0 when the proportional add is below the
     * market's minimum order size -- the buy-in then backs the position as margin only.
     *
     * NOTE: the base {ERC7540AdminDeposit} strategy tracks pending/claimable state per-controller
     * only (all requests share `requestId = 0`), so `controller` identifies whose request to
     * fulfil; `requestId` is kept for interface parity and is always 0.
     */
    function fulfillDepositRequest(uint256 requestId, address controller, uint256 addedSize, uint256 fillPrice) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(requestId == 0, "PositionToken: invalid requestId");
        require(!closed, "PositionToken: position closed");

        uint256 assets = pendingDepositRequest(0, controller);
        require(assets > 0, "PositionToken: no pending deposit");

        uint256 nav = navPerShare(); // at the latest reported mark
        require(nav > 0, "PositionToken: zero NAV");
        uint256 shares = assets.mulDiv(PRICE_SCALE, nav);

        _fulfillDeposit(assets, shares, controller);
        // Auto-settle: mint the shares straight to the buyer ({requestDeposit} guarantees
        // controller == the address that requested).
        uint256 minted = _consumeClaimableDeposit(assets, controller);
        _deposit(controller, controller, assets, minted);

        // Grow the position: weighted-average entry, then size and capital.
        if (addedSize > 0) {
            require(fillPrice > 0, "PositionToken: invalid fill price");
            entryPrice = (size * entryPrice + addedSize * fillPrice) / (size + addedSize);
            size += addedSize;
        }
        capital += assets;

        emit DepositFulfilled(controller, assets, minted, nav, addedSize, fillPrice);
    }

    /**
     * @dev Called AFTER the backend has shrunk the Arcus position by the redeemer's fraction
     * `f = shares / totalSupply()` and made sure this contract holds enough USDG to pay. Pays
     * `f x totalAssets()` straight to the redeemer and shrinks capital and effective funding by
     * the same `f`, so every remaining share still represents the same slice of the same trade.
     *
     * `closedSize` is the actual reduce-only fill on Arcus (0 when the proportional reduction was
     * below the market's minimum order size). A partial close leaves the entry price unchanged.
     *
     * Blocked once closed: a redeem still pending at close is paid out of the settlement by {claim}.
     */
    function fulfillRedeemRequest(uint256 requestId, address controller, uint256 closedSize, uint256 fillPrice) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(requestId == 0, "PositionToken: invalid requestId");
        require(!closed, "PositionToken: position closed");

        uint256 shares = pendingRedeemRequest(0, controller);
        require(shares > 0, "PositionToken: no pending redeem");

        uint256 supply = totalSupply(); // BEFORE settlement; includes these pending shares
        uint256 nav = navPerShare();
        uint256 assets = shares.mulDiv(nav, PRICE_SCALE);
        require(
            IERC20(asset()).balanceOf(address(this)) >= assets,
            "PositionToken: insufficient assets to fulfill redeem"
        );

        // Shrink the position by the redeemer's fraction f = shares / supply.
        int256 fundingEff = fundingAccrued - fundingSettled;
        fundingSettled += (fundingEff * int256(shares)) / int256(supply);
        capital -= capital.mulDiv(shares, supply);
        // The actual Arcus reduce-only fill; entry is unchanged by a partial close.
        size = closedSize >= size ? 0 : size - closedSize;

        _fulfillRedeem(shares, assets, controller);
        // Auto-settle: send the USDG straight to the redeemer.
        uint256 paid = _consumeClaimableRedeem(shares, controller);
        _withdraw(controller, controller, controller, paid, shares);

        emit RedeemFulfilled(controller, shares, paid, nav, closedSize, fillPrice);

        _closeIfEmpty();
    }

    // ---------------------------------------------------------------------
    // Per-holder stop loss / take profit
    // ---------------------------------------------------------------------

    /// @dev Personal levels (0 = none for that side). Allowed with zero balance, so a buyer can set
    /// them before their buy-in settles. A level already breached at the current mark is rejected.
    function setTriggers(uint256 stopLoss, uint256 takeProfit) external {
        require(!closed, "PositionToken: position closed");
        _validateLevels(stopLoss, takeProfit, markPrice);
        holderTriggers[msg.sender] = HolderTriggers(true, uint128(stopLoss), uint128(takeProfit));
        emit TriggersSet(msg.sender, stopLoss, takeProfit, true);
    }

    /// @dev Explicitly no triggers -- the defaults will NOT apply.
    function clearTriggers() external {
        holderTriggers[msg.sender] = HolderTriggers(true, 0, 0);
        emit TriggersSet(msg.sender, 0, 0, true);
    }

    /// @dev Back to the creator's defaults.
    function useDefaultTriggers() external {
        delete holderTriggers[msg.sender];
        emit TriggersSet(msg.sender, 0, 0, false);
    }

    function effectiveTriggers(address holder)
        public
        view
        returns (uint256 stopLoss, uint256 takeProfit, bool usingDefault)
    {
        HolderTriggers memory t = holderTriggers[holder];
        if (t.custom) return (t.stopLoss, t.takeProfit, false);
        if (defaultsActive) return (defaultStopLoss, defaultTakeProfit, true);
        return (0, 0, true);
    }

    /// @dev Long: stop loss below `ref`, take profit above. Short: the reverse. 0 = none. The
    /// uint128 cap keeps {setTriggers}' narrowing cast lossless.
    function _validateLevels(uint256 sl, uint256 tp, uint256 ref) internal view {
        require(sl <= type(uint128).max && tp <= type(uint128).max, "PositionToken: level too large");
        if (direction == Direction.Long) {
            require(sl == 0 || sl < ref, "PositionToken: stop loss must be below price");
            require(tp == 0 || tp > ref, "PositionToken: take profit must be above price");
        } else {
            require(sl == 0 || sl > ref, "PositionToken: stop loss must be above price");
            require(tp == 0 || tp < ref, "PositionToken: take profit must be below price");
        }
    }

    /// @dev Whether `mark` has crossed `sl` / `tp` for this position's direction.
    function _levelsHit(uint256 sl, uint256 tp, uint256 mark) internal view returns (bool slHit, bool tpHit) {
        bool isLong = direction == Direction.Long;
        slHit = sl != 0 && (isLong ? mark <= sl : mark >= sl);
        tpHit = tp != 0 && (isLong ? mark >= tp : mark <= tp);
    }

    /**
     * @dev Exits `holder`'s wallet balance at the current NAV -- tokens posted as {LendingPool}
     * collateral are the pool's, not the holder's, and aren't covered. The backend has already
     * reduced the Arcus position by `closedSize` at `fillPrice` and put enough USDG here to pay.
     *
     * The operator can only exit a holder whose OWN effective level is breached at the stored
     * mark, and never picks the price: the payout is the contract's own {navPerShare}. The shrink
     * is the same proportional one as {fulfillRedeemRequest}, so every other holder keeps the same
     * slice of the same trade at the same leverage.
     */
    function executeTrigger(address holder, uint256 closedSize, uint256 fillPrice) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(!closed, "PositionToken: position closed");

        uint256 shares = balanceOf(holder);
        require(shares > 0, "PositionToken: nothing to exit");

        (uint256 sl, uint256 tp, bool usedDefault) = effectiveTriggers(holder);
        (bool slHit, bool tpHit) = _levelsHit(sl, tp, markPrice);
        require(slHit || tpHit, "PositionToken: trigger not hit");

        uint256 supply = totalSupply();
        uint256 nav = navPerShare();
        uint256 assets = shares.mulDiv(nav, PRICE_SCALE);
        require(
            IERC20(asset()).balanceOf(address(this)) >= assets + totalPendingDepositAssets(),
            "PositionToken: insufficient assets"
        );

        int256 fundingEff = fundingAccrued - fundingSettled;
        fundingSettled += (fundingEff * int256(shares)) / int256(supply);
        capital -= capital.mulDiv(shares, supply);
        size = closedSize >= size ? 0 : size - closedSize;

        _burn(holder, shares);
        if (!usedDefault) delete holderTriggers[holder]; // a personal trigger fires once
        SafeERC20.safeTransfer(IERC20(asset()), holder, assets);
        emit TriggerExecuted(holder, slHit, usedDefault, shares, assets, markPrice);
        fillPrice; // the Arcus fill is recorded off-chain; kept for parity with fulfillRedeemRequest

        _closeIfEmpty();
    }

    /// @dev Once a default level has been crossed, the creator's plan has played out: stop applying
    /// the defaults to anyone who buys in later. Only callable while a default is actually breached.
    function retireDefaultTriggers() external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(defaultsActive, "PositionToken: defaults not active");
        (bool slHit, bool tpHit) = _levelsHit(defaultStopLoss, defaultTakeProfit, markPrice);
        require(slHit || tpHit, "PositionToken: default not hit");
        defaultsActive = false;
        emit DefaultTriggersRetired(markPrice);
    }

    /// @dev The last share leaving -- by trigger or redeem -- would otherwise leave an "open"
    /// position with no holders and no capital. Close and settle it at zero in place; any buy-in
    /// still pending can then be refunded immediately via {cancelDepositRequest}.
    function _closeIfEmpty() internal {
        if (totalSupply() == 0 && !closed) {
            closed = true;
            closedReason = ClosedReason.UserClosed;
            finalNavValue = 0;
            settled = true;
            settlementAssets = 0;
            emit PositionClosed(0, false);
            emit Settled(0, 0);
        }
    }

    // ---------------------------------------------------------------------
    // Cancel -- the user's escape hatch when a request is never fulfilled
    // ---------------------------------------------------------------------

    /**
     * @dev No separate double-processing guard is needed against the fulfil functions: both sides
     * require a non-zero pending amount, so whichever transaction lands first wins and the other
     * reverts. Fulfils settle instantly, so a fulfilled request leaves nothing here to cancel.
     *
     * Once closed the buy-in can never happen, so the refund is available immediately.
     *
     * NOTE: the buy-in fee was already paid to the creator at {requestDeposit} and is not refunded.
     */
    function cancelDepositRequest() external returns (uint256 assets) {
        address controller = msg.sender;
        require(
            closed || block.timestamp >= lastDepositRequestAt[controller] + REQUEST_CANCEL_TIMEOUT,
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
     * @dev Listed positions may close too: buy-ins and redeems auto-settle, so once the creator has
     * bought everyone back out no buyer can be stuck mid-flight. What each check covers:
     * - full supply: `totalSupply()` includes shares with a redeem pending, so anyone else's
     *   pending redeem breaks it; so do tokens posted as {LendingPool} collateral, since the pool
     *   holds them -- the creator repays and withdraws before closing.
     * - no pending deposit: a pending buy-in or top-up has to settle first.
     */
    function requestClose() external {
        require(msg.sender == creator, "PositionToken: not creator");
        require(!closed, "PositionToken: already closed");
        require(!closeRequested, "PositionToken: close already requested");
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
    // Settlement & claims
    // ---------------------------------------------------------------------

    /**
     * @dev Records the USDG actually recovered from Arcus, once it sits in this contract. Pending
     * buy-ins are still owed back as refunds (via {cancelDepositRequest}), so the balance must cover
     * both. `assets` may be 0 -- a fully wiped liquidation.
     */
    function settle(uint256 assets) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(closed, "PositionToken: not closed");
        require(!settled, "PositionToken: already settled");
        require(
            IERC20(asset()).balanceOf(address(this)) >= assets + totalPendingDepositAssets(),
            "PositionToken: settlement not funded"
        );
        settled = true;
        settlementAssets = assets;
        emit Settled(assets, totalSupply());
    }

    function claim() external returns (uint256 assets) {
        return _claim(msg.sender);
    }

    /// @dev Anyone can call; the money always goes to `holder`, never the caller. EOAs only, so
    /// USDG is never pushed into a contract that can't use it (e.g. a LendingPool holding collateral).
    function claimFor(address holder) external returns (uint256 assets) {
        require(holder.code.length == 0, "PositionToken: holder is a contract");
        return _claim(holder);
    }

    /// @dev Pays `holder` their pro-rata slice of what is left, for their balance plus any redeem
    /// caught pending at close. Burning the matching shares keeps the rate constant for the rest.
    function _claim(address holder) internal returns (uint256 assets) {
        require(settled, "PositionToken: not settled");

        uint256 held = balanceOf(holder);
        uint256 pendingRedeem = _redeems[holder].pendingShares;
        uint256 shares = held + pendingRedeem;
        require(shares > 0, "PositionToken: nothing to claim");

        assets = shares.mulDiv(settlementAssets - claimedAssets, totalSupply());

        if (pendingRedeem > 0) {
            // Those shares were burned at request time; drop them from the virtual supply.
            _redeems[holder].pendingShares = 0;
            _totalPendingRedeemShares -= pendingRedeem;
        }
        if (held > 0) _burn(holder, held);

        claimedAssets += assets;
        SafeERC20.safeTransfer(IERC20(asset()), holder, assets);
        emit Claimed(holder, shares, assets);
    }

    /// @dev Buy-in USDG sits here as a buffer while the backend fronts the matching margin on
    /// Arcus. After settlement, anything beyond what is still owed belongs to that float.
    function recoverExcess(address to) external {
        require(msg.sender == arcusOperator, "PositionToken: not backend operator");
        require(settled, "PositionToken: not settled");
        uint256 owed = (settlementAssets - claimedAssets) + totalPendingDepositAssets();
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        require(bal > owed, "PositionToken: nothing to recover");
        SafeERC20.safeTransfer(IERC20(asset()), to, bal - owed);
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

    /// @dev NAV per share against the genesis value of 1.0, in basis points. Buy-ins and redeems
    /// both happen at NAV, so this stays correct through any number of them.
    function currentPnLBps() external view returns (int256) {
        return ((int256(navPerShare()) - int256(PRICE_SCALE)) * int256(BPS_DENOMINATOR)) / int256(PRICE_SCALE);
    }
}
