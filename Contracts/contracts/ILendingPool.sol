// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Minimal surface {LendingPoolFactory} needs against a freshly cloned {LendingPool} -- just
/// enough to initialize it. Risk parameters are intentionally absent: `initialize` resolves them
/// itself, from the collateral token's own leverage against a protocol-wide tier table, not from
/// arguments a caller could choose.
interface ILendingPool {
    function initialize(address _collateralToken, address _lendingVault) external;
}
