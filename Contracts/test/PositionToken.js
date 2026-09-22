const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRICE_SCALE = 10n ** 18n;
const BPS_DENOMINATOR = 10_000n;
const Direction = { Long: 0, Short: 1 };

async function deployPositionTokenFixture({
  direction = Direction.Long,
  leverage = 5n,
  entryPrice = 2000n * PRICE_SCALE,
  size = (5n * PRICE_SCALE) / 2n, // 2.5 "size units" -> notional 5000 USDG @ entry (5x leverage on 1000 deposit)
  initialDeposit = 1000n * PRICE_SCALE,
  creatorFeeBps = 100n, // 1%
} = {}) {
  const [deployer, creator, backendOperator, depositor, otherAccount] =
    await ethers.getSigners();

  const MockUSDG = await ethers.getContractFactory("MockUSDG");
  const usdg = await MockUSDG.deploy();

  const PositionToken = await ethers.getContractFactory("PositionToken");
  const implementation = await PositionToken.deploy(usdg.target);

  const CloneFactory = await ethers.getContractFactory("CloneFactory");
  const cloneFactory = await CloneFactory.deploy();

  const tx = await cloneFactory.clone(implementation.target);
  const receipt = await tx.wait();
  const clonedEvent = receipt.logs
    .map((log) => {
      try {
        return cloneFactory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "Cloned");
  const positionToken = PositionToken.attach(clonedEvent.args.instance);

  const arcusPositionId = ethers.encodeBytes32String("arcus-1");
  const market = ethers.encodeBytes32String("ETH-PERP");

  await positionToken
    .connect(deployer)
    .initialize(
      creator.address,
      market,
      direction,
      leverage,
      entryPrice,
      size,
      initialDeposit,
      arcusPositionId,
      usdg.target,
      backendOperator.address,
      creatorFeeBps,
      ""
    );

  await usdg.mint(depositor.address, 1_000_000n * PRICE_SCALE);
  await usdg.connect(depositor).approve(positionToken.target, ethers.MaxUint256);

  return {
    usdg,
    implementation,
    positionToken,
    deployer,
    creator,
    backendOperator,
    depositor,
    otherAccount,
    market,
    arcusPositionId,
    direction,
    leverage,
    entryPrice,
    size,
    initialDeposit,
    creatorFeeBps,
  };
}

async function reportPrice(positionToken, backendOperator, markPrice, funding, timestamp) {
  return positionToken.connect(backendOperator).applyReport(markPrice, funding, timestamp);
}

describe("PositionToken", function () {
  describe("initialize", function () {
    it("mints initialDeposit shares to the creator at bootstrap price 1", async function () {
      const { positionToken, creator, initialDeposit } = await deployPositionTokenFixture();

      expect(await positionToken.balanceOf(creator.address)).to.equal(initialDeposit);
      expect(await positionToken.totalSupply()).to.equal(initialDeposit);
      expect(await positionToken.totalAssets()).to.equal(initialDeposit);
    });

    it("sets identity/state fields", async function () {
      const { positionToken, creator, market, arcusPositionId, leverage, entryPrice, direction } =
        await deployPositionTokenFixture();

      expect(await positionToken.creator()).to.equal(creator.address);
      expect(await positionToken.market()).to.equal(market);
      expect(await positionToken.direction()).to.equal(direction);
      expect(await positionToken.leverage()).to.equal(leverage);
      expect(await positionToken.entryPrice()).to.equal(entryPrice);
      expect(await positionToken.arcusPositionId()).to.equal(arcusPositionId);
      expect(await positionToken.markPrice()).to.equal(entryPrice);
    });

    it("cannot be initialized twice", async function () {
      const { positionToken, creator, market, direction, leverage, entryPrice, size, initialDeposit, arcusPositionId, usdg, backendOperator, creatorFeeBps } =
        await deployPositionTokenFixture();

      await expect(
        positionToken.initialize(
          creator.address,
          market,
          direction,
          leverage,
          entryPrice,
          size,
          initialDeposit,
          arcusPositionId,
          usdg.target,
          backendOperator.address,
          creatorFeeBps,
          ""
        )
      ).to.be.reverted;
    });

    it("rejects an asset that doesn't match the implementation's immutable asset", async function () {
      const [deployer, creator, backendOperator] = await ethers.getSigners();

      const MockUSDG = await ethers.getContractFactory("MockUSDG");
      const usdg = await MockUSDG.deploy();
      const wrongAsset = await MockUSDG.deploy();

      const PositionToken = await ethers.getContractFactory("PositionToken");
      const implementation = await PositionToken.deploy(usdg.target);

      const CloneFactory = await ethers.getContractFactory("CloneFactory");
      const cloneFactory = await CloneFactory.deploy();
      const tx = await cloneFactory.clone(implementation.target);
      const receipt = await tx.wait();
      const parsed = receipt.logs.map((log) => {
        try {
          return cloneFactory.interface.parseLog(log);
        } catch {
          return null;
        }
      }).find((p) => p && p.name === "Cloned");
      const clone = PositionToken.attach(parsed.args.instance);

      await expect(
        clone
          .connect(deployer)
          .initialize(
            creator.address,
            ethers.encodeBytes32String("ETH-PERP"),
            Direction.Long,
            5n,
            2000n * PRICE_SCALE,
            2n * PRICE_SCALE,
            1000n * PRICE_SCALE,
            ethers.encodeBytes32String("arcus-1"),
            wrongAsset.target,
            backendOperator.address,
            0n,
            ""
          )
      ).to.be.revertedWith("PositionToken: asset mismatch");
    });
  });

  describe("applyReport", function () {
    it("only arcusOperator can report", async function () {
      const { positionToken, otherAccount } = await deployPositionTokenFixture();

      await expect(
        reportPrice(positionToken, otherAccount, 2100n * PRICE_SCALE, 0n, (await ethers.provider.getBlock("latest")).timestamp + 1000)
      ).to.be.revertedWith("PositionToken: not arcusOperator");
    });

    it("updates markPrice/funding and moves totalAssets with PnL (Long)", async function () {
      const { positionToken, backendOperator, initialDeposit } = await deployPositionTokenFixture();

      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await reportPrice(positionToken, backendOperator, 2100n * PRICE_SCALE, 0n, ts);

      expect(await positionToken.markPrice()).to.equal(2100n * PRICE_SCALE);
      // size = 2.5e18, entry=2000, mark=2100 -> pnl = 2.5 * 100 = 250
      expect(await positionToken.totalAssets()).to.equal(initialDeposit + 250n * PRICE_SCALE);
    });

    it("moves totalAssets the opposite way for Short", async function () {
      const { positionToken, backendOperator, initialDeposit } = await deployPositionTokenFixture({
        direction: Direction.Short,
      });

      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await reportPrice(positionToken, backendOperator, 2100n * PRICE_SCALE, 0n, ts);

      expect(await positionToken.totalAssets()).to.equal(initialDeposit - 250n * PRICE_SCALE);
    });

    it("includes signed funding", async function () {
      const { positionToken, backendOperator, initialDeposit, entryPrice } = await deployPositionTokenFixture();

      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await reportPrice(positionToken, backendOperator, entryPrice, -50n * PRICE_SCALE, ts);

      expect(await positionToken.totalAssets()).to.equal(initialDeposit - 50n * PRICE_SCALE);
    });

    it("rejects a stale (non-increasing) report timestamp", async function () {
      const { positionToken, backendOperator } = await deployPositionTokenFixture();

      const lastReportTimestamp = await positionToken.lastReportTimestamp();
      await expect(
        reportPrice(positionToken, backendOperator, 2100n * PRICE_SCALE, 0n, lastReportTimestamp)
      ).to.be.revertedWith("PositionToken: stale report");
    });
  });

  describe("deposit flow", function () {
    it("skims the flat creator fee from assets and queues the net amount", async function () {
      const { positionToken, depositor, creator, usdg, creatorFeeBps } = await deployPositionTokenFixture();

      const assets = 100n * PRICE_SCALE;
      const fee = (assets * creatorFeeBps) / BPS_DENOMINATOR;
      const netAssets = assets - fee;

      const creatorBalBefore = await usdg.balanceOf(creator.address);

      await expect(positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address))
        .to.emit(positionToken, "DepositRequested")
        .withArgs(depositor.address, netAssets, 0n);

      expect(await usdg.balanceOf(creator.address)).to.equal(creatorBalBefore + fee);
      expect(await positionToken.pendingDepositRequest(0, depositor.address)).to.equal(netAssets);
    });

    it("only the backend operator can fulfill a deposit", async function () {
      const { positionToken, depositor, otherAccount } = await deployPositionTokenFixture();

      await positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address);

      await expect(
        positionToken.connect(otherAccount).fulfillDepositRequest(0, depositor.address, PRICE_SCALE)
      ).to.be.revertedWith("PositionToken: not backend operator");
    });

    it("fulfills at the given price and lets the controller claim shares", async function () {
      const { positionToken, depositor, backendOperator, creatorFeeBps } = await deployPositionTokenFixture();

      const assets = 100n * PRICE_SCALE;
      const fee = (assets * creatorFeeBps) / BPS_DENOMINATOR;
      const netAssets = assets - fee;

      await positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address);

      // price per share = 2 (i.e. NAV/share doubled since genesis) -> half as many shares per asset
      const fulfillmentPrice = 2n * PRICE_SCALE;
      await expect(
        positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, fulfillmentPrice)
      )
        .to.emit(positionToken, "DepositFulfilled")
        .withArgs(0n, fulfillmentPrice);

      const expectedShares = (netAssets * PRICE_SCALE) / fulfillmentPrice;
      expect(await positionToken.claimableDepositRequest(0, depositor.address)).to.equal(netAssets);
      expect(await positionToken.maxMint(depositor.address)).to.equal(expectedShares);

      await positionToken.connect(depositor).deposit(netAssets, depositor.address);
      expect(await positionToken.balanceOf(depositor.address)).to.equal(expectedShares);
    });

    it("rejects requestDeposit once the position is closed", async function () {
      const { positionToken, depositor, backendOperator, entryPrice } = await deployPositionTokenFixture();

      await positionToken.connect(backendOperator).close(entryPrice, 0n, false);

      await expect(
        positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address)
      ).to.be.revertedWith("PositionToken: position closed");
    });
  });

  describe("redeem flow", function () {
    async function depositedFixture() {
      const fixture = await deployPositionTokenFixture();
      const { positionToken, depositor, backendOperator, creatorFeeBps } = fixture;

      const assets = 100n * PRICE_SCALE;
      const fee = (assets * creatorFeeBps) / BPS_DENOMINATOR;
      const netAssets = assets - fee;

      await positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address);
      await positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, PRICE_SCALE);
      await positionToken.connect(depositor).deposit(netAssets, depositor.address);

      return { ...fixture, depositedShares: netAssets };
    }

    it("only the backend operator can fulfill a redeem", async function () {
      const { positionToken, depositor, otherAccount, depositedShares } = await depositedFixture();

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);

      await expect(
        positionToken.connect(otherAccount).fulfillRedeemRequest(0, depositor.address, PRICE_SCALE)
      ).to.be.revertedWith("PositionToken: not backend operator");
    });

    it("reverts fulfillment if the vault hasn't received the freed USDG yet", async function () {
      // The creator's initialDeposit shares were minted at genesis with no matching USDG ever
      // entering the vault (the real capital lives on Arcus) -- so redeeming them requires the
      // backend to have actually sent freed USDG back in first.
      const { positionToken, creator, backendOperator, initialDeposit } = await deployPositionTokenFixture();

      await positionToken.connect(creator).requestRedeem(initialDeposit, creator.address, creator.address);

      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, creator.address, PRICE_SCALE)
      ).to.be.revertedWith("PositionToken: insufficient assets to fulfill redeem");
    });

    it("completes a full request -> fulfill -> claim cycle", async function () {
      const { positionToken, depositor, backendOperator, usdg, depositedShares } = await depositedFixture();

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);

      // simulate the backend having reduced Arcus margin and sent the freed USDG back
      const expectedAssets = depositedShares; // fulfillmentPrice == PRICE_SCALE -> 1:1
      await usdg.mint(positionToken.target, expectedAssets);

      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, PRICE_SCALE)
      )
        .to.emit(positionToken, "RedeemFulfilled")
        .withArgs(0n, PRICE_SCALE);

      const balBefore = await usdg.balanceOf(depositor.address);
      await positionToken.connect(depositor).redeem(depositedShares, depositor.address, depositor.address);
      expect(await usdg.balanceOf(depositor.address)).to.equal(balBefore + expectedAssets);
      expect(await positionToken.balanceOf(depositor.address)).to.equal(0n);
    });
  });

  describe("close", function () {
    it("only the backend operator can close", async function () {
      const { positionToken, otherAccount, entryPrice } = await deployPositionTokenFixture();

      await expect(positionToken.connect(otherAccount).close(entryPrice, 0n, false)).to.be.revertedWith(
        "PositionToken: not backend operator"
      );
    });

    it("locks finalNavValue using the same PnL formula and freezes totalAssets", async function () {
      const { positionToken, backendOperator, initialDeposit } = await deployPositionTokenFixture();

      await expect(positionToken.connect(backendOperator).close(2100n * PRICE_SCALE, 0n, false))
        .to.emit(positionToken, "PositionClosed")
        .withArgs(initialDeposit + 250n * PRICE_SCALE, false);

      expect(await positionToken.closed()).to.equal(true);
      expect(await positionToken.finalNavValue()).to.equal(initialDeposit + 250n * PRICE_SCALE);
      expect(await positionToken.totalAssets()).to.equal(initialDeposit + 250n * PRICE_SCALE);
    });

    it("records the liquidation reason", async function () {
      const { positionToken, backendOperator, entryPrice } = await deployPositionTokenFixture();

      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);

      expect(await positionToken.closedReason()).to.equal(1); // ClosedReason.Liquidated
    });

    it("cannot be closed twice", async function () {
      const { positionToken, backendOperator, entryPrice } = await deployPositionTokenFixture();

      await positionToken.connect(backendOperator).close(entryPrice, 0n, false);
      await expect(positionToken.connect(backendOperator).close(entryPrice, 0n, false)).to.be.revertedWith(
        "PositionToken: already closed"
      );
    });

    it("rejects applyReport after closure", async function () {
      const { positionToken, backendOperator, entryPrice } = await deployPositionTokenFixture();

      await positionToken.connect(backendOperator).close(entryPrice, 0n, false);

      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await expect(reportPrice(positionToken, backendOperator, entryPrice, 0n, ts)).to.be.revertedWith(
        "PositionToken: position closed"
      );
    });
  });

  describe("views", function () {
    it("positionInfo reflects current state", async function () {
      const { positionToken, market, direction, leverage, entryPrice } = await deployPositionTokenFixture();

      const info = await positionToken.positionInfo();
      expect(info.market_).to.equal(market);
      expect(info.direction_).to.equal(direction);
      expect(info.leverage_).to.equal(leverage);
      expect(info.entryPrice_).to.equal(entryPrice);
      expect(info.markPrice_).to.equal(entryPrice);
      expect(info.closed_).to.equal(false);
    });

    it("currentPnLBps reflects live PnL relative to initialDeposit", async function () {
      const { positionToken, backendOperator } = await deployPositionTokenFixture();

      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await reportPrice(positionToken, backendOperator, 2100n * PRICE_SCALE, 0n, ts);

      // 250 profit / 1000 deposit = 25% = 2500 bps
      expect(await positionToken.currentPnLBps()).to.equal(2500n);
    });
  });
});
