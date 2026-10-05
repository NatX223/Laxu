// Checks the deployed PerplReader's market map against deployments/perplMarkets.testnet.json.
//
//   npx hardhat run scripts/checkReader.js --network monadTestnet
//
// Per market: OK / WRONG (has X, needs Y) / NOT MAPPED, plus the live mark for mapped ones and a
// cross-check of the perp's on-chain symbol and decimals against the API. Exits 1 on any WRONG.
const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const net = hre.network.name;
  const deployments = JSON.parse(fs.readFileSync(`deployments/${net}.json`, "utf8"));
  const markets = JSON.parse(fs.readFileSync("deployments/perplMarkets.testnet.json", "utf8"));
  const readerAddress = process.env.PERPL_READER_ADDRESS || deployments.contracts.PerplReader.address;

  const reader = await hre.ethers.getContractAt("PerplReader", readerAddress);
  const exchange = await hre.ethers.getContractAt("IPerplExchange", await reader.exchange());
  console.log(`PerplReader ${readerAddress} on ${net} (exchange ${exchange.target})\n`);

  let wrong = 0;
  const rows = [];
  for (const m of markets) {
    const row = { symbol: m.symbol, needs: m.perpId, status: "", mark: "", valid: "", onchain: "" };
    if (!(await reader.isMapped(m.id))) {
      row.status = "NOT MAPPED";
    } else {
      const has = Number(await reader.perpIdOf(m.id));
      if (has === m.perpId) {
        row.status = "OK";
      } else {
        row.status = `WRONG (has ${has}, needs ${m.perpId})`;
        wrong++;
      }
      const [price, , valid] = await reader.mark(m.id);
      row.mark = `$${hre.ethers.formatUnits(price, 18)}`;
      row.valid = valid;
    }
    // What the perp id really is on-chain, whatever the reader holds.
    const info = await exchange.getPerpetualInfo(m.perpId);
    const decimalsOk = Number(info.priceDecimals) === m.priceDecimals && Number(info.lotDecimals) === m.sizeDecimals;
    row.onchain = `${info.symbol} pd${info.priceDecimals} ld${info.lotDecimals}${decimalsOk ? "" : " (DECIMALS DIFFER FROM API)"}`;
    rows.push(row);
  }
  console.table(rows);

  // Tokens keep the reader they were created with -- list any bound to this one.
  const factoryAddr = deployments.contracts.PositionTokenFactory?.address;
  if (factoryAddr) {
    const factory = await hre.ethers.getContractAt("PositionTokenFactory", factoryAddr);
    const n = Number(await factory.allPositionsCount());
    const bound = [];
    for (let i = 0; i < n; i++) {
      const token = await hre.ethers.getContractAt("PositionToken", await factory.allPositions(i));
      if ((await token.venueReader()).toLowerCase() === readerAddress.toLowerCase()) bound.push(token.target);
    }
    console.log(`factory reader: ${await factory.venueReader()}; position tokens created: ${n}; bound to this reader: ${bound.length}`);
    bound.forEach((a) => console.log(`  ${a}`));
  }

  if (wrong) {
    console.error(`\n${wrong} market(s) WRONG -- redeploy PerplReader (set-once mappings) and setVenueReader on the factory`);
    process.exitCode = 1;
  } else {
    console.log("\nno WRONG mappings");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
