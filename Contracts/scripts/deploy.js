// Deploys Laxu on Monad testnet against Perpl, then verifies every contract.
//
//   npx hardhat run scripts/deploy.js --network monadTestnet
//
// Idempotent: addresses already in deployments/<network>.json (with code on chain) are reused, and
// already-mapped markets / an already-set registrar are skipped, so a failed run can just be re-run.
const hre = require("hardhat");
const fs = require("fs");

const DEFAULT_PERPL_EXCHANGE = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc";
// Perpl testnet perp ids (api-docs "Markets"). Keys are the base asset the backend uses.
const DEFAULT_MARKETS = [
  { symbol: "ETH", perpId: 32 },
  { symbol: "BTC", perpId: 16 },
  { symbol: "SOL", perpId: 48 },
  { symbol: "MON", perpId: 64 },
];

/// The backend's market id: `stringToHex(baseAsset.toUpperCase(), { size: 32 })`
/// (Backend/src/services/markets.ts marketIdFor) == ethers.encodeBytes32String.
const marketIdFor = (symbol) => hre.ethers.encodeBytes32String(symbol.toUpperCase());

/// MARKETS env: JSON `[{ "symbol": "ETH", "perpId": 32 }]` or `[{ "id": "0x…", "perpId": 32 }]`.
function loadMarkets() {
  const raw = process.env.MARKETS;
  const list = raw ? JSON.parse(raw) : DEFAULT_MARKETS;
  return list.map((m) => {
    const id = m.id ?? marketIdFor(m.symbol);
    const symbol = m.symbol ?? hre.ethers.decodeBytes32String(id);
    return { symbol, id, perpId: Number(m.perpId) };
  });
}

