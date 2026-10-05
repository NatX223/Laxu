// Pass A stub -- the reconciler is ported to Perpl in pass C.
const notYet = (): never => {
  throw new Error("ported in pass C");
};

export function startReconciler(): () => void {
  return notYet();
}
