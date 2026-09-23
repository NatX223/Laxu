// SPDX-License-Identifier: MIT
// Vendored from @openzeppelin/community-contracts v0.0.1 (interfaces/IERC7575.sol), installed from
// github:OpenZeppelin/openzeppelin-community-contracts. The upstream commit was not recorded in
// package-lock.json; sha256 of the unmodified upstream file: f35d70ed6019605581b9ee1b827688ad6a52f98872914fb741a4ca2c6a3e44a7.
// Local changes: none.

pragma solidity >=0.8.4;

import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @dev Multi-Asset ERC-4626 Vaults, as defined in https://eips.ethereum.org/EIPS/eip-7575
interface IERC7575 is IERC165, IERC4626 {
    /// @dev The address of the underlying share received on deposit into the vault.
    function share() external view returns (address shareTokenAddress);
}

/// @dev Share-to-Vault lookup, as defined in https://eips.ethereum.org/EIPS/eip-7575
interface IERC7575Share {
    /// @dev The address of the vault for a specific asset.
    function vault(address asset) external view returns (address vault);
}
