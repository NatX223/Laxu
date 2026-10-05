const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  PERP_ID, PRICE_DECIMALS, LOT_DECIMALS, STATUS_LIVE, toPNS, toLNS, deployVenue, setMark, report,
} = require("./helpers/venue");

// The trust model under test: the mark comes from Perpl on-chain, the operator can only report
// funding, and every token is checked against a real venue position at creation.

const PRICE_SCALE = 10n ** 18n;
const BPS = 10_000n;
const Direction = { Long: 0, Short: 1 };
const MARKET = ethers.encodeBytes32String("ETH");
const ENTRY = 2000n * PRICE_SCALE;
const ONE = 10n ** 18n; // 18-dp asset unit
const SIZE = (5n * ONE) / 2n; // 2.5 ETH long on 1,000 at 5x
const DEPOSIT = 1000n * ONE;

/**
 * The whole system the way it is deployed: mock Perpl exchange + PerplReader, a token minted
 * through PositionTokenFactory against a real venue position, and a funded lending market on it.
 */
async function systemFixture({
  assetDecimals = 18,
  direction = Direction.Long,
  defaultStopLoss = 0n,
  defaultTakeProfit = 0n,
} = {}) {
  const [deployer, creator, operator, lender, borrower, liquidator, keeper] = await ethers.getSigners();
  const unit = 10n ** BigInt(assetDecimals);

  const asset = await (await ethers.getContractFactory("MockERC20Decimals")).deploy(assetDecimals);
  const { exchange, reader, accountId } = await deployVenue({
    market: MARKET,
    markPrice: ENTRY,
    sizeDecimals: BigInt(assetDecimals),
    position: { direction, entryPrice: ENTRY, size: (5n * unit) / 2n },
  });

  const PositionToken = await ethers.getContractFactory("PositionToken");
  const impl = await PositionToken.deploy(asset.target);
  const factory = await (await ethers.getContractFactory("PositionTokenFactory")).deploy(
    impl.target, operator.address, asset.target, reader.target
  );

  const args = (overrides = {}) => {
    const a = {
      creator: creator.address, market: MARKET, direction, leverage: 5n, entryPrice: ENTRY,
      size: (5n * unit) / 2n, initialDeposit: 1000n * unit, venuePositionId: ethers.encodeBytes32String("perpl-1"),
      venueAccountId: accountId, defaultStopLoss, defaultTakeProfit, ...overrides,
    };
    return [a.creator, a.market, a.direction, a.leverage, a.entryPrice, a.size, a.initialDeposit,
      a.venuePositionId, a.venueAccountId, a.defaultStopLoss, a.defaultTakeProfit];
  };
  const address = await factory.connect(operator).createPosition.staticCall(...args());
  await factory.connect(operator).createPosition(...args());
  const token = PositionToken.attach(address);

  const vault = await (await ethers.getContractFactory("LendingVault")).deploy(
    asset.target, "Laxu Vault", "lxV", deployer.address
  );
  const poolImpl = await (await ethers.getContractFactory("LendingPool")).deploy();
  const poolFactory = await (await ethers.getContractFactory("LendingPoolFactory")).deploy(
    poolImpl.target, vault.target, 100_000n * unit, deployer.address
  );
  await vault.setRegistrar(poolFactory.target);
  const poolAddress = await poolFactory.createPool.staticCall(token.target);
  await poolFactory.createPool(token.target);
  const pool = await ethers.getContractAt("LendingPool", poolAddress);

  await asset.mint(lender.address, 500_000n * unit);
  await asset.connect(lender).approve(vault.target, ethers.MaxUint256);
  await vault.connect(lender).deposit(200_000n * unit, lender.address);

  await token.connect(creator).transfer(borrower.address, 1000n * unit);
  await token.connect(borrower).approve(pool.target, ethers.MaxUint256);
  for (const who of [borrower, liquidator, creator]) {
    await asset.mint(who.address, 100_000n * unit);
    await asset.connect(who).approve(pool.target, ethers.MaxUint256);
    await asset.connect(who).approve(token.target, ethers.MaxUint256);
  }

  return {
    asset, exchange, reader, accountId, impl, factory, token, vault, pool, args, unit,
    deployer, creator, operator, lender, borrower, liquidator, keeper,
  };
}

