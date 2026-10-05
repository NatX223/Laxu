// Seeds the LendingVault with the deployer's AUSD (approve + deposit -- AUSD can't be minted by us;
// fund the deployer from Agora's faucet, requestFunds(address) on 0xd236…ee6C, first).
//
//   SEED_VAULT_AMOUNT=10000 npx hardhat run scripts/seed-vault.js --network monadTestnet
//   SEED_VAULT_AMOUNT=all   npx hardhat run scripts/seed-vault.js --network monadTestnet
//
// SEED_VAULT_AMOUNT is in whole asset units (e.g. "10000" or "2500.5" AUSD), or "all" for the
// deployer's full balance. Addresses come from deployments/<network>.json. Also called by deploy.js.
const hre = require("hardhat");
const fs = require("fs");

/// Deposits `amount` (whole units, or "all") of the vault's asset from `signer` into `vaultAddress`.
/// Returns the base units deposited (0n if there was nothing to do).
async function seedVault({ vaultAddress, amount, signer }) {
  const vault = await hre.ethers.getContractAt("LendingVault", vaultAddress, signer);
  const asset = await hre.ethers.getContractAt("IERC20Metadata", await vault.asset(), signer);
  const [decimals, symbol, balance] = await Promise.all([asset.decimals(), asset.symbol(), asset.balanceOf(signer.address)]);
  const fmt = (x) => `${hre.ethers.formatUnits(x, decimals)} ${symbol}`;

  const units = String(amount).trim().toLowerCase() === "all" ? balance : hre.ethers.parseUnits(String(amount), decimals);
  if (units === 0n) {
    console.log(`seed: nothing to deposit (${signer.address} holds ${fmt(balance)})`);
    return 0n;
  }
  if (balance < units) {
    throw new Error(
      `seed: ${signer.address} holds ${fmt(balance)} but SEED_VAULT_AMOUNT is ${fmt(units)}. ` +
        `Fund it first (Agora faucet: requestFunds(address) on 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C).`
    );
  }

  if ((await asset.allowance(signer.address, vaultAddress)) < units) {
    await (await asset.approve(vaultAddress, units)).wait();
  }
  const before = await vault.totalAssets();
  await (await vault.deposit(units, signer.address)).wait();
  console.log(
    `seed: deposited ${fmt(units)} into LendingVault ${vaultAddress}; ` +
      `totalAssets ${fmt(before)} -> ${fmt(await vault.totalAssets())}, ` +
      `deployer shares ${hre.ethers.formatUnits(await vault.balanceOf(signer.address), await vault.decimals())}`
  );
  return units;
}

async function main() {
  const amount = process.env.SEED_VAULT_AMOUNT;
  if (!amount) throw new Error('Set SEED_VAULT_AMOUNT (whole units, e.g. "10000", or "all")');

  const file = `deployments/${hre.network.name}.json`;
  if (!fs.existsSync(file)) throw new Error(`${file} not found -- deploy first`);
  const vaultAddress = JSON.parse(fs.readFileSync(file, "utf8")).contracts?.LendingVault?.address;
  if (!vaultAddress) throw new Error(`no LendingVault in ${file}`);

  const [signer] = await hre.ethers.getSigners();
  await seedVault({ vaultAddress, amount, signer });
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}

module.exports = { seedVault };
