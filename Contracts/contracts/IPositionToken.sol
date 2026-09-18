// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Direction} from "./ILaxuTypes.sol";

/// @dev Minimal surface the Factory needs against a freshly cloned {PositionToken} -- just enough
/// to initialize it. Must match PositionToken's `initialize()` signature exactly.
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
        address _creForwarder,
        address _backendOperator,
        uint256 _creatorFeeBps
    ) external;
}
