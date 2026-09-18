// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Minimal surface {LendingPoolFactory} needs against a freshly cloned {LendingPool} -- just
/// enough to initialize it. Risk parameters are intentionally absent: they are protocol-wide
/// constants baked into the implementation, not per-pool arguments a caller could choose.
interface ILendingPool {
    function initialize(address _collateralToken, address _lendingVault) external;
}
