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
      { name: "creatorFeeBps", type: "uint256" },
      { name: "nickname", type: "string" },
    ],
    outputs: [{ name: "positionToken", type: "address" }],
  },
  {
    type: "event",
    name: "PositionCreated",
    inputs: [
      { name: "positionToken", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "market", type: "bytes32", indexed: true },
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

  // --- Lifecycle ---------------------------------------------------------
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
] as const;

/**
 * Close-request surface from the close-access-control spec.
 *
 * NOT YET DEPLOYED: no `requestClose()` or `CloseRequested` exists on the
 * current PositionToken. The indexer watches for this event anyway, which costs
 * nothing against contracts that never emit it and means the event-driven close
 * path lights up the moment the contract ships. Until then the same
 * orchestration is reachable through `POST /positions/:id/close`, which
 * re-checks the creator-holds-100%-of-supply rule off-chain.
 */
export const closeRequestAbi = [
  {
    type: "event",
    name: "CloseRequested",
    inputs: [{ name: "creator", type: "address", indexed: true }],
  },
  {
    type: "function",
    name: "requestClose",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
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
] as const;

/// Matches `enum Direction { Long, Short }` in ILaxuTypes.sol.
export const DirectionEnum = { long: 0, short: 1 } as const;
export type DirectionName = keyof typeof DirectionEnum;
