import type { PositionOpenRequest } from "@prisma/client";
import type { Hash } from "viem";

// Pass A stub -- the open flow is ported to Perpl in pass B.
const notYet = (): never => {
  throw new Error("ported in pass B");
};

export interface OpenPositionRequest {
  userWalletAddress: string;
  market: string;
  direction: "long" | "short";
  leverage: number;
  amount: string;
  stopLoss?: string;
  takeProfit?: string;
}

export interface OpenPositionReservation {
  openRequestId: string;
  payTo: string;
  usdg: string;
  asset: string;
  amount: string;
  expiresAt: string;
}

export async function requestOpenPosition(_request: OpenPositionRequest): Promise<OpenPositionReservation> {
  return notYet();
}
export async function reportPayment(_params: { openRequestId: string; callerWalletAddress: string; txHash: Hash }): Promise<PositionOpenRequest> {
  return notYet();
}
export async function getOpenRequest(_openRequestId: string, _callerWalletAddress: string): Promise<PositionOpenRequest> {
  return notYet();
}
export async function resumeOpenRequests(): Promise<number> {
  return notYet();
}
export async function ensureMissingLendingPools(): Promise<void> {
  return notYet();
}
