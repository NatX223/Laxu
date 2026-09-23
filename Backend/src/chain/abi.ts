/**
 * Hand-maintained ABI fragments, kept narrow on purpose: only what this service
 * calls or listens for. Signatures mirror the compiled artifacts in
 * ../../Contracts/artifacts -- notably `fulfillDepositRequest` and
 * `fulfillRedeemRequest` take `(requestId, controller, fulfillmentPrice)`. The
 * base ERC7540 admin strategy tracks pending state per-controller with every
 * request sharing `requestId = 0`, so `controller` is what identifies whose
 * request is being fulfilled; `requestId` is always 0.
 */

export const positionTokenFactoryAbi = [
  {
    type: "function",
    name: "createPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "creator", type: "address" },
      { name: "market", type: "bytes32" },
      { name: "direction", type: "uint8" },
      { name: "leverage", type: "uint256" },
      { name: "entryPrice", type: "uint256" },
      { name: "size", type: "uint256" },
      { name: "initialDeposit", type: "uint256" },
      { name: "arcusPositionId", type: "bytes32" },
    ],
    outputs: [{ name: "positionToken", type: "address" }],
  },
  {
    type: "event",
    name: "PositionCreated",
    inputs: [
      { name: "positionToken", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      // Not indexed on the contract -- declaring it indexed breaks decoding.
      { name: "market", type: "bytes32", indexed: false },
      { name: "direction", type: "uint8", indexed: false },
      { name: "leverage", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "deployer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "usdg",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  /// Idempotency check before a createPosition retry: a token already minted
  /// for this trade shows up here with a matching arcusPositionId.
  {
    type: "function",
    name: "getPositionsByCreator",
    stateMutability: "view",
    inputs: [{ name: "creator", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

export const positionTokenAbi = [
  // --- Async deposit / redeem -------------------------------------------
  {
    type: "event",
    name: "DepositRequested",
    inputs: [
      { name: "controller", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "requestId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RedeemRequested",
    inputs: [
      { name: "controller", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
      { name: "requestId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DepositRequestCancelled",
    inputs: [
      { name: "controller", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RedeemRequestCancelled",
    inputs: [
      { name: "controller", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DepositFulfilled",
    inputs: [
      { name: "requestId", type: "uint256", indexed: false },
      { name: "fulfillmentPrice", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RedeemFulfilled",
    inputs: [
      { name: "requestId", type: "uint256", indexed: false },
      { name: "fulfillmentPrice", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "fulfillDepositRequest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "fulfillmentPrice", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fulfillRedeemRequest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "fulfillmentPrice", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pendingDepositRequest",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingRedeemRequest",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  /**
   * The user-facing side of a redeem, as opposed to `fulfillRedeemRequest`
   * above. Every other caller in this codebase is a holder's own wallet; the
   * liquidation bot is the one place the backend calls this itself, to queue
   * seized collateral shares back into USDG via the same async flow every
   * other redeemer uses (see services/liquidator.ts).
   */
  {
    type: "function",
    name: "requestRedeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },

  // --- Lifecycle ---------------------------------------------------------
  {
    type: "event",
    name: "Listed",
    inputs: [{ name: "nickname", type: "string", indexed: false }],
  },
  /// The creator's on-chain close request. The contract enforces who may call
  /// it (creator, unlisted, holding 100% of supply, no deposit pending); the
  /// indexer turns it into the Arcus-side unwind plus close().
  {
    type: "event",
    name: "CloseRequested",
    inputs: [{ name: "creator", type: "address", indexed: true }],
  },
  {
    type: "function",
    name: "close",
    stateMutability: "nonpayable",
    inputs: [
      { name: "finalMarkPrice", type: "uint256" },
      { name: "finalFunding", type: "int256" },
      { name: "wasLiquidated", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "PositionClosed",
    inputs: [
      { name: "finalNavValue", type: "uint256", indexed: false },
      { name: "wasLiquidated", type: "bool", indexed: false },
    ],
  },

  // --- Views -------------------------------------------------------------
  {
    type: "function",
    name: "positionInfo",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "market_", type: "bytes32" },
      { name: "direction_", type: "uint8" },
      { name: "leverage_", type: "uint256" },
      { name: "entryPrice_", type: "uint256" },
      { name: "markPrice_", type: "uint256" },
      { name: "closed_", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "convertToAssets",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  /// Read at each report's block by the indexer, so the NAV chart shows the
  /// contract's own answer rather than a TypeScript copy of its formula.
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "creator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "closed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  /// USDG held for requests not yet fulfilled. It belongs to those buyers (they
  /// can cancel and take it back), so a redeem must never be paid out of it.
  {
    type: "function",
    name: "totalPendingDepositAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "closeRequested",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "size",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "entryPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "initialDeposit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "markPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "fundingAccrued",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    type: "function",
    name: "arcusPositionId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },

  // --- Price/funding reporting --------------------------------------------
  {
    type: "function",
    name: "applyReport",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newMarkPrice", type: "uint256" },
      { name: "newFunding", type: "int256" },
      { name: "reportTimestamp", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getLastReport",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "markPrice", type: "uint256" },
      { name: "funding", type: "int256" },
      { name: "timestamp", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "FundingUpdated",
    inputs: [
      { name: "markPrice", type: "uint256", indexed: false },
      { name: "fundingAccrued", type: "int256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  /// Testnet USDG only (open mint). Used to fund buy-in margin on Arcus and to
  /// pre-fund redeems -- see the "known limitations" in services/margin.ts.
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/// Arcus's PaxosDepositProxy -- pulls USDG from `owner` and credits
/// `(owner, accountIndex)`. `owner` must equal the signer.
export const depositProxyAbi = [
  {
    type: "function",
    name: "initiateDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "accountIndex", type: "uint16" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * LendingPoolFactory -- deploys/discovers {LendingPool} clones, one per
 * PositionToken collateral. The open-position flow calls `createPool` straight
 * after `createPosition` (reusing `primaryPool` when one already exists);
 * the indexer watches `PoolCreated` for discovery.
 */
export const lendingPoolFactoryAbi = [
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [{ name: "positionToken", type: "address" }],
    outputs: [{ name: "pool", type: "address" }],
  },
  {
    type: "function",
    name: "primaryPool",
    stateMutability: "view",
    inputs: [{ name: "positionToken", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "pool", type: "address", indexed: true },
      { name: "positionToken", type: "address", indexed: true },
    ],
  },
  {
    type: "function",
    name: "allPoolsCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getPoolsByCollateral",
    stateMutability: "view",
    inputs: [{ name: "positionToken", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

/**
 * LendingPool -- isolated borrowing market for one PositionToken collateral.
 * Narrow on purpose: only what the liquidation bot reads or calls.
 * `liquidate()` is PERMISSIONLESS and deliberately not gated by a freshOracle
 * check (see the contract's own rationale) -- never skip a liquidation check
 * over a stale price.
 */
export const lendingPoolAbi = [
  {
    type: "event",
    name: "CollateralDeposited",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Borrowed",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Liquidated",
    inputs: [
      { name: "liquidator", type: "address", indexed: true },
      { name: "borrower", type: "address", indexed: true },
      { name: "repayAmount", type: "uint256", indexed: false },
      { name: "seizedShares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "healthFactor",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxLiquidatableDebt",
    stateMutability: "view",
    inputs: [{ name: "borrower", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentDebt",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "debtAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "liquidate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "borrower", type: "address" },
      { name: "repayAmount", type: "uint256" },
    ],
    outputs: [{ name: "seizedShares", type: "uint256" }],
  },
] as const;

/// WAD -- LendingPool's health-factor scale. HF < WAD is liquidatable.
export const WAD = 10n ** 18n;

/// Matches `enum Direction { Long, Short }` in ILaxuTypes.sol.
export const DirectionEnum = { long: 0, short: 1 } as const;
export type DirectionName = keyof typeof DirectionEnum;
