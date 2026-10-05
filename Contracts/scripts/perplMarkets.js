// Snapshots Perpl's market list into deployments/perplMarkets.testnet.json -- the market map deploy.js
// and checkReader.js use. No chain access needed:
//
//   npx hardhat run scripts/perplMarkets.js
//
// Perpl's API Market has two ids: `id` (the API market id, used in orders) and `perpetual_id` (the
// on-chain perpId getPerpetualInfo/getPosition take). PerplReader.setMarket needs `perpetual_id`.
const hre = require("hardhat");
const fs = require("fs");

const API_URL = process.env.PERPL_API_URL || "https://testnet.perpl.xyz/api/v1/pub/context";
const OUT = "deployments/perplMarkets.testnet.json";

/// "ETH", "eth-usd", "ETHUSD" -> "ETH". The bytes32 id is then the backend's symbolToBytes32:
/// right-padded ASCII == ethers.encodeBytes32String.
const baseOf = (symbol) => symbol.toUpperCase().replace(/-?USD$/, "");

async function main() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`GET ${API_URL} -> ${res.status}`);
  const ctx = await res.json();
  if (!Array.isArray(ctx.markets)) throw new Error(`no markets array in ${API_URL}`);

  const markets = ctx.markets.map((m) => {
    const cfg = m.config ?? {};
    const symbol = baseOf(m.symbol);
    return {
      symbol,
      id: hre.ethers.encodeBytes32String(symbol),
      perpId: Number(m.perpetual_id),
      apiMarketId: Number(m.id),
      priceDecimals: Number(cfg.price_decimals ?? m.price_decimals),
      sizeDecimals: Number(cfg.size_decimals ?? m.size_decimals),
      isOpen: Boolean(cfg.is_open ?? m.is_open),
    };
  });

  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(markets, null, 2) + "\n");

  console.table(markets.map(({ id, ...rest }) => rest));
  const differ = markets.filter((m) => m.perpId !== m.apiMarketId);
  if (differ.length) {
    console.log("API market id and perp id differ: use perpId ->", differ.map((m) => m.symbol).join(", "));
  } else {
    console.log("API market id == perpetual_id for every market");
  }
  console.log(`written to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
