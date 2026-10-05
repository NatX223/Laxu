/**
 * Laxu contract ABIs come from the compiled artifacts (abi.generated.ts, written
 * by `npm run abi:gen`), so the backend can never drift from the deployed
 * signatures. Only the ERC-20 surface -- the asset is a third-party token -- is
 * kept by hand here.
 *
 * `fulfillDepositRequest` and `fulfillRedeemRequest` take
 * `(requestId, controller, size, fillPrice)`: the contract prices shares itself
 * at navPerShare(), and the operator reports the venue fill that resized the
 * position. The base ERC7540 admin strategy tracks pending state per-controller
 * with every request sharing `requestId = 0`, so `controller` identifies whose
 * request is being fulfilled; `requestId` is always 0.
 */

export {
  lendingPoolAbi,
  lendingPoolFactoryAbi,
  lendingVaultAbi,
  perplReaderAbi,
  positionTokenAbi,
  positionTokenFactoryAbi,
} from "./abi.generated";

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
  /// Only on a test token with an open mint (ASSET_MINTABLE=true). Perpl's
  /// AUSD has none.
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

/// A test token whose mint only pays the caller (`mint(amount)`).
export const assetSelfMintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

/// WAD -- LendingPool's health-factor scale. HF < WAD is liquidatable.
export const WAD = 10n ** 18n;

/// Matches `enum Direction { Long, Short }` in ILaxuTypes.sol.
export const DirectionEnum = { long: 0, short: 1 } as const;
export type DirectionName = keyof typeof DirectionEnum;
