import assert from "node:assert/strict";
import test from "node:test";

import type { ArcusMarketInfo } from "../arcus/types";
import { marketIdFor } from "./markets";
import { resolveLogo, syncMarkets, type MarketData, type MarketStore } from "./marketSync";

function arcusMarket(marketId: number, baseAsset: string): ArcusMarketInfo {
  return {
    marketId,
    marketDisplayName: `${baseAsset}-USD`,
    fullAssetName: baseAsset,
    status: "ONLINE",
    baseAsset,
    quoteAsset: "USD",
    category: "CRYPTO",
    tickSize: "0.01",
    stepSize: "0.001",
    minOrderSize: "0.001",
    maxOrderSize: "1000",
    minOrderNotional: "5",
    markPrice: "100",
    priceChange24h: "0.01",
    initialMarginFraction: "0.1",
    offHoursInitialMarginFraction: "0.1",
    isOutsideRth: false,
    regularTradingHours: null,
  };
}

/// In-memory stand-in for the markets table.
function memoryStore() {
  const rows = new Map<string, MarketData & { id: string }>();
  const store: MarketStore = {
    async existing() {
      return [...rows.values()].map((r) => ({ id: r.id, arcusMarketId: r.arcusMarketId, logoUrl: r.logoUrl ?? null }));
    },
    async save(id, data) {
      const prev = rows.get(id);
      rows.set(id, { ...prev, ...data, logoUrl: data.logoUrl !== undefined ? data.logoUrl : (prev?.logoUrl ?? null), id });
    },
    async releaseArcusId(arcusMarketId, keepId) {
      for (const row of rows.values()) {
        if (row.arcusMarketId === arcusMarketId && row.id !== keepId) {
          row.arcusMarketId = -arcusMarketId;
          row.status = "OFFLINE";
        }
      }
    },
    async markOfflineExcept(ids) {
      let count = 0;
      for (const row of rows.values()) {
        if (!ids.includes(row.id) && row.status !== "OFFLINE") {
          row.status = "OFFLINE";
          count += 1;
        }
      }
      return count;
    },
  };
  return { rows, store };
}

test("syncMarkets twice leaves no duplicates and stable ids", async () => {
  const { rows, store } = memoryStore();
  let logoLookups = 0;
  const deps = {
    fetchMarkets: async () => [arcusMarket(1, "BTC"), arcusMarket(2, "ETH")],
    resolveLogo: async (base: string) => {
      logoLookups += 1;
      return `https://logo/${base}.png`;
    },
    store,
  };

  await syncMarkets(deps);
  const firstIds = [...rows.keys()].sort();
  await syncMarkets(deps);

  assert.equal(rows.size, 2);
  assert.deepEqual([...rows.keys()].sort(), firstIds);
  assert.deepEqual(firstIds, [marketIdFor("BTC"), marketIdFor("ETH")].sort());
  assert.equal(logoLookups, 2, "logos are looked up once, not on every sync");
  assert.equal(rows.get(marketIdFor("ETH"))?.logoUrl, "https://logo/ETH.png");
});

test("a market missing from Arcus goes OFFLINE, not deleted", async () => {
  const { rows, store } = memoryStore();
  const base = { resolveLogo: async () => null, store };
  await syncMarkets({ ...base, fetchMarkets: async () => [arcusMarket(1, "BTC"), arcusMarket(2, "ETH")] });
  const result = await syncMarkets({ ...base, fetchMarkets: async () => [arcusMarket(1, "BTC")] });

  assert.equal(rows.size, 2);
  assert.equal(rows.get(marketIdFor("ETH"))?.status, "OFFLINE");
  assert.equal(rows.get(marketIdFor("BTC"))?.status, "ONLINE");
  assert.equal(result.offline, 1);
});

test("an empty Arcus answer does not take every market OFFLINE", async () => {
  const { rows, store } = memoryStore();
  await syncMarkets({ resolveLogo: async () => null, store, fetchMarkets: async () => [arcusMarket(1, "BTC")] });
  await assert.rejects(syncMarkets({ resolveLogo: async () => null, store, fetchMarkets: async () => [] }));
  assert.equal(rows.get(marketIdFor("BTC"))?.status, "ONLINE");
});

test("resolveLogo: metadata logo, then branding HEAD, then null", async () => {
  const branding = "https://branding.test";
  const heads: string[] = [];

  assert.equal(
    await resolveLogo("TSM", {
      metaLogo: async () => "https://meta/TSM.png",
      exists: async () => true,
      brandingBaseUrl: branding,
    }),
    "https://meta/TSM.png",
  );

  assert.equal(
    await resolveLogo("NVDA", {
      metaLogo: async () => {
        throw new Error("404");
      },
      exists: async (url) => {
        heads.push(url);
        return true;
      },
      brandingBaseUrl: branding,
    }),
    "https://branding.test/markets/branding/NVDA.png",
  );
  assert.deepEqual(heads, ["https://branding.test/markets/branding/NVDA.png"]);

  assert.equal(
    await resolveLogo("ZZZ", { metaLogo: async () => null, exists: async () => false, brandingBaseUrl: branding }),
    null,
  );
});
