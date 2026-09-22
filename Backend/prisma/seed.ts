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
 *
 * `assetClass` is Arcus's own category for each market (CRYPTO / EQUITIES /
 * COMMODITIES / INDICES) -- assigned by hand here since `GET /v1/markets`
 * doesn't echo it back; keep it in sync with Arcus's own listing if a market's
 * category ever changes.
 */
const MARKETS: Array<{
  symbol: string;
  arcusDisplayName?: string;
  maxLeverage: number;
  assetClass: "CRYPTO" | "EQUITIES" | "COMMODITIES" | "INDICES";
}> = [
  { symbol: "TSLA", maxLeverage: 10, assetClass: "EQUITIES" },
  { symbol: "ETH", maxLeverage: 20, assetClass: "CRYPTO" },
  { symbol: "BTC", maxLeverage: 40, assetClass: "CRYPTO" },
  { symbol: "NVDA", maxLeverage: 10, assetClass: "EQUITIES" },
  { symbol: "CRCL", maxLeverage: 10, assetClass: "EQUITIES" },
  { symbol: "XRP", maxLeverage: 20, assetClass: "CRYPTO" },
  { symbol: "SOL", maxLeverage: 20, assetClass: "CRYPTO" },
  { symbol: "USO", maxLeverage: 20, assetClass: "COMMODITIES" },
  { symbol: "GOLD", maxLeverage: 25, assetClass: "COMMODITIES" },
  { symbol: "QQQ", maxLeverage: 25, assetClass: "INDICES" },
  { symbol: "SPX", maxLeverage: 25, assetClass: "INDICES" },
];

async function main(): Promise<void> {
  for (const market of MARKETS) {
    const laxuMarket = symbolToBytes32(market.symbol).toLowerCase();
    await db.market.upsert({
      where: { laxuMarket },
      create: {
        laxuMarket,
        symbol: market.symbol,
        assetClass: market.assetClass,
        arcusDisplayName: market.arcusDisplayName ?? null,
        maxLeverage: market.maxLeverage,
        status: "UNRESOLVED",
      },
      update: {
        symbol: market.symbol,
        assetClass: market.assetClass,
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