async function main() {
  const net = hre.network.name;
  const file = `deployments/${net}.json`;
  const PERPL_EXCHANGE = process.env.PERPL_EXCHANGE || DEFAULT_PERPL_EXCHANGE;
  const OPERATOR_ADDRESS =
    (net === "monadTestnet" && process.env.MONAD_OPERATOR_ADDRESS) || process.env.OPERATOR_ADDRESS;
  const DEFAULT_DEBT_CEILING = process.env.DEFAULT_DEBT_CEILING;
  if (!OPERATOR_ADDRESS) throw new Error("OPERATOR_ADDRESS (or MONAD_OPERATOR_ADDRESS) is not set");

  const [admin] = await hre.ethers.getSigners();
  if (!admin) throw new Error(`No deployer key for ${net} (DEPLOYER_PRIVATE_KEY / MONAD_ADMIN_PRIVATE_KEY)`);
  const provider = hre.ethers.provider;
  const { chainId } = await provider.getNetwork();
  console.log(`network ${net} (${chainId}), deployer ${admin.address}, balance ${hre.ethers.formatEther(await provider.getBalance(admin.address))} MON`);

  const out = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const save = () => {
    fs.mkdirSync("deployments", { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  };
  Object.assign(out, { network: net, chainId: Number(chainId), admin: admin.address, operator: OPERATOR_ADDRESS, perplExchange: PERPL_EXCHANGE });
  out.contracts ??= {};

  // --- 1. The asset is whatever Perpl uses as collateral -- never hard-coded ---
  const exchange = await hre.ethers.getContractAt("IPerplExchange", PERPL_EXCHANGE);
  const info = await exchange.getExchangeInfo();
  const asset = info.collateralToken;
  const collateralDecimals = Number(info.collateralDecimals);
  const assetToken = await hre.ethers.getContractAt("IERC20Metadata", asset);
  const assetDecimals = Number(await assetToken.decimals());
  const assetSymbol = await assetToken.symbol();
  console.log(`Perpl collateral: ${assetSymbol} ${asset}, collateralDecimals ${collateralDecimals}`);
  if (assetDecimals !== collateralDecimals) {
    throw new Error(`asset.decimals() = ${assetDecimals} but Perpl collateralDecimals = ${collateralDecimals}; aborting`);
  }
  Object.assign(out, { asset, assetSymbol, assetDecimals });

  // Debt ceiling defaults to 100k of the asset.
  const debtCeiling = DEFAULT_DEBT_CEILING ?? (100_000n * 10n ** BigInt(assetDecimals)).toString();

  const deploy = async (key, name, args) => {
    const prev = out.contracts[key];
    if (prev && (await provider.getCode(prev.address)) !== "0x") {
      console.log(`${key}: reusing ${prev.address}`);
      return hre.ethers.getContractAt(name, prev.address);
    }
    const c = await hre.ethers.deployContract(name, args);
    const receipt = await c.deploymentTransaction().wait();
    out.contracts[key] = { name, address: await c.getAddress(), block: receipt.blockNumber, args: args.map(String) };
    if (out.deployBlock === undefined || receipt.blockNumber < out.deployBlock) out.deployBlock = receipt.blockNumber;
    save();
    console.log(`${key}: ${out.contracts[key].address} (block ${receipt.blockNumber})`);
    return c;
  };

  // --- 2-3. Reader + market map ---
  const reader = await deploy("PerplReader", "PerplReader", [PERPL_EXCHANGE]);
  const markets = loadMarkets();
  out.markets = out.markets ?? {};
  for (const m of markets) {
    if (!(await reader.isMapped(m.id))) {
      await (await reader.setMarket(m.id, m.perpId)).wait();
      console.log(`mapped ${m.symbol} ${m.id} -> perp ${m.perpId}`);
    } else if (Number(await reader.perpIdOf(m.id)) !== m.perpId) {
      throw new Error(`${m.symbol} is already mapped to perp ${await reader.perpIdOf(m.id)}, not ${m.perpId} (set-once)`);
    }
    const [price, , valid] = await reader.mark(m.id);
    out.markets[m.symbol] = { id: m.id, perpId: m.perpId };
    console.log(`  ${m.symbol} mark $${hre.ethers.formatUnits(price, 18)} valid=${valid}`);
  }
  save();

  // --- 4-5. Position side ---
  const ptImpl = await deploy("PositionToken", "PositionToken", [asset]);
  await deploy("PositionTokenFactory", "PositionTokenFactory", [await ptImpl.getAddress(), OPERATOR_ADDRESS, asset, await reader.getAddress()]);

  // --- 6. Lending side ---
  const vault = await deploy("LendingVault", "LendingVault", [asset, `Laxu Lending ${assetSymbol}`, `lx${assetSymbol}`, admin.address]);
  const poolImpl = await deploy("LendingPool", "LendingPool", []);
  const poolFactory = await deploy("LendingPoolFactory", "LendingPoolFactory", [
    await poolImpl.getAddress(), await vault.getAddress(), debtCeiling, admin.address,
  ]);
  if ((await vault.registrar()) !== (await poolFactory.getAddress())) {
    await (await vault.setRegistrar(await poolFactory.getAddress())).wait();
    console.log("vault.registrar -> LendingPoolFactory");
  }
  save();

  // --- 7. README table ---
  const explorer = "https://testnet.monadvision.com/address/";
  console.log(`\n| Contract | Address |\n|---|---|`);
  for (const [k, v] of Object.entries(out.contracts)) console.log(`| ${k} | [\`${v.address}\`](${explorer}${v.address}) |`);
  console.log(`| Asset (${assetSymbol}, Perpl collateral) | \`${asset}\` |`);
  console.log(`| Perpl Exchange | \`${PERPL_EXCHANGE}\` |\n`);
  console.log(`written to ${file}`);

  // --- 8. Verify (clones need none) ---
  if (net === "hardhat" || net === "localhost" || process.env.SKIP_VERIFY) return;
  for (const [key, c] of Object.entries(out.contracts)) {
    try {
      await hre.run("verify:verify", { address: c.address, constructorArguments: c.args });
      out.contracts[key].verified = true;
    } catch (e) {
      const msg = String(e.message || e);
      if (/already verified/i.test(msg)) out.contracts[key].verified = true;
      else console.error(`verify ${key} failed: ${msg.split("\n")[0]}`);
    }
  }
  save();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
