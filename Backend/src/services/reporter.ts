// Pass A stub -- the funding reporter is ported to Perpl in pass B.
const notYet = (): never => {
  throw new Error("ported in pass B");
};

export async function runReportingTick(): Promise<void> {
  return notYet();
}
export async function onStreamLiquidationSignal(_slotId: string, _detail: { venueMarketId?: number; atMs?: number }): Promise<void> {
  return notYet();
}
export function startReportingJob(): () => void {
  return notYet();
}
