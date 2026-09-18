// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title LendingVault
 * @dev The single shared USDG liquidity pool every {LendingPool} draws from. Lenders deposit here
 * and only here -- one deep book instead of one shallow book per position token, which is what
 * makes rates worth having.
 *
 * Plain, SYNCHRONOUS ERC-4626, unlike {PositionToken}. Nothing in this contract waits on Arcus or
 * on an off-chain confirmation: USDG in, shares out, same transaction. The async ERC-7540
 * machinery next door exists because a deposit there must be matched by a real margin move on a
 * real exchange; nothing of the sort applies to parking stablecoins in a vault, so none of that
 * complexity is inherited here.
 *
 * Risk isolation lives in the debt ceiling, not in segregated balances. Liquidity is shared, but
 * each pool can only ever draw `debtCeiling[pool]` -- so a position token that goes bad can burn
 * at most its own pool's ceiling, never the whole book.
 */
contract LendingVault is ERC4626, Ownable {
    using Math for uint256;

    /// @dev Pools authorized to call {borrowFrom} / {repayTo}. Written only by the registrar.
    mapping(address => bool) public authorizedPools;

    /// @dev Per-pool cap on outstanding principal. The blast radius of any single position token.
    mapping(address => uint256) public debtCeiling;

    /// @dev Outstanding PRINCIPAL per pool. Interest is never added here -- see {repayTo}.
    mapping(address => uint256) public currentDebt;

    /// @dev Running sum of `currentDebt` across all pools. Kept as a counter rather than summed
    /// on demand because {totalAssets} reads it on every single share-price calculation, and a
    /// mapping can't be iterated in the first place.
    uint256 public totalCurrentDebt;

    /// @dev The only address allowed to register pools -- set to {LendingPoolFactory}, so that
    /// authorization happens automatically at pool creation and never as a manual follow-up step
    /// somebody can forget.
    address public registrar;

    event RegistrarUpdated(address indexed newRegistrar);
    event PoolRegistered(address indexed pool, uint256 initialCap);
    event DebtCeilingUpdated(address indexed pool, uint256 newCap);
    event Borrowed(address indexed pool, uint256 amount);
    event Repaid(address indexed pool, uint256 principal, uint256 interest);

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address initialOwner
    ) ERC20(name_, symbol_) ERC4626(asset_) Ownable(initialOwner) {}

    // ---------------------------------------------------------------------
    // Accounting
    // ---------------------------------------------------------------------

    /**
     * @dev Overriding this is essential, not cosmetic. USDG lent out to a pool has physically left
     * this contract's balance, but it is still backing value the vault is owed. Counting only the
     * idle balance would make the share price appear to crash the moment anybody borrows -- and
     * then appear to spike on repayment -- when in truth nothing about a lender's claim changed.
     */
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + totalCurrentDebt;
    }

    /**
     * @dev ERC-4626 requires max* to report what would actually succeed. Because `totalAssets()`
     * counts money that is out on loan, a lender's share of it can exceed the USDG physically
     * sitting here; withdrawing that much would revert in the transfer. So cap both max views at
     * the idle balance -- utilization, not ownership, is the binding constraint.
     */
    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 owed = super.maxWithdraw(owner_);
        uint256 available = IERC20(asset()).balanceOf(address(this));
        return owed < available ? owed : available;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 owned = super.maxRedeem(owner_);
        uint256 redeemable = _convertToShares(
            IERC20(asset()).balanceOf(address(this)),
            Math.Rounding.Floor
        );
        return owned < redeemable ? owned : redeemable;
    }

    // ---------------------------------------------------------------------
    // Pool registration
    // ---------------------------------------------------------------------

    function registerPool(address pool, uint256 initialCap) external {
        require(msg.sender == registrar, "LendingVault: not registrar");
        require(pool != address(0), "LendingVault: zero pool");

        authorizedPools[pool] = true;
        debtCeiling[pool] = initialCap;

        emit PoolRegistered(pool, initialCap);
    }

    // ---------------------------------------------------------------------
    // Pool credit line
    // ---------------------------------------------------------------------

    function borrowFrom(uint256 amount) external {
        require(authorizedPools[msg.sender], "LendingVault: not authorized pool");
        require(
            currentDebt[msg.sender] + amount <= debtCeiling[msg.sender],
            "LendingVault: exceeds debt ceiling"
        );

        currentDebt[msg.sender] += amount;
        totalCurrentDebt += amount;

        SafeERC20.safeTransfer(IERC20(asset()), msg.sender, amount);

        emit Borrowed(msg.sender, amount);
    }

    /**
     * @dev `principal` retires debt; `interest` does not. The interest simply lands in this
     * contract's balance and is never booked against `currentDebt`, so `totalAssets()` rises while
     * `totalSupply()` stays put -- the share price goes up and every depositor is paid pro-rata
     * automatically. No distribution function, no reward accounting, no claim step.
     *
     * Pulls funds rather than expecting a prior transfer so that the debt reduction and the
     * payment cannot come apart.
     */
    function repayTo(uint256 principal, uint256 interest) external {
        require(authorizedPools[msg.sender], "LendingVault: not authorized pool");

        currentDebt[msg.sender] -= principal;
        totalCurrentDebt -= principal;

        SafeERC20.safeTransferFrom(IERC20(asset()), msg.sender, address(this), principal + interest);

        emit Repaid(msg.sender, principal, interest);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @dev Lowering a ceiling below a pool's existing debt is allowed and deliberate: it stops
    /// further borrowing immediately while leaving current loans to run off naturally, which is
    /// the standard way to wind a market down without forcing liquidations.
    function setDebtCeiling(address pool, uint256 newCap) external onlyOwner {
        require(authorizedPools[pool], "LendingVault: unknown pool");
        debtCeiling[pool] = newCap;
        emit DebtCeilingUpdated(pool, newCap);
    }

    function setRegistrar(address newRegistrar) external onlyOwner {
        registrar = newRegistrar;
        emit RegistrarUpdated(newRegistrar);
    }
}
