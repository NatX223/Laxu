// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Direction} from "../ILaxuTypes.sol";

/**
 * @dev Venue-agnostic read surface {PositionToken} prices itself with. One implementation per
 * venue ({PerplReader} today); the token never sees venue-specific units or ids.
 */
interface IVenueReader {
    /// @dev Mark in PRICE_SCALE (1e18), its unix-seconds timestamp, and whether the venue itself
    /// considers it usable right now (not paused, not halted, not past the venue's own max age).
    function mark(bytes32 market) external view returns (uint256 price, uint256 updatedAt, bool valid);

    /// @dev The position `accountId` holds on `market`, in Laxu units: `size` = quantity x
    /// 10^collateralDecimals (what {PositionToken-size} stores), `entryPrice` in PRICE_SCALE.
    function position(
        bytes32 market,
        uint256 accountId
    ) external view returns (bool exists, Direction direction, uint256 size, uint256 entryPrice);
}