describe("Venue: PerplReader", function () {
  async function readerFixture({ collateralDecimals = 6n } = {}) {
    const exchange = await (await ethers.getContractFactory("MockPerplExchange")).deploy();
    await exchange.setExchangeInfo(collateralDecimals, ethers.ZeroAddress);
    const reader = await (await ethers.getContractFactory("PerplReader")).deploy(exchange.target);
    const now = await time.latest();
    await exchange.setPerp(PERP_ID, PRICE_DECIMALS, LOT_DECIMALS, 272238n, now, 60n, STATUS_LIVE);
    await reader.setMarket(MARKET, PERP_ID);
    return { exchange, reader };
  }

  it("converts Perpl prices to 1e18 for priceDecimals 1, 2 and 6", async function () {
    const { exchange, reader } = await readerFixture();
    // $2,722.38 written at three different precisions.
    expect(await reader.toPrice(27224n, 1n)).to.equal(27224n * 10n ** 17n); // 2722.4
    expect(await reader.toPrice(272238n, 2n)).to.equal(272238n * 10n ** 16n); // 2722.38
    expect(await reader.toPrice(2722380000n, 6n)).to.equal(272238n * 10n ** 16n);

    // ...and through mark() end to end, per perp.
    for (const [pd, pns] of [[1n, 27224n], [2n, 272238n], [6n, 2722380000n]]) {
      await exchange.setPerp(PERP_ID, pd, LOT_DECIMALS, pns, await time.latest(), 60n, STATUS_LIVE);
      const [price, , valid] = await reader.mark(MARKET);
      expect(price).to.equal(pns * 10n ** (18n - pd));
      expect(valid).to.equal(true);
    }
  });

  it("converts lots to Laxu size for lotDecimals 0, 3, 5 and 8", async function () {
    const { reader } = await readerFixture({ collateralDecimals: 6n }); // AUSD: size = qty x 1e6
    expect(await reader.sizeScale()).to.equal(10n ** 6n);
    expect(await reader.toSize(7n, 0n)).to.equal(7_000_000n); // 7 MON
    expect(await reader.toSize(1_250n, 3n)).to.equal(1_250_000n); // 1.25 ETH
    expect(await reader.toSize(12_345n, 5n)).to.equal(123_450n); // 0.12345 BTC
    expect(await reader.toSize(123_456_789n, 8n)).to.equal(1_234_567n); // 1.23456789 -> rounds down
  });

  it("maps positionType 0 to Long and 1 to Short, rejects 2", async function () {
    const { exchange, reader } = await readerFixture();
    await exchange.setPosition(PERP_ID, 1n, 0, 272238n, 1_000_000n, 0n, 0n);
    await exchange.setPosition(PERP_ID, 2n, 1, 272238n, 1_000_000n, 0n, 0n);
    await exchange.setPosition(PERP_ID, 3n, 2, 272238n, 1_000_000n, 0n, 0n);

    const long = await reader.position(MARKET, 1n);
    expect(long.exists).to.equal(true);
    expect(long.direction).to.equal(Direction.Long);
    expect(long.size).to.equal(1_000_000n); // 1.000000 at lotDecimals 6 -> 1e6
    expect(long.entryPrice).to.equal(272238n * 10n ** 16n);
    expect((await reader.position(MARKET, 2n)).direction).to.equal(Direction.Short);
    await expect(reader.position(MARKET, 3n)).to.be.revertedWith("PerplReader: unknown position type");
    expect((await reader.position(MARKET, 4n)).exists).to.equal(false); // no lots -> no position
  });

  it("mark is invalid when the perp is paused (status 0)", async function () {
    const { exchange, reader } = await readerFixture();
    expect((await reader.mark(MARKET)).valid).to.equal(true);
    await exchange.setPerp(PERP_ID, PRICE_DECIMALS, LOT_DECIMALS, 272238n, await time.latest(), 60n, 0);
    expect((await reader.mark(MARKET)).valid).to.equal(false);
  });

  it("mark is invalid when the exchange is halted", async function () {
    const { exchange, reader } = await readerFixture();
    await exchange.setHalted(true);
    expect((await reader.mark(MARKET)).valid).to.equal(false);
  });

  it("mark is invalid once Perpl's refPriceMaxAgeSec has passed", async function () {
    const { exchange, reader } = await readerFixture();
    const stamped = BigInt(await time.latest());
    await exchange.setPerp(PERP_ID, PRICE_DECIMALS, LOT_DECIMALS, 272238n, stamped, 60n, STATUS_LIVE);
    // Perpl: obsolete when markTimestamp + refPriceMaxAgeSec <= block.timestamp.
    await time.setNextBlockTimestamp(stamped + 59n);
    await ethers.provider.send("evm_mine", []);
    expect((await reader.mark(MARKET)).valid).to.equal(true);
    await time.setNextBlockTimestamp(stamped + 60n);
    await ethers.provider.send("evm_mine", []);
    const [, updatedAt, valid] = await reader.mark(MARKET);
    expect(valid).to.equal(false);
    expect(updatedAt).to.equal(stamped);
  });

  it("market mapping is set-once", async function () {
    const { reader } = await readerFixture();
    await expect(reader.setMarket(MARKET, 16n)).to.be.revertedWith("PerplReader: market already mapped");
    const [, stranger] = await ethers.getSigners();
    await expect(reader.connect(stranger).setMarket(ethers.encodeBytes32String("BTC"), 16n))
      .to.be.revertedWithCustomError(reader, "OwnableUnauthorizedAccount");
  });

  it("unknown market reverts", async function () {
    const { reader } = await readerFixture();
    const btc = ethers.encodeBytes32String("BTC");
    await expect(reader.mark(btc)).to.be.revertedWith("PerplReader: unknown market");
    await expect(reader.position(btc, 1n)).to.be.revertedWith("PerplReader: unknown market");
  });

  it("venueEquity is deposit plus PnL in collateral units", async function () {
    const { exchange, reader } = await readerFixture();
    await exchange.setPosition(PERP_ID, 1n, 0, 272238n, 1_000_000n, 500_000_000n, -42_000_000n);
    expect(await reader.venueEquity(MARKET, 1n)).to.equal(458_000_000n);
  });
});

