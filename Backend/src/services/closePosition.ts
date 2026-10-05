// Pass A stub -- close and settlement are ported to Perpl in pass C.
const notYet = (): never => {
  throw new Error("ported in pass C");
};

export async function executeClose(
  _positionId: string,
  _options: { wasLiquidated?: boolean; event?: { txHash: string; logIndex: number } } = {},
): Promise<void> {
  return notYet();
}
export async function settleEmptiedPosition(_positionId: string): Promise<void> {
  return notYet();
}
export function startSettlementJob(): () => void {
  return notYet();
}
