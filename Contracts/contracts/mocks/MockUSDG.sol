// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only stand-in for the underlying asset (AUSD on Monad).
contract MockUSDG is ERC20 {
    constructor() ERC20("Mock USDG", "USDG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
