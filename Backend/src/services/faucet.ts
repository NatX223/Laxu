import type { User } from "@prisma/client";

// Pass A stub -- the faucet is ported to the asset/MON in pass C.
const notYet = (): never => {
  throw new Error("ported in pass C");
};

export async function faucetStatus(_user: User, _ip: string | null): Promise<unknown> {
  return notYet();
}
export async function claimTestFunds(_user: User, _ip: string | null): Promise<unknown> {
  return notYet();
}
export async function faucetSummary(): Promise<unknown> {
  return notYet();
}
export function startFaucetMonitor(): () => void {
  return notYet();
}
