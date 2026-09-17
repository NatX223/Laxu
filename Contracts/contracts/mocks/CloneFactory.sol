// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @dev Test-only stand-in for PositionTokenFactory's cloning step (out of scope for this file).
contract CloneFactory {
    event Cloned(address instance);

    function clone(address implementation) external returns (address instance) {
        instance = Clones.clone(implementation);
        emit Cloned(instance);
    }
}
