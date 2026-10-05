const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

// Proves IPerplExchange's struct layout against the real Perpl testnet Exchange: a swapped field
// would decode as garbage (an absurd price, wrong decimals), not revert.
//
//   MONAD_FORK_RPC=https://testnet-rpc.monad.xyz npx hardhat test test/fork/PerplReader.fork.js
const FORK_RPC = process.env.MONAD_FORK_RPC;
const PERPL_EXCHANGE = process.env.PERPL_EXCHANGE || "0x1964C32f0bE608E7D29302AFF5E61268E72080cc";
const ETH = ethers.encodeBytes32String("ETH");
// Perpl's perpetual_id for ETH (not its API market id), from the API snapshot written by
// scripts/perplMarkets.js, or FORK_ETH_PERP_ID.
function ethPerpId() {
  if (process.env.FORK_ETH_PERP_ID) return BigInt(process.env.FORK_ETH_PERP_ID);
  const file = path.join(__dirname, "..", "..", "deployments", "perplMarkets.testnet.json");
  const eth = JSON.parse(fs.readFileSync(file, "utf8")).find((m) => m.symbol === "ETH");
  return BigInt(eth.perpId);
}

(FORK_RPC ? describe : describe.skip)("PerplReader on a Monad testnet fork", function () {
  this.timeout(300_000);

  before(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: FORK_RPC } }] });
    // Calls at the fork block itself count as "historical" (no hardfork history for chain 10143);
    // one local block puts every call on Hardhat's own EVM.
    await network.provider.send("evm_mine", []);
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("decodes getExchangeInfo", async function () {
    const exchange = await ethers.getContractAt("IPerplExchange", PERPL_EXCHANGE);
    const info = await exchange.getExchangeInfo();
    const token = await ethers.getContractAt("IERC20Metadata", info.collateralToken);
    // CNS amounts may use their own scale, so these are logged, not asserted equal.
    console.log(`      collateral ${await token.symbol()} ${info.collateralToken}: collateralDecimals ${info.collateralDecimals}, token decimals ${await token.decimals()}`);
    expect(info.collateralToken).to.not.equal(ethers.ZeroAddress);
    expect(info.collateralDecimals).to.be.lessThanOrEqual(18n);
  });

  it("reads a real, valid ETH mark between $100 and $100,000", async function () {
    const reader = await (await ethers.getContractFactory("PerplReader")).deploy(PERPL_EXCHANGE);
    await reader.setMarket(ETH, ethPerpId());
    const [price, updatedAt, valid] = await reader.mark(ETH);
    console.log(`      ETH mark $${ethers.formatUnits(price, 18)} at ${updatedAt}, valid=${valid}`);
    expect(price).to.be.greaterThan(100n * 10n ** 18n);
    expect(price).to.be.lessThan(100_000n * 10n ** 18n);
    expect(valid).to.equal(true);
  });
});
