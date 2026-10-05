// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Direction} from "./ILaxuTypes.sol";
import {IVenueReader} from "./interfaces/IVenueReader.sol";
import {IPerplExchange} from "./interfaces/IPerplExchange.sol";

/**
 * @title PerplReader
 * @dev {IVenueReader} over Perpl's on-chain Exchange: maps Laxu's bytes32 market ids to Perpl
 * perp ids and converts Perpl's per-perp fixed-point units into Laxu's.
 *
 * Venue facts this relies on (dex-sdk commit 01b9910):
 * - `markTimestamp` is unix seconds, and Perpl treats a mark as obsolete once
 *   `markTimestamp + refPriceMaxAgeSec <= block.timestamp` (state/perpetual.rs:341-348);
 * - `status == 0` is Paused (state/perpetual.rs:119);
 * - `positionType` 0 = Long, 1 = Short (state/position.rs:8-11).
 *
 * {toPrice} / {toSize} are public so the backend computes the `entryPrice` / `size` it passes to
 * {PositionTokenFactory-createPosition} with the exact same integer maths {position} uses. That
 * is what lets {PositionToken-initialize} demand an exact size match with no tolerance.
 */
contract PerplReader is IVenueReader, Ownable {
    uint256 public constant PRICE_SCALE = 1e18;

    IPerplExchange public immutable exchange;

    /// @dev 10^collateralDecimals, read from the exchange once. Laxu's `size` is quantity in the
    /// collateral's base units, so `size x (mark - entry) / PRICE_SCALE` is PnL in collateral.
    uint256 public immutable sizeScale;

    mapping(bytes32 => uint256) public perpIdOf;
    mapping(bytes32 => bool) public isMapped;

    event MarketMapped(bytes32 indexed market, uint256 perpId);

    constructor(address _exchange) Ownable(msg.sender) {
        require(_exchange != address(0), "PerplReader: zero exchange");
        exchange = IPerplExchange(_exchange);
        (, , , uint256 collateralDecimals, , ) = IPerplExchange(_exchange).getExchangeInfo();
        require(collateralDecimals <= 18, "PerplReader: collateral decimals");
        sizeScale = 10 ** collateralDecimals;
    }

    /// @dev Set-once: repointing a market would silently re-price every open token on it.
    function setMarket(bytes32 market, uint256 perpId) external onlyOwner {
        require(!isMapped[market], "PerplReader: market already mapped");
        IPerplExchange.PerpetualInfo memory info = exchange.getPerpetualInfo(perpId);
        require(info.priceDecimals <= 18 && info.lotDecimals <= 18, "PerplReader: decimals");
        perpIdOf[market] = perpId;
        isMapped[market] = true;
        emit MarketMapped(market, perpId);
    }

    function mark(bytes32 market) external view returns (uint256 price, uint256 updatedAt, bool valid) {
        IPerplExchange.PerpetualInfo memory info = exchange.getPerpetualInfo(_perpId(market));
        price = toPrice(info.markPNS, info.priceDecimals);
        updatedAt = info.markTimestamp;
        bool fresh = info.refPriceMaxAgeSec == 0 ||
            info.markTimestamp + info.refPriceMaxAgeSec > block.timestamp;
        valid = info.markPNS > 0 && info.status != 0 && !exchange.isHalted() && fresh;
    }

    function position(
        bytes32 market,
        uint256 accountId
    ) external view returns (bool exists, Direction direction, uint256 size, uint256 entryPrice) {
        uint256 perpId = _perpId(market);
        IPerplExchange.PerpetualInfo memory info = exchange.getPerpetualInfo(perpId);
        (IPerplExchange.PositionInfo memory p, , ) = exchange.getPosition(perpId, accountId);
        require(p.positionType <= 1, "PerplReader: unknown position type");
        exists = p.lotLNS > 0;
        direction = p.positionType == 0 ? Direction.Long : Direction.Short;
        size = toSize(p.lotLNS, info.lotDecimals);
        entryPrice = toPrice(p.pricePNS, info.priceDecimals);
    }

    /// @dev Margin plus unrealised PnL of the venue position, in collateral base units -- for the
    /// risk dashboard's "does the venue agree with the token" check.
    function venueEquity(bytes32 market, uint256 accountId) external view returns (int256) {
        (IPerplExchange.PositionInfo memory p, , ) = exchange.getPosition(_perpId(market), accountId);
        return int256(p.depositCNS) + p.pnlCNS;
    }

    /// @dev Perpl price (PNS) -> PRICE_SCALE.
    function toPrice(uint256 pns, uint256 priceDecimals) public pure returns (uint256) {
        return pns * 10 ** (18 - priceDecimals);
    }

    /// @dev Perpl lots (LNS) -> Laxu size (quantity x 10^collateralDecimals), rounded down.
    function toSize(uint256 lns, uint256 lotDecimals) public view returns (uint256) {
        return (lns * sizeScale) / 10 ** lotDecimals;
    }

    function _perpId(bytes32 market) internal view returns (uint256) {
        require(isMapped[market], "PerplReader: unknown market");
        return perpIdOf[market];
    }
}
