// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @dev Surface {LendingPool} and {LendingPoolFactory} need against {LendingVault}.
 *
 * Deliberately narrow: the pool only ever draws and returns liquidity, and the factory only ever
 * registers a new pool. Neither needs (or should have) the vault's ERC-4626 depositor surface, so
 * it isn't declared here -- `asset()` is the one exception, since a pool has to know which token
 * it is handing out and taking back.
 */
interface ILendingVault {
    function asset() external view returns (address);

    /// @dev Registrar-gated (the factory). Authorizes `pool` to borrow up to `initialCap`.
    function registerPool(address pool, uint256 initialCap) external;

    /// @dev Callable only by an authorized pool; sends `amount` of the underlying to the caller.
    function borrowFrom(uint256 amount) external;

    /**
     * @dev Callable only by an authorized pool. Pulls `principal + interest` from the caller,
     * but reduces the caller's tracked debt by `principal` alone -- the interest is not debt
     * repayment, it stays in the vault as yield and lifts `totalAssets()` (and so the share
     * price) for depositors. Splitting the two is why this isn't just `repay(amount)`.
     */
    function repayTo(uint256 principal, uint256 interest) external;

    function authorizedPools(address pool) external view returns (bool);

    function debtCeiling(address pool) external view returns (uint256);

    function currentDebt(address pool) external view returns (uint256);
}