describe("Venue: creation is checked against the real position", function () {
  it("createPosition reverts when no venue position exists", async function () {
    const { factory, operator, args } = await systemFixture();
    await expect(factory.connect(operator).createPosition(...args({ venueAccountId: 999n })))
      .to.be.revertedWith("PositionToken: no venue position");
  });

  it("createPosition reverts on direction mismatch", async function () {
    const { factory, operator, args } = await systemFixture();
    await expect(factory.connect(operator).createPosition(...args({ direction: Direction.Short })))
      .to.be.revertedWith("PositionToken: direction mismatch");
  });

  it("createPosition reverts on size mismatch", async function () {
    const { factory, operator, args } = await systemFixture();
    await expect(factory.connect(operator).createPosition(...args({ size: SIZE + 1n })))
      .to.be.revertedWith("PositionToken: size mismatch");
    await expect(factory.connect(operator).createPosition(...args({ size: SIZE * 2n })))
      .to.be.revertedWith("PositionToken: size mismatch");
  });

  it("createPosition reverts when entry differs from the venue by more than 0.5%", async function () {
    const { factory, operator, args } = await systemFixture();
    // Tolerance is 0.5% of the claimed entry. Venue entry 2,000: a 2,010.06 claim is 10.06 off vs a
    // 10.0503 allowance (rejected); 2,010 is 10 off vs 10.05 (accepted).
    await expect(factory.connect(operator).createPosition(...args({ entryPrice: 201006n * 10n ** 16n })))
      .to.be.revertedWith("PositionToken: entry mismatch");
    await expect(factory.connect(operator).createPosition(...args({ entryPrice: 1989n * PRICE_SCALE })))
      .to.be.revertedWith("PositionToken: entry mismatch");
    await expect(factory.connect(operator).createPosition(...args({ entryPrice: 2010n * PRICE_SCALE })))
      .to.emit(factory, "PositionCreated");
  });

  it("createPosition succeeds when size comes from PerplReader.toSize", async function () {
    const { factory, operator, args, exchange, reader } = await systemFixture({ assetDecimals: 6 });
    // An awkward real fill: 1.234567 ETH at $2,013.37, as Perpl stores it.
    const lotLNS = 1_234_567n;
    const pricePNS = 201337n;
    await exchange.setPosition(PERP_ID, 42n, 0, pricePNS, lotLNS, 0n, 0n);

    // The backend computes both with the reader's own functions -- same integer maths, exact match.
    const size = await reader.toSize(lotLNS, LOT_DECIMALS);
    const entryPrice = await reader.toPrice(pricePNS, PRICE_DECIMALS);
    const a = args({ size, entryPrice, venueAccountId: 42n });
    const address = await factory.connect(operator).createPosition.staticCall(...a);
    await factory.connect(operator).createPosition(...a);
    const token = await ethers.getContractAt("PositionToken", address);
    expect(await token.size()).to.equal(1_234_567n);
    expect(await token.entryPrice()).to.equal(201337n * 10n ** 16n);
  });

  it("setVenueReader is owner-only and affects future positions only", async function () {
    const { factory, operator, args, token, reader, deployer } = await systemFixture();
    const other = await deployVenue({
      market: MARKET,
      markPrice: ENTRY,
      position: { direction: Direction.Long, entryPrice: ENTRY, size: SIZE },
    });
    await expect(factory.connect(operator).setVenueReader(other.reader.target))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    await expect(factory.connect(deployer).setVenueReader(ethers.ZeroAddress)).to.be.revertedWith("zero venue reader");
    await expect(factory.connect(deployer).setVenueReader(other.reader.target))
      .to.emit(factory, "VenueReaderUpdated")
      .withArgs(other.reader.target);

    const next = await factory.connect(operator).createPosition.staticCall(...args());
    await factory.connect(operator).createPosition(...args());
    expect(await (await ethers.getContractAt("PositionToken", next)).venueReader()).to.equal(other.reader.target);
    expect(await token.venueReader()).to.equal(reader.target); // existing token unchanged
  });

  it("factory rejects leverage above 20", async function () {
    const { factory, operator, args } = await systemFixture();
    await expect(factory.connect(operator).createPosition(...args({ leverage: 21n })))
      .to.be.revertedWith("leverage out of range");
    await expect(factory.connect(operator).createPosition(...args({ leverage: 0n })))
      .to.be.revertedWith("leverage out of range");
    await expect(factory.connect(operator).createPosition(...args({ leverage: 20n })))
      .to.emit(factory, "PositionCreated");
  });
});

