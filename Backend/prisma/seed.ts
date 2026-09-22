import { db } from "../src/config/db";
import { createLogger, errorFields } from "../src/lib/logger";
import { refreshMarkets, symbolToBytes32 } from "../src/services/markets";

const log = createLogger("seed");

/**
 * Launch market list.
 *
 * `laxuMarket` is the bytes32 the contracts store -- the symbol, right-padded,
 * which is exactly what PositionToken's `_bytes32ToString` renders back into the
 * token's name. The Arcus side (marketId, tickSize, stepSize) is deliberately
 * NOT hard-coded here: it is pulled from `GET /v1/markets` by the refresh below,
 * because a stale tick size silently breaks order signing rather than failing
 * visibly.
 *
 * Symbols mirror the frontend catalogue in App/src/components/trade/data.ts.
 * `arcusDisplayName` is only needed where Arcus does not name the market
 * `<SYMBOL>-USD`; leave it null and the refresh will guess that form.
 */
const MARKETS: Array<{ symbol: string; arcusDisplayName?: string; maxLeverage: number }> = [
  { symbol: "TSLA", maxLeverage: 10 },
  { symbol: "ETH", maxLeverage: 20 },
  { symbol: "BTC", maxLeverage: 40 },
  { symbol: "NVDA", maxLeverage: 10 },
  { symbol: "CRCL", maxLeverage: 10 },
  { symbol: "XRP", maxLeverage: 20 },
  { symbol: "SOL", maxLeverage: 20 },
  { symbol: "USO", maxLeverage: 20 },
  { symbol: "GOLD", maxLeverage: 25 },
  { symbol: "QQQ", maxLeverage: 25 },
  { symbol: "SPX", maxLeverage: 25 },
];

async function main(): Promise<void> {
  for (const market of MARKETS) {
    const laxuMarket = symbolToBytes32(market.symbol).toLowerCase();
    await db.market.upsert({
      where: { laxuMarket },
      create: {
        laxuMarket,
        symbol: market.symbol,
        arcusDisplayName: market.arcusDisplayName ?? null,
        maxLeverage: market.maxLeverage,
        status: "UNRESOLVED",
      },
      update: {
        symbol: market.symbol,
        maxLeverage: market.maxLeverage,
        ...(market.arcusDisplayName ? { arcusDisplayName: market.arcusDisplayName } : {}),
      },
    });
  }

  log.info("market rows seeded", { count: MARKETS.length });

  // Resolve against Arcus straight away so the seed leaves a usable table rather
  // than one that still needs a second, easily-forgotten step.
  try {
    const result = await refreshMarkets();
    log.info("markets resolved against Arcus", result);
    if (result.unresolved.length > 0) {
      log.warn(
        "these symbols found no Arcus counterpart -- set arcusDisplayName explicitly and re-run",
        { symbols: result.unresolved },
      );
    }
  } catch (error) {
    log.warn(
      "could not reach Arcus; rows are seeded but UNRESOLVED. Run POST /markets/refresh once ARCUS_API_BASE_URL is reachable.",
      errorFields(error),
    );
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    log.error("seed failed", errorFields(error));
    await db.$disconnect();
    process.exit(1);
  });
