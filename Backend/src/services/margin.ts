import type { Address } from "viem";

import type { SlotWithWallet } from "./allocator";

// Pass A stub -- buy-ins and redeems are ported to Perpl in pass B.
const notYet = (): never => {
  throw new Error("ported in pass B");
};

export interface RequestEvent {
  positionId: string;
  positionTokenAddress: string;
  amount: bigint;
  controller: string;
  requestId: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
}

export async function handleDepositRequested(_event: RequestEvent): Promise<void> {
  return notYet();
}
export async function handleRedeemRequested(_event: RequestEvent): Promise<void> {
  return notYet();
}
export async function cancelEntry(_entryId: string, _reason: string): Promise<void> {
  return notYet();
}
export async function retryFulfil(_entryId: string): Promise<void> {
  return notYet();
}
export async function fundPayout(_slot: SlotWithWallet, _positionToken: Address, _payout: bigint): Promise<void> {
  return notYet();
}
export function recycleFreedMargin(_ctx: { slot: SlotWithWallet; position: { id: string } }, _amount: bigint): void {
  notYet();
}
