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
import {IVenueReader} from "./interfaces/IVenueReader.sol";

/**
 * @title PositionToken
 * @dev ERC-4626 vault (async, via ERC-7540) representing pro-rata ownership of one specific
 * perpetuals position on an on-chain venue (Perpl on Monad). Deployed as an EIP-1167 minimal proxy
 * clone by a Factory -- state is set once via {initialize}, not a constructor.
 *
 * Built on OpenZeppelin community-contracts' {ERC7540} base combined with the
 * {ERC7540AdminDeposit} / {ERC7540AdminRedeem} fulfillment strategies (vendored under ./vendor/ so
 * {cancelDepositRequest} / {cancelRedeemRequest} can reach the pending-request state):
 * `operator` explicitly fulfils a controller's pending request, providing the exact exchange
 * rate, and the request settles in the same transaction. That matches this vault's real-world
 * constraint -- a request can only settle after the backend has actually moved margin on the
 * venue, not on a timer or a price tick.
 *
 * The mark price is NOT an operator input: it is read live from the venue through `venueReader`
 * on every valuation, and {initialize} checks the claimed trade against the real venue position.
 * `operator` is the remaining off-chain trust role: it reports funding via {applyFunding} (bounded
 * by {FUNDING_MAX_AGE}), confirms real capital movement on the venue before a request settles (via
 * {fulfillDepositRequest} / {fulfillRedeemRequest}), and closes the position via {close}. It is the
 * same backend wallet as the Factory's `deployer`, same trust level as everything else it does.
 *
 * The creator controls two moments: {list} opens the position to buy-ins (and sets the nickname),
 * and {requestClose} asks the backend to unwind a position they wholly own.
 *
 * Closing runs close -> settle -> claim: {close} freezes the value, the backend withdraws the
 * margin from the venue into this contract and records the amount actually recovered via {settle},
 * then every holder takes their pro-rata slice of it via {claim} (or is pushed it via {claimFor}).
 */
