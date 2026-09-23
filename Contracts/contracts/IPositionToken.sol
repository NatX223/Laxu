// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Direction} from "./ILaxuTypes.sol";

/// @dev The surface other Laxu contracts need against a {PositionToken}: `initialize` for the
/// Factory (must match PositionToken's `initialize()` signature exactly), plus the read-only
/// valuation and freshness views {LendingPool} prices collateral with.
interface IPositionToken {
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
    ) external;

    // -----------------------------------------------------------------------------------------
    // Valuation -- inherited from the ERC-4626 side of PositionToken. These are the LIVE price of
    // the position: `convertToAssets` walks totalAssets()/totalSupply(), which tracks markPrice
    // and funding as the backend reports them. Nothing here is cached by the caller, by design.
    // -----------------------------------------------------------------------------------------

    function convertToAssets(uint256 shares) external view returns (uint256);

    function convertToShares(uint256 assets) external view returns (uint256);

    /// @dev {LendingPool-initialize} reads `leverage_` from this to resolve which risk tier the
    /// pool locks in for its lifetime -- see {LendingPool-_riskTierFor}.
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
        );

    /// @dev Timestamp of the last price/funding report. This is what {LendingPool-freshOracle}
    /// checks `borrow`/`withdrawCollateral` against -- see there for why `liquidate` and
    /// `healthFactor` deliberately do NOT check it.
    function lastReportTimestamp() external view returns (uint256);

    /// @dev True once the underlying Arcus position has been settled; value is then frozen at
    /// `finalNavValue` rather than tracking a live mark.
    function closed() external view returns (bool);

    // -----------------------------------------------------------------------------------------
    // Price/funding reporting -- the surface the backend's scheduled reporting job calls.
    // -----------------------------------------------------------------------------------------

    function applyReport(uint256 markPrice, int256 funding, uint256 timestamp) external;

    function getLastReport() external view returns (uint256 markPrice, int256 funding, uint256 timestamp);
}
