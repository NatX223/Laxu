import { privateKeyToAccount } from "viem/accounts";

import { config } from "../config/env";

/**
 * The two Arcus writes that are authenticated by the operator wallet's own
 * secp256k1 EIP-712 signature rather than a slot's Ed25519 API key: moving
 * collateral between subaccounts (POST /v1/transfer) and withdrawing it back
 * on-chain (POST /v1/withdraw). Both share one domain apart from its `name`.
 */

export interface RsvSignature {
  r: string;
  s: string;
  v: string;
}

function domain(name: "Arcus Transfer" | "Arcus Withdraw") {
  if (!config.arcusBridgeVaultAddress || !config.arcusChainId) {
    throw new Error(
      "Arcus EIP-712 signing needs ARCUS_BRIDGE_VAULT_ADDRESS and ARCUS_CHAIN_ID (see the Arcus withdraw docs)",
    );
  }
  return {
    name,
    version: "1",
    chainId: config.arcusChainId,
    verifyingContract: config.arcusBridgeVaultAddress as `0x${string}`,
  };
}

function accountFor(privateKey: string) {
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  return privateKeyToAccount(key as `0x${string}`);
}

/// Split a 65-byte signature into the `{r, s, v}` the gateway takes.
function split(signature: string): RsvSignature {
  return {
    r: signature.slice(0, 66),
    s: `0x${signature.slice(66, 130)}`,
    v: `0x${signature.slice(130, 132)}`,
  };
}

export async function signTransfer(params: {
  privateKey: string;
  ethereumAddress: string;
  fromAccountIndex: number;
  toAccountIndex: number;
  /// Quote quantums (1e9 = $1).
  amount: bigint;
  nonce: string;
}): Promise<RsvSignature> {
  const signature = await accountFor(params.privateKey).signTypedData({
    domain: domain("Arcus Transfer"),
    types: {
      Transfer: [
        { name: "ethereumAddress", type: "address" },
        { name: "fromAccountIndex", type: "uint8" },
        { name: "toAccountIndex", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "Transfer",
    message: {
      ethereumAddress: params.ethereumAddress as `0x${string}`,
      fromAccountIndex: params.fromAccountIndex,
      toAccountIndex: params.toAccountIndex,
      amount: params.amount,
      nonce: params.nonce,
    },
  });
  return split(signature);
}

/// USDG withdrawal. Withdraw-to-self only: the funds land on `ethereumAddress`.
export async function signWithdraw(params: {
  privateKey: string;
  ethereumAddress: string;
  accountIndex: number;
  /// Quote quantums (1e9 = $1).
  amount: bigint;
  nonce: string;
}): Promise<RsvSignature> {
  const signature = await accountFor(params.privateKey).signTypedData({
    domain: domain("Arcus Withdraw"),
    types: {
      Withdraw: [
        { name: "ethereumAddress", type: "address" },
        { name: "accountIndex", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "Withdraw",
    message: {
      ethereumAddress: params.ethereumAddress as `0x${string}`,
      accountIndex: params.accountIndex,
      amount: params.amount,
      nonce: params.nonce,
    },
  });
  return split(signature);
}