contract PositionToken is Initializable, ERC7540AdminDeposit, ERC7540AdminRedeem {
    using Math for uint256;
    using Strings for uint256;

    /// @dev Fixed-point scale for entryPrice/markPrice, matching {IVenueReader}.
    uint256 public constant PRICE_SCALE = 1e18;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    uint256 public constant BUY_IN_FEE_BPS = 200; // 2%, protocol-wide, paid to the creator

    uint256 public constant MAX_NICKNAME_LENGTH = 32; // bytes

    /// @dev How long a request must sit unfulfilled before its controller can cancel it and take
    /// the money back -- the escape hatch if the backend is down or the venue leg fails.
    uint256 public constant REQUEST_CANCEL_TIMEOUT = 20 minutes;

    /// @dev Our own cap on the venue mark's age, on top of the venue's own validity rule.
    uint256 public constant MARK_MAX_AGE = 5 minutes;

    /// @dev How long the operator's last funding report stays good for {isPriceFresh}. With the
    /// backend down, borrowing keeps working on live venue marks for this long, then pauses.
    uint256 public constant FUNDING_MAX_AGE = 2 hours;

    /// @dev Max gap between the claimed entry and the venue's at creation (0.5%).
    uint256 public constant ENTRY_TOLERANCE_BPS = 50;

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
    bytes32 public venuePositionId;
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
    // Price/funding state
    // ---------------------------------------------------------------------

    /// @dev Read-only venue adapter, set once in {initialize}. The live mark comes from here.
    IVenueReader public venueReader;
    /// @dev The venue account holding the position {initialize} verified.
    uint256 public venueAccountId;

    /// @dev The last mark synced from the venue (see {sync}) -- a cache, used only when the venue
    /// can't be read. Never written by the operator.
    uint256 public markPrice;
    /// @dev Venue timestamp of `markPrice` (UI / back-compat).
    uint256 public lastReportTimestamp;
    /// @dev Cumulative funding, operator-reported via {applyFunding}.
    int256 public fundingAccrued;
    uint256 public lastFundingTimestamp;

    // ---------------------------------------------------------------------
    // Capital accounting -- buy-ins and redeems resize the position, never re-lever it
    // ---------------------------------------------------------------------

    /// @dev AUSD backing the position now. Starts equal to `initialDeposit`, grows by each
    /// buy-in's assets and shrinks by each redeemer's fraction.
    uint256 public capital;
    /// @dev The part of `fundingAccrued` (the venue's cumulative funding since open) already paid out
    /// to redeemers in cash -- netted out in {_computeValue} so it is never counted twice.
    int256 public fundingSettled;

    // ---------------------------------------------------------------------
    // Off-chain trust role
    // ---------------------------------------------------------------------

    address public operator;

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
    /// {settle} replaces it with the AUSD actually recovered.
    uint256 public finalNavValue;
    ClosedReason public closedReason;

    // ---------------------------------------------------------------------
    // Settlement -- the AUSD actually recovered from the venue, shared out by {claim}
    // ---------------------------------------------------------------------

    bool public settled;
    /// @dev AUSD holders share, set once by {settle}. The real recovery, not the formula estimate
    /// in `finalNavValue` -- a liquidation's leftover after the venue's penalty is often below it.
    uint256 public settlementAssets;
    /// @dev Paid out of `settlementAssets` so far.
    uint256 public claimedAssets;

    // ---------------------------------------------------------------------
    // Per-holder stop loss / take profit -- a triggered level is an automatic redeem of that one
    // holder's wallet balance, never a stop order on the shared venue position
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
    event FundingUpdated(int256 fundingAccrued, uint256 timestamp);
    event MarkSynced(uint256 markPrice, uint256 updatedAt);
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
     * denominated in the same underlying asset (AUSD); `initialize` sanity-checks the Factory
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
            _shortId(venuePositionId)
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

    /// @dev First 4 bytes of `venuePositionId` as 8 lowercase hex chars, no `0x`. The id is an opaque
    /// hash (keccak256 of the venue order id), not text, so it can't be rendered as a string; this
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
     *
     * The claimed trade is checked against the real venue position held by `_venueAccountId`:
     * direction and size must match exactly (the backend computes `_size` with
     * {PerplReader-toSize}, the same maths the reader uses), entry within {ENTRY_TOLERANCE_BPS}.
     * The operator cannot mint a token for a trade that does not exist.
     */
    function initialize(
        address _creator,
        bytes32 _market,
        Direction _direction,
        uint256 _leverage,
        uint256 _entryPrice,
        uint256 _size,
        uint256 _initialDeposit,
        bytes32 _venuePositionId,
        address _asset,
        address _operator,
        address _venueReader,
        uint256 _venueAccountId,
        uint256 _defaultStopLoss,
        uint256 _defaultTakeProfit
    ) external initializer {
        require(_creator != address(0), "PositionToken: zero creator");
        // asset() reads the immutable set at implementation-deploy time (see constructor); this is
        // a sanity check that the Factory is wiring up the asset it thinks it is, not a live setter.
        require(_asset == asset(), "PositionToken: asset mismatch");
        require(_operator != address(0), "PositionToken: zero operator");
        require(_entryPrice > 0, "PositionToken: zero entry price");
        require(_initialDeposit > 0, "PositionToken: zero deposit");
        require(_venueReader != address(0), "PositionToken: zero venue reader");

        creator = _creator;
        market = _market;
        direction = _direction;
        leverage = _leverage;
        entryPrice = _entryPrice;
        size = _size;
        initialDeposit = _initialDeposit;
        capital = _initialDeposit;
        venuePositionId = _venuePositionId;
        operator = _operator;
        venueReader = IVenueReader(_venueReader);
        venueAccountId = _venueAccountId;
        // `nickname` stays empty until {list}.

        _verifyVenuePosition();

        _validateLevels(_defaultStopLoss, _defaultTakeProfit, _entryPrice);
        defaultStopLoss = _defaultStopLoss;
        defaultTakeProfit = _defaultTakeProfit;
        defaultsActive = _defaultStopLoss != 0 || _defaultTakeProfit != 0;

        // Shares are minted 1:1, but totalAssets() == initialDeposit at genesis only when the live
        // mark equals the entry; any gap is the PnL the venue position already has.
        (uint256 mark, bool live) = currentMark();
        markPrice = live ? mark : _entryPrice;
        lastReportTimestamp = block.timestamp;
        lastFundingTimestamp = block.timestamp;

        _mint(_creator, _initialDeposit);

        emit PositionInitialized(_creator, _market, _leverage, _initialDeposit);
    }

    function _verifyVenuePosition() internal view {
        (bool exists, Direction dir, uint256 vSize, uint256 vEntry) = venueReader.position(market, venueAccountId);
        require(exists, "PositionToken: no venue position");
        require(dir == direction, "PositionToken: direction mismatch");
        require(vSize == size, "PositionToken: size mismatch");
        uint256 diff = vEntry > entryPrice ? vEntry - entryPrice : entryPrice - vEntry;
        require(diff * BPS_DENOMINATOR <= entryPrice * ENTRY_TOLERANCE_BPS, "PositionToken: entry mismatch");
    }

    // ---------------------------------------------------------------------
    // totalAssets() -- the core formula
    // ---------------------------------------------------------------------

    /**
     * @dev Total current value (principal + PnL + funding), not PnL alone -- if this computed
     * PnL alone, totalAssets() / totalSupply() would collapse the share price to near-zero
     * whenever PnL is merely flat. Priced on the live venue mark; never reverts (falls back to the
     * cached mark when the venue can't be read -- see {currentMark}).
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
        (uint256 mark, ) = currentMark();
        int256 value = _computeValue(mark, fundingAccrued);
        return value > 0 ? uint256(value) : 0;
    }

    /// @dev Shared PnL/value formula used by {totalAssets} and {close}. `funding` is the venue's
    /// cumulative total for the whole position; the part already paid to redeemers is netted out.
    function _computeValue(uint256 mark, int256 funding) internal view returns (int256) {
        int256 pnl = (int256(size) * (int256(mark) - int256(entryPrice))) / int256(PRICE_SCALE);
        if (direction == Direction.Short) pnl = -pnl;
        return int256(capital) + pnl + (funding - fundingSettled);
    }

    /// @dev AUSD per share, PRICE_SCALE fixed point. `totalSupply()` includes shares with a redeem
    /// pending (library behaviour), so a redeemer is priced against the pre-redeem supply.
    function navPerShare() public view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? PRICE_SCALE : totalAssets().mulDiv(PRICE_SCALE, supply);
    }

    // ---------------------------------------------------------------------
    // Mark price -- read from the venue, never reported
    // ---------------------------------------------------------------------

    /// @dev The venue's mark if it is readable and valid; otherwise `(0, 0, false)`. Never reverts.
    function _readMark() internal view returns (uint256 price, uint256 updatedAt, bool live) {
        try venueReader.mark(market) returns (uint256 p, uint256 at, bool valid) {
            if (valid && p > 0) return (p, at, true);
        } catch {}
    }

    /// @dev The mark every valuation uses: live from the venue, or the last synced `markPrice`
    /// (with `live == false`) when the venue can't be read.
    function currentMark() public view returns (uint256 price, bool live) {
        (price, , live) = _readMark();
        if (!live) price = markPrice;
    }

    /// @dev Permissionless: caches the live venue mark into `markPrice`. Purely a cache refresh --
    /// valuation reads the venue directly; the cache only matters when the venue is unreadable.
    function sync() public returns (uint256 price, bool live) {
        uint256 updatedAt;
        (price, updatedAt, live) = _readMark();
        if (live) {
            markPrice = price;
            lastReportTimestamp = updatedAt;
            emit MarkSynced(price, updatedAt);
        } else {
            price = markPrice;
        }
    }

    /**
     * @dev What {LendingPool-freshOracle} checks before opening new risk. Needs both a recent
     * funding report (so with the backend down, borrowing pauses after {FUNDING_MAX_AGE}) and a
     * live, valid venue mark no older than {MARK_MAX_AGE}. A closed position's value is final.
     */
    function isPriceFresh() public view returns (bool) {
        if (closed) return true;
        if (block.timestamp > lastFundingTimestamp + FUNDING_MAX_AGE) return false;
        (, uint256 updatedAt, bool live) = _readMark();
        return live && (updatedAt >= block.timestamp || block.timestamp - updatedAt <= MARK_MAX_AGE);
    }

    // ---------------------------------------------------------------------
    // Funding reporting -- operator only, never price, never capital movement
    // ---------------------------------------------------------------------

    /// @dev Perpl resets a position's funding accumulator whenever it is increased, so cumulative
    /// funding can't be read on-chain; the operator reports it, bounded by {FUNDING_MAX_AGE}.
    function applyFunding(int256 newFunding, uint256 reportTimestamp) external {
        _onlyOperator();
        require(!closed, "PositionToken: position closed");
        require(reportTimestamp > lastFundingTimestamp, "PositionToken: stale report");
        require(reportTimestamp <= block.timestamp + 60, "PositionToken: future report");

        fundingAccrued = newFunding;
        lastFundingTimestamp = reportTimestamp;

        emit FundingUpdated(newFunding, reportTimestamp);
    }

    /// @dev One combined read for the backend's reporting job: (current mark, funding, last
    /// funding report time).
    function getLastReport() external view returns (uint256, int256, uint256) {
        (uint256 mark, ) = currentMark();
        return (mark, fundingAccrued, lastFundingTimestamp);
    }

    function _onlyOperator() internal view {
        require(msg.sender == operator, "PositionToken: not operator");
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
     * @dev Called AFTER the backend has grown the venue position for this buy-in. The contract
     * prices the shares itself at the current {navPerShare} (on the live venue mark) and settles in the same transaction: the shares are minted straight to
     * the buyer, so nothing is ever left claimable-but-unclaimed and there is no claim step.
     *
     * A buy-in changes how big the position is, never how leveraged: `addedSize` is the actual
     * venue fill (the buyer's proportional share of the current size) at `fillPrice`, and the entry
     * becomes the size-weighted average. `addedSize` is 0 when the proportional add is below the
     * market's minimum order size -- the buy-in then backs the position as margin only.
     *
     * NOTE: the base {ERC7540AdminDeposit} strategy tracks pending/claimable state per-controller
     * only (all requests share `requestId = 0`), so `controller` identifies whose request to
     * fulfil; `requestId` is kept for interface parity and is always 0.
     */
    function fulfillDepositRequest(uint256 requestId, address controller, uint256 addedSize, uint256 fillPrice) external {
        _onlyOperator();
        require(requestId == 0, "PositionToken: invalid requestId");
        require(!closed, "PositionToken: position closed");
        sync();

        uint256 assets = pendingDepositRequest(0, controller);
        require(assets > 0, "PositionToken: no pending deposit");

        uint256 nav = navPerShare(); // at the live venue mark
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
     * @dev Called AFTER the backend has shrunk the venue position by the redeemer's fraction
     * `f = shares / totalSupply()` and made sure this contract holds enough AUSD to pay. Pays
     * `f x totalAssets()` straight to the redeemer and shrinks capital and effective funding by
     * the same `f`, so every remaining share still represents the same slice of the same trade.
     *
     * `closedSize` is the actual reduce-only fill on the venue (0 when the proportional reduction was
     * below the market's minimum order size). A partial close leaves the entry price unchanged.
     *
     * Blocked once closed: a redeem still pending at close is paid out of the settlement by {claim}.
     */
    function fulfillRedeemRequest(uint256 requestId, address controller, uint256 closedSize, uint256 fillPrice) external {
        _onlyOperator();
        require(requestId == 0, "PositionToken: invalid requestId");
        require(!closed, "PositionToken: position closed");
        sync();

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
        // The actual venue reduce-only fill; entry is unchanged by a partial close.
        size = closedSize >= size ? 0 : size - closedSize;

        _fulfillRedeem(shares, assets, controller);
        // Auto-settle: send the AUSD straight to the redeemer.
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
        (uint256 mark, ) = currentMark();
        _validateLevels(stopLoss, takeProfit, mark);
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
     * reduced the venue position by `closedSize` at `fillPrice` and put enough AUSD here to pay.
     *
     * The operator can only exit a holder whose OWN effective level is breached at the LIVE venue
     * mark (reverts if the venue can't be read), and never picks the price: the payout is the contract's own {navPerShare}. The shrink
     * is the same proportional one as {fulfillRedeemRequest}, so every other holder keeps the same
     * slice of the same trade at the same leverage.
     */
    function executeTrigger(address holder, uint256 closedSize, uint256 fillPrice) external {
        _onlyOperator();
        require(!closed, "PositionToken: position closed");

        uint256 shares = balanceOf(holder);
        require(shares > 0, "PositionToken: nothing to exit");

        (uint256 mark, bool live) = sync();
        require(live, "PositionToken: venue mark unavailable");
        (uint256 sl, uint256 tp, bool usedDefault) = effectiveTriggers(holder);
        (bool slHit, bool tpHit) = _levelsHit(sl, tp, mark);
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
        emit TriggerExecuted(holder, slHit, usedDefault, shares, assets, mark);
        fillPrice; // the venue fill is recorded off-chain; kept for parity with fulfillRedeemRequest

        _closeIfEmpty();
    }

    /// @dev Once a default level has been crossed, the creator's plan has played out: stop applying
    /// the defaults to anyone who buys in later. Only callable while a default is actually breached.
    function retireDefaultTriggers() external {
        _onlyOperator();
        require(defaultsActive, "PositionToken: defaults not active");
        (uint256 mark, bool live) = currentMark();
        require(live, "PositionToken: venue mark unavailable");
        (bool slHit, bool tpHit) = _levelsHit(defaultStopLoss, defaultTakeProfit, mark);
        require(slHit || tpHit, "PositionToken: default not hit");
        defaultsActive = false;
        emit DefaultTriggersRetired(mark);
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

    /**
     * @dev Freezes the value at the live venue mark -- the operator supplies only the final
     * funding. A normal close needs the venue readable; a liquidation must always be recordable,
     * so it falls back to the last synced mark when the venue can't be read.
     */
    function close(int256 finalFunding, bool wasLiquidated) external {
        _onlyOperator();
        require(!closed, "PositionToken: already closed");
        // Normal closes need the creator's request. Liquidations don't: the venue already closed the
        // position, and the backend is only recording it.
        require(closeRequested || wasLiquidated, "PositionToken: no close request");

        (uint256 finalMark, bool live) = sync(); // falls back to the cached mark when not live
        require(live || wasLiquidated, "PositionToken: venue mark unavailable");

        int256 value = _computeValue(finalMark, finalFunding);
        finalNavValue = value > 0 ? uint256(value) : 0;
        closed = true;
        closedReason = wasLiquidated ? ClosedReason.Liquidated : ClosedReason.UserClosed;
        fundingAccrued = finalFunding;

        emit PositionClosed(finalNavValue, wasLiquidated);
    }

    // ---------------------------------------------------------------------
    // Settlement & claims
    // ---------------------------------------------------------------------

    /**
     * @dev Records the AUSD actually recovered from the venue, once it sits in this contract. Pending
     * buy-ins are still owed back as refunds (via {cancelDepositRequest}), so the balance must cover
     * both. `assets` may be 0 -- a fully wiped liquidation.
     */
    function settle(uint256 assets) external {
        _onlyOperator();
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
    /// AUSD is never pushed into a contract that can't use it (e.g. a LendingPool holding collateral).
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

    /// @dev Buy-in AUSD sits here as a buffer while the backend fronts the matching margin on
    /// the venue. After settlement, anything beyond what is still owed belongs to that float.
    function recoverExcess(address to) external {
        _onlyOperator();
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
        (uint256 mark, ) = currentMark();
        return (market, direction, leverage, entryPrice, mark, closed);
    }

    /// @dev Risk view: the token's size/entry next to the venue's. They drift apart by design
    /// when buy-ins/redeems fall below the venue's minimum order size; a large gap is an alarm.
    function venueDrift()
        external
        view
        returns (uint256 ourSize, uint256 venueSize, uint256 ourEntry, uint256 venueEntry, bool venueExists)
    {
        ourSize = size;
        ourEntry = entryPrice;
        try venueReader.position(market, venueAccountId) returns (bool e, Direction, uint256 s, uint256 en) {
            (venueExists, venueSize, venueEntry) = (e, s, en);
        } catch {}
    }

    /// @dev NAV per share against the genesis value of 1.0, in basis points. Buy-ins and redeems
    /// both happen at NAV, so this stays correct through any number of them.
    function currentPnLBps() external view returns (int256) {
        return ((int256(navPerShare()) - int256(PRICE_SCALE)) * int256(BPS_DENOMINATOR)) / int256(PRICE_SCALE);
    }
}
