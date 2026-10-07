/**
 * Required on every page while Laxu runs on testnet: a thin fixed strip at the
 * bottom of the viewport. `body` carries matching bottom padding (globals.css)
 * so it never covers the last row of content.
 */
export default function TestnetBanner() {
  return (
    <div role="note" className="laxu-testnet-banner">
      <strong>Testnet only, no real funds.</strong> Independent project built on Perpl and Monad; not affiliated with
      either.
    </div>
  );
}
