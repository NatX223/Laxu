const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const { USDG_ADDRESS, OPERATOR_ADDRESS, DEFAULT_DEBT_CEILING, SEED_VAULT_AMOUNT } = process.env;
  for (const [k, v] of Object.entries({ USDG_ADDRESS, OPERATOR_ADDRESS, DEFAULT_DEBT_CEILING })) {
    if (!v) throw new Error(`${k} is not set in .env`);
  }
  if ((await hre.ethers.provider.getCode(USDG_ADDRESS)) === "0x") {
    throw new Error(`No contract at USDG_ADDRESS on ${hre.network.name} -- forgot --network?`);
  }

  const [admin] = await hre.ethers.getSigners();
  const { chainId } = await hre.ethers.provider.getNetwork();
  const out = { network: hre.network.name, chainId: Number(chainId), admin: admin.address, operator: OPERATOR_ADDRESS, usdg: USDG_ADDRESS };
  const save = () => {
    fs.mkdirSync("deployments", { recursive: true });
    fs.writeFileSync(`deployments/${hre.network.name}.json`, JSON.stringify(out, null, 2));
  };

  const deploy = async (name, args) => {
    const c = await hre.ethers.deployContract(name, args);
    const receipt = await c.deploymentTransaction().wait();
    out[name] = { address: await c.getAddress(), block: receipt.blockNumber };
    console.log(name, out[name]);
    return c;
  };

  // Position side
  const ptImpl = await deploy("PositionToken", [USDG_ADDRESS]); // implementation; USDG is immutable here
  await deploy("PositionTokenFactory", [await ptImpl.getAddress(), OPERATOR_ADDRESS, USDG_ADDRESS]);

  // Lending side
  const vault = await deploy("LendingVault", [USDG_ADDRESS, "Laxu Lending USDG", "lxUSDG", admin.address]);
  const poolImpl = await deploy("LendingPool", []);
  const poolFactory = await deploy("LendingPoolFactory", [
    await poolImpl.getAddress(), await vault.getAddress(), DEFAULT_DEBT_CEILING, admin.address,
  ]);

  // Required wiring — before any createPool()
  await (await vault.setRegistrar(await poolFactory.getAddress())).wait();
  console.log("vault.registrar -> LendingPoolFactory");
  save(); // persist addresses before the optional seeding step, so a seed failure doesn't lose them

  // Optional: seed lender liquidity so borrowing works in testing
  if (SEED_VAULT_AMOUNT && SEED_VAULT_AMOUNT !== "0") {
    const usdg = new hre.ethers.Contract(USDG_ADDRESS, [
      "function mint(address,uint256)", "function approve(address,uint256) returns (bool)",
    ], admin);
    await (await usdg.mint(admin.address, SEED_VAULT_AMOUNT)).wait();
    await (await usdg.approve(await vault.getAddress(), SEED_VAULT_AMOUNT)).wait();
    await (await vault.deposit(SEED_VAULT_AMOUNT, admin.address)).wait();
    console.log("vault seeded with", SEED_VAULT_AMOUNT);
  }

  console.log(`written to deployments/${hre.network.name}.json`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });