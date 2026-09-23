const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PRICE_SCALE = 10n ** 18n;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const Direction = { Long: 0, Short: 1 };

const BORROW_APR_BPS = 1_000n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

const ENTRY_PRICE = 2000n * PRICE_SCALE;
const INITIAL_DEPOSIT = 1000n * PRICE_SCALE;

// notional = leverage * deposit, and size = notional * PRICE_SCALE / entryPrice -- see
// PositionToken._computeValue. At leverage 5 this reduces to the 2.5 "size units" used
// throughout PositionToken.js.
const sizeForLeverage = (leverage) => (leverage * PRICE_SCALE) / 2n;

// The tiered risk table LendingPool._riskTierFor resolves against, mirrored here so tests
// assert against the spec's own numbers rather than against whatever the contract happens to do.
const RISK_TIERS = {
  low: { leverage: 5n, ltvBps: 5_000n, liquidationThresholdBps: 6_000n, liquidationBonusBps: 800n },
  mid: { leverage: 8n, ltvBps: 4_000n, liquidationThresholdBps: 5_000n, liquidationBonusBps: 1_000n },
  high: { leverage: 15n, ltvBps: 2_500n, liquidationThresholdBps: 3_500n, liquidationBonusBps: 1_200n },
};

const LTV_BPS = RISK_TIERS.low.ltvBps;
const LIQUIDATION_THRESHOLD_BPS = RISK_TIERS.low.liquidationThresholdBps;
const LIQUIDATION_BONUS_BPS = RISK_TIERS.low.liquidationBonusBps;

