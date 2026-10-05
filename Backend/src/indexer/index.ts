// Pass A stub -- the indexer is ported to the Spec 01 events in pass C.
const notYet = (): never => {
  throw new Error("ported in pass C");
};

export function startIndexer(): () => void {
  return notYet();
}
