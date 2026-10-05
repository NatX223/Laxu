/**
 * `npm run markets:map` -- prints the MARKETS JSON Spec 01's deploy script takes
 * (PerplReader.setMarket for each), from Perpl's /v1/pub/context, using the
 * backend's own symbolToBytes32 so the contract ids match the markets table.
 *
 *   [{ "symbol": "ETH", "id": "0x4554...", "perpId": 32 }, ...]
 */

import { baseAssetOf } from "../src/services/marketSync";
import { symbolToBytes32 } from "../src/services/markets";
import { getContext } from "../src/venue/perpl/rest";

async function main(): Promise<void> {
  const context = await getContext();
  const seen = new Set<string>();
  const out: Array<{ symbol: string; id: string; perpId: number }> = [];
  for (const market of context.markets ?? []) {
    const symbol = baseAssetOf(market.symbol);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, id: symbolToBytes32(symbol), perpId: market.perpetual_id });
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