describe("Venue: trust model", function () {
  it("NAV follows the venue mark with no operator transaction", async function () {
    const { token, keeper } = await systemFixture();
    expect(await token.totalAssets()).to.equal(DEPOSIT);

    // Only the venue moves (the mock's setter stands in for Perpl's own mark updates).
    await setMark(token, 2100n * PRICE_SCALE);
    expect(await token.totalAssets()).to.equal(DEPOSIT + 250n * ONE); // 2.5 x +100
    await setMark(token, 1900n * PRICE_SCALE);
    expect(await token.totalAssets()).to.equal(DEPOSIT - 250n * ONE);
    expect((await token.positionInfo()).markPrice_).to.equal(1900n * PRICE_SCALE);

    // sync() is permissionless and only refreshes the cache.
    await expect(token.connect(keeper).sync()).to.emit(token, "MarkSynced");
    expect(await token.markPrice()).to.equal(1900n * PRICE_SCALE);
  });

  it("operator has no function that sets the mark price", async function () {
    const { token } = await systemFixture();
    const writes = token.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name);
    expect(writes).to.not.include("applyReport");
    for (const name of writes) expect(name.toLowerCase()).to.not.match(/setmark|setprice|reportprice/);
    // The one operator report left takes funding only.
    const applyFunding = token.interface.getFunction("applyFunding");
    expect(applyFunding.inputs.map((i) => i.type)).to.deep.equal(["int256", "uint256"]);
    // close() no longer takes a price either.
    expect(token.interface.getFunction("close").inputs.map((i) => i.name)).to.deep.equal([
      "finalFunding", "wasLiquidated",
    ]);
  });

  it("executeTrigger reverts when the venue mark has not hit the level", async function () {
    const { token, operator, borrower, asset } = await systemFixture({ defaultStopLoss: 1900n * PRICE_SCALE });
    await asset.mint(token.target, 1000n * ONE);
    await setMark(token, 1901n * PRICE_SCALE);
    await expect(token.connect(operator).executeTrigger(borrower.address, 0n, 0n))
      .to.be.revertedWith("PositionToken: trigger not hit");
    await setMark(token, 1900n * PRICE_SCALE);
    await expect(token.connect(operator).executeTrigger(borrower.address, 0n, 0n))
      .to.emit(token, "TriggerExecuted");
  });

  it("executeTrigger reverts when the venue read is unavailable", async function () {
    const { token, operator, borrower, exchange, asset } = await systemFixture({ defaultStopLoss: 1900n * PRICE_SCALE });
    await asset.mint(token.target, 1000n * ONE);
    await setMark(token, 1800n * PRICE_SCALE); // breached...
    await token.sync(); // ...and even cached
    await exchange.setRevert(true);
    await expect(token.connect(operator).executeTrigger(borrower.address, 0n, 0n))
      .to.be.revertedWith("PositionToken: venue mark unavailable");
    await expect(token.connect(operator).retireDefaultTriggers())
      .to.be.revertedWith("PositionToken: venue mark unavailable");
    await exchange.setRevert(false);
    await setMark(token, 1800n * PRICE_SCALE, { status: 0 }); // paused perp: also not live
    await expect(token.connect(operator).executeTrigger(borrower.address, 0n, 0n))
      .to.be.revertedWith("PositionToken: venue mark unavailable");
  });

  it("borrow keeps working for 1 hour with no operator transaction while the venue mark updates", async function () {
    const { token, pool, borrower, operator } = await systemFixture();
    await pool.connect(borrower).depositCollateral(DEPOSIT);
    const fundingAt = await token.lastFundingTimestamp();

    for (let i = 1n; i <= 6n; i++) {
      await time.increase(10 * 60);
      await setMark(token, (2000n + i * 5n) * PRICE_SCALE); // the venue keeps ticking
      await pool.connect(borrower).borrow(10n * ONE);
    }
    expect(await pool.currentDebt(borrower.address)).to.be.closeTo(60n * ONE, ONE / 1000n);
    expect(await token.lastFundingTimestamp()).to.equal(fundingAt); // the operator never acted
    expect(BigInt(await time.latest()) - fundingAt).to.be.greaterThanOrEqual(3600n);
    operator; // unused on purpose
  });

  it("borrow reverts when funding is older than FUNDING_MAX_AGE", async function () {
    const { token, pool, borrower, operator } = await systemFixture();
    await pool.connect(borrower).depositCollateral(DEPOSIT);
    await time.increase(2 * 60 * 60 + 1);
    await setMark(token, ENTRY); // venue mark is perfectly fresh
    expect(await token.isPriceFresh()).to.equal(false);
    await expect(pool.connect(borrower).borrow(1n * ONE)).to.be.revertedWith("LendingPool: stale oracle data");

    await report(token, operator, ENTRY, 0n); // a funding report restores it
    await pool.connect(borrower).borrow(1n * ONE);
  });

  it("borrow reverts when the venue mark is invalid or stale", async function () {
    const { token, pool, borrower, exchange } = await systemFixture();
    await pool.connect(borrower).depositCollateral(DEPOSIT);
    const stale = "LendingPool: stale oracle data";

    await setMark(token, ENTRY, { status: 0 }); // paused
    await expect(pool.connect(borrower).borrow(ONE)).to.be.revertedWith(stale);

    await setMark(token, ENTRY);
    await exchange.setHalted(true); // halted
    await expect(pool.connect(borrower).borrow(ONE)).to.be.revertedWith(stale);
    await exchange.setHalted(false);

    await exchange.setRevert(true); // unreadable
    await expect(pool.connect(borrower).borrow(ONE)).to.be.revertedWith(stale);
    await exchange.setRevert(false);

    const now = BigInt(await time.latest());
    await setMark(token, ENTRY, { timestamp: now - 5n * 60n - 2n }); // older than MARK_MAX_AGE
    await expect(pool.connect(borrower).borrow(ONE)).to.be.revertedWith(stale);

    await setMark(token, ENTRY, { refPriceMaxAgeSec: 30n }); // fresh by ours, then past Perpl's own rule
    await pool.connect(borrower).borrow(ONE);
    await time.increase(31);
    await expect(pool.connect(borrower).borrow(ONE)).to.be.revertedWith(stale);
  });

  it("totalAssets falls back to the cached mark and never reverts when the venue reverts", async function () {
    const { token, exchange, keeper } = await systemFixture();
    await setMark(token, 2100n * PRICE_SCALE);
    await token.connect(keeper).sync();
    await setMark(token, 2200n * PRICE_SCALE);
    expect(await token.totalAssets()).to.equal(DEPOSIT + 500n * ONE);

    await exchange.setRevert(true);
    expect(await token.totalAssets()).to.equal(DEPOSIT + 250n * ONE); // last synced: 2,100
    const [price, live] = await token.currentMark();
    expect(price).to.equal(2100n * PRICE_SCALE);
    expect(live).to.equal(false);
    expect(await token.isPriceFresh()).to.equal(false);
    await expect(token.navPerShare()).to.not.be.reverted;
    await expect(token.connect(keeper).sync()).to.not.be.reverted; // no-op, keeps the cache
    expect(await token.markPrice()).to.equal(2100n * PRICE_SCALE);
  });

  it("liquidation still works when the venue read reverts", async function () {
    const { token, pool, borrower, liquidator, exchange } = await systemFixture();
    await pool.connect(borrower).depositCollateral(DEPOSIT);
    await pool.connect(borrower).borrow((DEPOSIT * 5_000n) / BPS);

    await setMark(token, 1800n * PRICE_SCALE); // -10% on 5x: underwater
    await token.sync();
    await exchange.setRevert(true);

    expect(await pool.healthFactor(borrower.address)).to.be.lessThan(PRICE_SCALE);
    const debt = await pool.currentDebt(borrower.address);
    await expect(pool.connect(liquidator).liquidate(borrower.address, debt)).to.emit(pool, "Liquidated");
    expect(await token.balanceOf(liquidator.address)).to.be.greaterThan(0n);
  });

  it("close uses the live venue mark, not an operator value", async function () {
    const { token, operator, borrower, creator, exchange } = await systemFixture();
    await token.connect(borrower).transfer(creator.address, DEPOSIT);
    await token.connect(creator).requestClose();

    await exchange.setRevert(true);
    await expect(token.connect(operator).close(0n, false)).to.be.revertedWith("PositionToken: venue mark unavailable");
    await exchange.setRevert(false);

    await setMark(token, 2100n * PRICE_SCALE);
    await expect(token.connect(operator).close(-10n * ONE, false))
      .to.emit(token, "PositionClosed")
      .withArgs(DEPOSIT + 250n * ONE - 10n * ONE, false);
    expect(await token.markPrice()).to.equal(2100n * PRICE_SCALE);
  });

  it("liquidation close succeeds on a cached mark when the venue is unreadable", async function () {
    const { token, operator, exchange } = await systemFixture();
    await setMark(token, 1900n * PRICE_SCALE);
    await token.sync();
    await exchange.setRevert(true);
    await expect(token.connect(operator).close(0n, true))
      .to.emit(token, "PositionClosed")
      .withArgs(DEPOSIT - 250n * ONE, true);
    expect(await token.closedReason()).to.equal(1);
  });

  it("venueDrift reports size and entry drift", async function () {
    const { token, operator, creator, exchange, accountId } = await systemFixture();
    let d = await token.venueDrift();
    expect([d.ourSize, d.venueSize, d.ourEntry, d.venueEntry, d.venueExists]).to.deep.equal([SIZE, SIZE, ENTRY, ENTRY, true]);

    // A top-up the backend filled on the venue: the token records it...
    await token.connect(creator).requestDeposit(100n * ONE, creator.address, creator.address);
    await token.connect(operator).fulfillDepositRequest(0, creator.address, SIZE / 10n, 2200n * PRICE_SCALE);
    d = await token.venueDrift();
    expect(d.ourSize).to.equal((SIZE * 11n) / 10n);
    expect(d.venueSize).to.equal(SIZE); // ...but the venue hasn't moved yet: visible drift
    expect(d.ourEntry).to.not.equal(d.venueEntry);

    // Once the venue shows the fill, they agree again.
    const ourEntry = await token.entryPrice();
    await exchange.setPosition(PERP_ID, accountId, 0, toPNS(2018n * PRICE_SCALE), toLNS((SIZE * 11n) / 10n), 0n, 0n);
    d = await token.venueDrift();
    expect(d.venueSize).to.equal(d.ourSize);
    expect(ourEntry).to.equal((SIZE * ENTRY + (SIZE / 10n) * 2200n * PRICE_SCALE) / ((SIZE * 11n) / 10n));

    await exchange.setRevert(true);
    d = await token.venueDrift();
    expect(d.venueExists).to.equal(false);
    expect(d.ourSize).to.equal((SIZE * 11n) / 10n);
  });
});

describe("Venue: lending", function () {
  it("dust threshold scales with asset decimals (6 and 18)", async function () {
    const six = await systemFixture({ assetDecimals: 6 });
    expect(await six.pool.DUST_THRESHOLD_USD()).to.equal(50n * 10n ** 6n);
    const eighteen = await systemFixture({ assetDecimals: 18 });
    expect(await eighteen.pool.DUST_THRESHOLD_USD()).to.equal(50n * 10n ** 18n);
  });
});
