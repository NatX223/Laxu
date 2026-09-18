// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILendingPool} from "./ILendingPool.sol";
import {ILendingVault} from "./ILendingVault.sol";

/**
 * @title LendingPoolFactory
 * @dev Deploys {LendingPool} clones and, in the same transaction, authorizes each one against the
 * shared {LendingVault}. Wiring the two halves together automatically is the entire reason this
 * contract holds the vault's `registrar` role -- a pool that exists but was never registered can
 * take collateral and then fail every borrow, so registration cannot be a follow-up step someone
 * has to remember.
 *
 * Like {PositionTokenFactory}, this is not itself a clone: deployed once, for real.
 */
contract LendingPoolFactory is Ownable {
    /// @dev Logic contract, deployed once, cloned per position token.
    address public lendingPoolImplementation;

    address public lendingVault;

    /// @dev Credit line handed to every new pool. One flat number for hackathon scope -- unlike
    /// LTV/threshold/bonus, this is not tiered by the collateral's leverage; sizing debt ceilings
    /// by leverage or position size is a natural follow-up but a separate decision. Owner-
    /// adjustable here for new pools; existing pools are re-sized via the vault's own
    /// {LendingVault-setDebtCeiling}, since this value is only read at creation time.
    uint256 public defaultDebtCeiling;

    address[] public allPools;
    mapping(address => address[]) public poolsByCollateral;

    event PoolCreated(address indexed pool, address indexed positionToken);
    event DefaultDebtCeilingUpdated(uint256 newCeiling);
    event ImplementationUpdated(address newImplementation);

    constructor(
        address _lendingPoolImplementation,
        address _lendingVault,
        uint256 _defaultDebtCeiling,
        address initialOwner
    ) Ownable(initialOwner) {
        require(_lendingPoolImplementation != address(0), "LendingPoolFactory: zero implementation");
        require(_lendingVault != address(0), "LendingPoolFactory: zero vault");

        lendingPoolImplementation = _lendingPoolImplementation;
        lendingVault = _lendingVault;
        defaultDebtCeiling = _defaultDebtCeiling;
    }

    /**
     * @dev PERMISSIONLESS, and safely so. Every risk parameter is resolved inside
     * {LendingPool-initialize} purely as a function of `positionToken`'s own already-fixed
     * leverage (see {LendingPool-_riskTierFor}) -- never an argument here, and never
     * caller-chosen. An attacker spinning up a second pool for a token that already has one
     * gets a market that resolves to the identical tier and behaves identically to the first --
     * there is no reckless configuration available to them to choose.
     *
     * That also defuses the earlier "one pool per token?" question rather than answering it:
     * duplicates split liquidity across two identical books, which is an inefficiency worth
     * avoiding in the UI, not a hole worth gating the function over.
     *
     * Requires this factory to hold the vault's `registrar` role -- call
     * {LendingVault-setRegistrar} with this address after deployment, or pools will be created
     * unauthorized and every borrow through them will revert.
     */
    function createPool(address positionToken) external returns (address pool) {
        require(positionToken != address(0), "LendingPoolFactory: zero position token");

        pool = Clones.clone(lendingPoolImplementation);

        ILendingPool(pool).initialize(positionToken, lendingVault);
        ILendingVault(lendingVault).registerPool(pool, defaultDebtCeiling);

        allPools.push(pool);
        poolsByCollateral[positionToken].push(pool);

        emit PoolCreated(pool, positionToken);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function allPoolsCount() external view returns (uint256) {
        return allPools.length;
    }

    function getPoolsByCollateral(address positionToken) external view returns (address[] memory) {
        return poolsByCollateral[positionToken];
    }

    /// @dev The canonical pool for a token when duplicates exist: the first one created. Gives the
    /// UI a single answer to "where do I borrow against this?" without making duplicates illegal.
    function primaryPool(address positionToken) external view returns (address) {
        address[] storage pools = poolsByCollateral[positionToken];
        return pools.length == 0 ? address(0) : pools[0];
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setDefaultDebtCeiling(uint256 newCeiling) external onlyOwner {
        defaultDebtCeiling = newCeiling;
        emit DefaultDebtCeilingUpdated(newCeiling);
    }

    /// @dev Affects FUTURE clones only -- existing pools keep their original logic pointer.
    function setImplementation(address newImplementation) external onlyOwner {
        require(newImplementation != address(0), "LendingPoolFactory: zero implementation");
        lendingPoolImplementation = newImplementation;
        emit ImplementationUpdated(newImplementation);
    }
}