// Stands the whole system up: a live PositionToken (collateral), a funded LendingVault
// (liquidity), and a LendingPool cloned by the factory and auto-registered against the vault.
// `leverage` is a fixture parameter (default 5, the TIER_LOW boundary) precisely because the
// pool's risk tier is resolved from it at pool-creation time -- see the "risk tiering" suite.
async function deployLendingFixture({ leverage = RISK_TIERS.low.leverage } = {}) {
  const [deployer, creator, arcusOperator, lender, borrower, liquidator] =
    await ethers.getSigners();

  const MockUSDG = await ethers.getContractFactory("MockUSDG");
  const usdg = await MockUSDG.deploy();

  // --- collateral: one real PositionToken, creator holds all shares ---
  const PositionToken = await ethers.getContractFactory("PositionToken");
  const positionImpl = await PositionToken.deploy(usdg.target);

  const CloneFactory = await ethers.getContractFactory("CloneFactory");
  const cloneFactory = await CloneFactory.deploy();
  const receipt = await (await cloneFactory.clone(positionImpl.target)).wait();
  const cloned = receipt.logs
    .map((log) => {
      try {
        return cloneFactory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((p) => p && p.name === "Cloned");
  const positionToken = PositionToken.attach(cloned.args.instance);

  await positionToken.initialize(
    creator.address,
    ethers.encodeBytes32String("ETH-PERP"),
    Direction.Long,
    leverage,
    ENTRY_PRICE,
    sizeForLeverage(leverage),
    INITIAL_DEPOSIT,
    ethers.encodeBytes32String("arcus-1"),
    usdg.target,
    arcusOperator.address
  );

  // --- liquidity: the shared vault ---
  const LendingVault = await ethers.getContractFactory("LendingVault");
  const vault = await LendingVault.deploy(usdg.target, "Laxu USDG Vault", "lxUSDG", deployer.address);

  // --- factory, wired in as the vault's registrar ---
  const LendingPool = await ethers.getContractFactory("LendingPool");
  const poolImpl = await LendingPool.deploy();

  const LendingPoolFactory = await ethers.getContractFactory("LendingPoolFactory");
  const defaultDebtCeiling = 100_000n * PRICE_SCALE;
  const factory = await LendingPoolFactory.deploy(
    poolImpl.target,
    vault.target,
    defaultDebtCeiling,
    deployer.address
  );
  await vault.setRegistrar(factory.target);

  const poolAddress = await factory.createPool.staticCall(positionToken.target);
  await factory.createPool(positionToken.target);
  const pool = LendingPool.attach(poolAddress);

  // --- funding ---
  await usdg.mint(lender.address, 500_000n * PRICE_SCALE);
  await usdg.connect(lender).approve(vault.target, ethers.MaxUint256);
  await vault.connect(lender).deposit(200_000n * PRICE_SCALE, lender.address);

  // borrower gets the creator's position shares to use as collateral
  await positionToken.connect(creator).transfer(borrower.address, INITIAL_DEPOSIT);
  await positionToken.connect(borrower).approve(pool.target, ethers.MaxUint256);
  await usdg.mint(borrower.address, 100_000n * PRICE_SCALE);
  await usdg.connect(borrower).approve(pool.target, ethers.MaxUint256);

  await usdg.mint(liquidator.address, 100_000n * PRICE_SCALE);
  await usdg.connect(liquidator).approve(pool.target, ethers.MaxUint256);

  return {
    usdg,
    positionToken,
    vault,
    factory,
    pool,
    poolImpl,
    defaultDebtCeiling,
    deployer,
    creator,
    arcusOperator,
    lender,
    borrower,
    liquidator,
  };
}

// Pushes a new mark price through the backend's reporting path, which is the only way collateral
// value moves.
async function report(positionToken, arcusOperator, markPrice) {
  // Timestamps the report at "now" (current chain time), not merely one tick past the previous
  // report -- freshOracle compares against block.timestamp, so a report backdated to just after
  // the last one would still read as stale after a time.increase() in between.
  const ts = BigInt(await time.latest()) + 1n;
  await positionToken.connect(arcusOperator).applyReport(markPrice, 0n, ts);
}

describe("LendingVault", function () {
  it("counts lent-out USDG in totalAssets so the share price does not move on a borrow", async function () {
    const { vault, pool, positionToken, borrower } = await deployLendingFixture();

    const before = await vault.totalAssets();
    const priceBefore = await vault.convertToAssets(WAD);

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await pool.connect(borrower).borrow(100n * PRICE_SCALE);

    expect(await vault.totalAssets()).to.equal(before);
    expect(await vault.convertToAssets(WAD)).to.equal(priceBefore);
    expect(await vault.totalCurrentDebt()).to.equal(100n * PRICE_SCALE);
    expect(await vault.currentDebt(pool.target)).to.equal(100n * PRICE_SCALE);
    expect(positionToken.target).to.not.equal(ethers.ZeroAddress);
  });

  it("caps maxWithdraw at idle liquidity, not at the lender's share of totalAssets", async function () {
    const { vault, pool, borrower, lender, usdg } = await deployLendingFixture();

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await pool.connect(borrower).borrow(400n * PRICE_SCALE);

    const idle = await usdg.balanceOf(vault.target);
    expect(await vault.maxWithdraw(lender.address)).to.equal(idle);

    // and the reported maximum actually succeeds
    await vault.connect(lender).withdraw(idle, lender.address, lender.address);
  });

  it("rejects borrowFrom / repayTo from anything that is not a registered pool", async function () {
    const { vault, borrower } = await deployLendingFixture();

    await expect(vault.connect(borrower).borrowFrom(1n)).to.be.revertedWith(
      "LendingVault: not authorized pool"
    );
    await expect(vault.connect(borrower).repayTo(1n, 0n)).to.be.revertedWith(
      "LendingVault: not authorized pool"
    );
  });

  it("only the registrar may register a pool", async function () {
    const { vault, deployer, borrower } = await deployLendingFixture();

    await expect(
      vault.connect(deployer).registerPool(borrower.address, 1n)
    ).to.be.revertedWith("LendingVault: not registrar");
  });

  it("enforces the per-pool debt ceiling", async function () {
    const { vault, pool, deployer, borrower } = await deployLendingFixture();

    await vault.connect(deployer).setDebtCeiling(pool.target, 50n * PRICE_SCALE);
    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);

    await expect(pool.connect(borrower).borrow(51n * PRICE_SCALE)).to.be.revertedWith(
      "LendingVault: exceeds debt ceiling"
    );
    await pool.connect(borrower).borrow(50n * PRICE_SCALE);
  });

  it("routes repaid interest to depositors as share-price appreciation", async function () {
    const { vault, pool, borrower } = await deployLendingFixture();

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await pool.connect(borrower).borrow(400n * PRICE_SCALE);

    const priceBefore = await vault.convertToAssets(WAD);
    const supplyBefore = await vault.totalSupply();

    await time.increase(Number(SECONDS_PER_YEAR));
    await pool.connect(borrower).repay(ethers.MaxUint256);

    expect(await vault.totalCurrentDebt()).to.equal(0n);
    expect(await vault.totalSupply()).to.equal(supplyBefore); // no shares minted for yield
    expect(await vault.convertToAssets(WAD)).to.be.greaterThan(priceBefore);
  });
});

describe("LendingPoolFactory", function () {
  it("clones a pool and registers it against the vault in one call", async function () {
    const { factory, vault, pool, positionToken, defaultDebtCeiling } =
      await deployLendingFixture();

    expect(await vault.authorizedPools(pool.target)).to.equal(true);
    expect(await vault.debtCeiling(pool.target)).to.equal(defaultDebtCeiling);
    expect(await pool.collateralToken()).to.equal(positionToken.target);
    expect(await pool.lendingVault()).to.equal(vault.target);
    expect(await factory.allPoolsCount()).to.equal(1n);
    expect(await factory.primaryPool(positionToken.target)).to.equal(pool.target);
  });

  it("is permissionless, and duplicate pools get identical risk parameters", async function () {
    const { factory, positionToken, borrower } = await deployLendingFixture();

    const LendingPool = await ethers.getContractFactory("LendingPool");
    const second = await factory.connect(borrower).createPool.staticCall(positionToken.target);
    await factory.connect(borrower).createPool(positionToken.target);

    const duplicate = LendingPool.attach(second);
    expect(await duplicate.ltvBps()).to.equal(LTV_BPS);
    expect(await duplicate.liquidationThresholdBps()).to.equal(LIQUIDATION_THRESHOLD_BPS);
    expect(await factory.allPoolsCount()).to.equal(2n);
    // first-created stays canonical for the UI
    expect(await factory.primaryPool(positionToken.target)).to.not.equal(second);
  });

  it("leaves the implementation contract itself uninitializable", async function () {
    const { poolImpl, vault, positionToken } = await deployLendingFixture();

    await expect(
      poolImpl.initialize(positionToken.target, vault.target)
    ).to.be.revertedWithCustomError(poolImpl, "InvalidInitialization");
  });
});

describe("LendingPool risk tiering", function () {
  // Asserts the resolved tier against the spec's own table, per leverage bracket -- not just
  // that ltvBps/threshold/bonus are internally consistent with each other.
  async function expectTier(leverage, tier) {
    const { pool } = await deployLendingFixture({ leverage });
    expect(await pool.ltvBps()).to.equal(tier.ltvBps);
    expect(await pool.liquidationThresholdBps()).to.equal(tier.liquidationThresholdBps);
    expect(await pool.liquidationBonusBps()).to.equal(tier.liquidationBonusBps);
  }

  it("resolves TIER_LOW (1-5x) at the pool's initialize() time", async function () {
    await expectTier(1n, RISK_TIERS.low);
    await expectTier(RISK_TIERS.low.leverage, RISK_TIERS.low);
  });

  it("resolves TIER_MID (6-10x)", async function () {
    await expectTier(6n, RISK_TIERS.mid);
    await expectTier(RISK_TIERS.mid.leverage, RISK_TIERS.mid);
    await expectTier(10n, RISK_TIERS.mid);
  });

  it("resolves TIER_HIGH (11-20x), tightening LTV and raising the bonus as leverage climbs", async function () {
    await expectTier(11n, RISK_TIERS.high);
    await expectTier(RISK_TIERS.high.leverage, RISK_TIERS.high);
    await expectTier(20n, RISK_TIERS.high);

    // monotonically more conservative, tier over tier
    expect(RISK_TIERS.mid.ltvBps).to.be.lessThan(RISK_TIERS.low.ltvBps);
    expect(RISK_TIERS.high.ltvBps).to.be.lessThan(RISK_TIERS.mid.ltvBps);
    expect(RISK_TIERS.mid.liquidationBonusBps).to.be.greaterThan(RISK_TIERS.low.liquidationBonusBps);
    expect(RISK_TIERS.high.liquidationBonusBps).to.be.greaterThan(RISK_TIERS.mid.liquidationBonusBps);
  });

  it("falls through to TIER_HIGH for leverage above 20x rather than reverting (documented gap)", async function () {
    // No leverage cap is enforced by LendingPool itself -- see README known gaps. A 25x
    // position still gets a pool, just under the same numbers as an 11x one.
    await expectTier(25n, RISK_TIERS.high);
  });

  it("resolved tier is immutable for the pool's lifetime, not re-derived from live state", async function () {
    const { pool, positionToken, arcusOperator } = await deployLendingFixture({
      leverage: RISK_TIERS.low.leverage,
    });
    const before = await pool.ltvBps();

    // Push the position deep into loss; leverage itself never changes, but prove the pool
    // doesn't re-read positionInfo() and drift its tier off of anything live.
    await report(positionToken, arcusOperator, (ENTRY_PRICE * 5000n) / 10_000n);

    expect(await pool.ltvBps()).to.equal(before);
  });

  it("different pools cloned for different-leverage tokens carry independent tiers", async function () {
    const low = await deployLendingFixture({ leverage: RISK_TIERS.low.leverage });
    const high = await deployLendingFixture({ leverage: RISK_TIERS.high.leverage });

    expect(await low.pool.ltvBps()).to.equal(RISK_TIERS.low.ltvBps);
    expect(await high.pool.ltvBps()).to.equal(RISK_TIERS.high.ltvBps);
  });
});

describe("LendingPool", function () {
  describe("collateral and borrowing", function () {
    it("prices collateral live off the position token", async function () {
      const { pool, positionToken, arcusOperator, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      expect(await pool.collateralValue(borrower.address)).to.equal(INITIAL_DEPOSIT);

      // +10% on a 5x long -> position NAV rises by 5x that on the deposit
      await report(positionToken, arcusOperator, (ENTRY_PRICE * 110n) / 100n);
      // rounds down by a wei against totalAssets -- ERC-4626 virtual shares, as intended
      expect(await pool.collateralValue(borrower.address)).to.be.closeTo(
        await positionToken.totalAssets(),
        1n
      );
      expect(await pool.collateralValue(borrower.address)).to.be.greaterThan(INITIAL_DEPOSIT);
    });

    it("caps borrowing at 50% LTV", async function () {
      const { pool, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      const limit = (INITIAL_DEPOSIT * LTV_BPS) / BPS;
      expect(await pool.availableToBorrow(borrower.address)).to.equal(limit);

      await expect(pool.connect(borrower).borrow(limit + 1n)).to.be.revertedWith(
        "LendingPool: exceeds LTV"
      );
      await pool.connect(borrower).borrow(limit);
      expect(await pool.currentDebt(borrower.address)).to.equal(limit);
    });

    it("hands the borrower more headroom automatically when the position gains value", async function () {
      const { pool, positionToken, arcusOperator, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      const before = await pool.availableToBorrow(borrower.address);

      await report(positionToken, arcusOperator, (ENTRY_PRICE * 110n) / 100n);

      const after = await pool.availableToBorrow(borrower.address);
      expect(after).to.be.greaterThan(before);
      // no transaction against the pool was needed for that to happen
      await pool.connect(borrower).borrow(after);
    });

    it("blocks a collateral withdrawal that would breach the health factor", async function () {
      const { pool, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      await pool.connect(borrower).borrow((INITIAL_DEPOSIT * LTV_BPS) / BPS);

      await expect(
        pool.connect(borrower).withdrawCollateral(INITIAL_DEPOSIT / 2n)
      ).to.be.revertedWith("LendingPool: breaches health factor");
    });

    it("allows full collateral withdrawal once debt is cleared", async function () {
      const { pool, positionToken, arcusOperator, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      await pool.connect(borrower).borrow(100n * PRICE_SCALE);
      await time.increase(3600);
      await pool.connect(borrower).repay(ethers.MaxUint256);

      expect(await pool.currentDebt(borrower.address)).to.equal(0n);
      // withdrawCollateral is freshOracle-gated; the hour of time.increase above pushed the
      // position's own report past MAX_REPORT_AGE, so a fresh report is needed first.
      await report(positionToken, arcusOperator, ENTRY_PRICE);
      await pool.connect(borrower).withdrawCollateral(INITIAL_DEPOSIT);
      expect(await positionToken.balanceOf(borrower.address)).to.equal(INITIAL_DEPOSIT);
    });

    it("blocks the creator's requestClose while their shares are posted as collateral", async function () {
      const { pool, positionToken, creator, borrower } = await deployLendingFixture();

      // Hand the shares back so the creator is the one borrowing against their own position.
      await positionToken.connect(borrower).transfer(creator.address, INITIAL_DEPOSIT);
      await positionToken.connect(creator).approve(pool.target, ethers.MaxUint256);
      await pool.connect(creator).depositCollateral(INITIAL_DEPOSIT);

      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: creator must hold full supply"
      );

      await pool.connect(creator).withdrawCollateral(INITIAL_DEPOSIT);
      await expect(positionToken.connect(creator).requestClose()).to.emit(positionToken, "CloseRequested");
    });
  });

  describe("interest", function () {
    it("accrues simple interest at the flat APR and splits it from principal on repay", async function () {
      const { pool, vault, borrower } = await deployLendingFixture();

      const principal = 400n * PRICE_SCALE;
      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      await pool.connect(borrower).borrow(principal);

      await time.increase(Number(SECONDS_PER_YEAR));

      const expectedInterest = (principal * BORROW_APR_BPS) / BPS;
      const debt = await pool.currentDebt(borrower.address);
      // within a couple of blocks of drift
      expect(debt).to.be.closeTo(principal + expectedInterest, PRICE_SCALE / 1000n);

      await expect(pool.connect(borrower).repay(ethers.MaxUint256))
        .to.emit(vault, "Repaid")
        .withArgs(pool.target, principal, (i) => i >= expectedInterest);

      expect(await pool.currentDebt(borrower.address)).to.equal(0n);
      expect(await pool.debtPrincipal(borrower.address)).to.equal(0n);
      expect(await pool.interestAccrued(borrower.address)).to.equal(0n);
    });

    it("trims over-payment to the outstanding debt instead of reverting", async function () {
      const { pool, usdg, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      await pool.connect(borrower).borrow(100n * PRICE_SCALE);
      await time.increase(1000);

      const balanceBefore = await usdg.balanceOf(borrower.address);
      const debt = await pool.currentDebt(borrower.address);
      await pool.connect(borrower).repay(10_000n * PRICE_SCALE);

      const spent = balanceBefore - (await usdg.balanceOf(borrower.address));
      expect(spent).to.be.closeTo(debt, PRICE_SCALE / 1000n);
      expect(await pool.currentDebt(borrower.address)).to.equal(0n);
    });
  });

  describe("health factor", function () {
    it("reports max for a borrower with no debt", async function () {
      const { pool, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      expect(await pool.healthFactor(borrower.address)).to.equal(ethers.MaxUint256);
    });

    it("sits above 1 at the LTV cap, by exactly the threshold-to-LTV gap", async function () {
      const { pool, borrower } = await deployLendingFixture();

      await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
      await pool.connect(borrower).borrow((INITIAL_DEPOSIT * LTV_BPS) / BPS);

      // 60% threshold / 50% LTV == 1.2
      expect(await pool.healthFactor(borrower.address)).to.equal(
        (LIQUIDATION_THRESHOLD_BPS * WAD) / LTV_BPS
      );
    });
  });

  describe("liquidation", function () {
    // Borrows to the cap, then pushes the mark down until the position is underwater.
    async function underwaterFixture() {
      const f = await deployLendingFixture();
      await f.pool.connect(f.borrower).depositCollateral(INITIAL_DEPOSIT);
      await f.pool.connect(f.borrower).borrow((INITIAL_DEPOSIT * LTV_BPS) / BPS);
      return f;
    }

    it("refuses to liquidate a healthy position", async function () {
      const { pool, liquidator, borrower } = await underwaterFixture();

      await expect(
        pool.connect(liquidator).liquidate(borrower.address, 1n * PRICE_SCALE)
      ).to.be.revertedWith("LendingPool: not liquidatable");
    });

    it("liquidates at 50% close factor and pays the 8% bonus in shares", async function () {
      const { pool, positionToken, arcusOperator, borrower, liquidator } =
        await underwaterFixture();

      // -3.8% on a 5x long => NAV -19% => 810 collateral against 500 debt => HF ~0.97:
      // under water, but not past the 0.95 trigger, so the 50% close factor still applies.
      await report(positionToken, arcusOperator, (ENTRY_PRICE * 9620n) / 10_000n);

      const hf = await pool.healthFactor(borrower.address);
      expect(hf).to.be.lessThan(WAD);
      expect(hf).to.be.greaterThan((95n * WAD) / 100n); // shallow: 50% close factor applies

      const debt = await pool.currentDebt(borrower.address);
      const maxRepay = await pool.maxLiquidatableDebt(borrower.address);
      expect(maxRepay).to.be.closeTo(debt / 2n, PRICE_SCALE / 1000n);

      await expect(
        pool.connect(liquidator).liquidate(borrower.address, maxRepay + PRICE_SCALE)
      ).to.be.revertedWith("LendingPool: exceeds close factor");

      const sharesBefore = await positionToken.balanceOf(liquidator.address);
      await pool.connect(liquidator).liquidate(borrower.address, maxRepay);
      const seized = (await positionToken.balanceOf(liquidator.address)) - sharesBefore;

      // seized shares are worth repayAmount + 8%
      const seizedValue = await positionToken.convertToAssets(seized);
      expect(seizedValue).to.be.closeTo(
        (maxRepay * (BPS + LIQUIDATION_BONUS_BPS)) / BPS,
        PRICE_SCALE / 100n
      );

      expect(await pool.healthFactor(borrower.address)).to.be.greaterThan(hf);
    });

    it("raises the close factor to 100% once the health factor falls below 0.95", async function () {
      const { pool, positionToken, arcusOperator, borrower } = await underwaterFixture();

      await report(positionToken, arcusOperator, (ENTRY_PRICE * 9000n) / 10_000n);

      expect(await pool.healthFactor(borrower.address)).to.be.lessThan((95n * WAD) / 100n);
      expect(await pool.maxLiquidatableDebt(borrower.address)).to.equal(
        await pool.currentDebt(borrower.address)
      );
    });

    it("is permissionless -- an address holding no protocol role can liquidate", async function () {
      const { pool, vault, positionToken, arcusOperator, borrower, liquidator, factory } =
        await underwaterFixture();

      await report(positionToken, arcusOperator, (ENTRY_PRICE * 9000n) / 10_000n);

      // the liquidator holds nothing privileged anywhere in the system
      expect(await positionToken.arcusOperator()).to.not.equal(liquidator.address);
      expect(await vault.owner()).to.not.equal(liquidator.address);
      expect(await factory.owner()).to.not.equal(liquidator.address);
      expect(await vault.registrar()).to.not.equal(liquidator.address);

      const debtBefore = await pool.currentDebt(borrower.address);
      await pool.connect(liquidator).liquidate(borrower.address, debtBefore);

      // All but one block's worth of interest is cleared: the quote is taken before _accrue runs
      // inside the transaction, so a dust remainder is expected rather than a clean zero.
      expect(await pool.currentDebt(borrower.address)).to.be.lessThan(debtBefore / 1_000_000n);
    });

    it("transfers shares rather than routing through the async redeem path", async function () {
      const { pool, positionToken, arcusOperator, borrower, liquidator } =
        await underwaterFixture();

      await report(positionToken, arcusOperator, (ENTRY_PRICE * 9000n) / 10_000n);
      const debt = await pool.currentDebt(borrower.address);

      await expect(pool.connect(liquidator).liquidate(borrower.address, debt)).to.not.emit(
        positionToken,
        "RedeemRequested"
      );
      // the liquidator ends up holding position shares, not a pending claim
      expect(await positionToken.balanceOf(liquidator.address)).to.be.greaterThan(0n);
      expect(await positionToken.pendingRedeemRequest(0n, liquidator.address)).to.equal(0n);
    });

    it("caps the seizure at the collateral actually held when the position is deeply underwater", async function () {
      const { pool, positionToken, arcusOperator, borrower, liquidator } =
        await underwaterFixture();

      // -18% on a 5x long => NAV -90%, collateral worth far less than the debt
      await report(positionToken, arcusOperator, (ENTRY_PRICE * 8200n) / 10_000n);

      const held = await pool.collateralBalance(borrower.address);
      const debt = await pool.currentDebt(borrower.address);
      await pool.connect(liquidator).liquidate(borrower.address, debt);

      expect(await positionToken.balanceOf(liquidator.address)).to.equal(held);
      expect(await pool.collateralBalance(borrower.address)).to.equal(0n);
    });
  });
});

describe("LendingPool oracle freshness", function () {
  const MAX_REPORT_AGE = 7n * 60n; // matches LendingPool.MAX_REPORT_AGE

  it("exposes the same MAX_REPORT_AGE this suite tests against", async function () {
    const { pool } = await deployLendingFixture();
    expect(await pool.MAX_REPORT_AGE()).to.equal(MAX_REPORT_AGE);
  });

  it("blocks borrow() once the collateral's last report is older than MAX_REPORT_AGE", async function () {
    const { pool, borrower } = await deployLendingFixture();

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await time.increase(Number(MAX_REPORT_AGE) + 1);

    await expect(pool.connect(borrower).borrow(1n * PRICE_SCALE)).to.be.revertedWith(
      "LendingPool: stale oracle data"
    );
  });

  it("allows borrow() again once a fresh report lands", async function () {
    const { pool, positionToken, arcusOperator, borrower } = await deployLendingFixture();

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await time.increase(Number(MAX_REPORT_AGE) + 1);
    await expect(pool.connect(borrower).borrow(1n * PRICE_SCALE)).to.be.revertedWith(
      "LendingPool: stale oracle data"
    );

    await report(positionToken, arcusOperator, ENTRY_PRICE);
    await pool.connect(borrower).borrow(1n * PRICE_SCALE); // no longer reverts
  });

  it("blocks withdrawCollateral() the same way it blocks borrow()", async function () {
    const { pool, borrower } = await deployLendingFixture();

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await time.increase(Number(MAX_REPORT_AGE) + 1);

    await expect(
      pool.connect(borrower).withdrawCollateral(1n * PRICE_SCALE)
    ).to.be.revertedWith("LendingPool: stale oracle data");
  });

  it("does NOT block liquidate() on stale data -- liquidating on last-known data beats not liquidating at all", async function () {
    const { pool, positionToken, arcusOperator, borrower, liquidator } = await deployLendingFixture();

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await pool.connect(borrower).borrow((INITIAL_DEPOSIT * 5_000n) / BPS); // TIER_LOW LTV cap

    // Underwater report, then let it go stale past MAX_REPORT_AGE.
    await report(positionToken, arcusOperator, (ENTRY_PRICE * 9000n) / 10_000n);
    await time.increase(Number(MAX_REPORT_AGE) + 1);

    const age = BigInt(await time.latest()) - (await positionToken.lastReportTimestamp());
    expect(age).to.be.greaterThan(MAX_REPORT_AGE); // the data really is stale for this call

    const debt = await pool.currentDebt(borrower.address);
    await pool.connect(liquidator).liquidate(borrower.address, debt / 2n); // does not revert
  });

  it("does NOT block healthFactor() on stale data -- liquidate() depends on it staying callable", async function () {
    const { pool, borrower } = await deployLendingFixture();

    await pool.connect(borrower).depositCollateral(INITIAL_DEPOSIT);
    await pool.connect(borrower).borrow(1n * PRICE_SCALE);
    await time.increase(Number(MAX_REPORT_AGE) + 1);

    await expect(pool.healthFactor(borrower.address)).to.not.be.reverted;
  });
});
