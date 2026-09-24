const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const PRICE_SCALE = 10n ** 18n;
const BPS_DENOMINATOR = 10_000n;
const BUY_IN_FEE_BPS = 200n; // 2%
const REQUEST_CANCEL_TIMEOUT = 20n * 60n;
const Direction = { Long: 0, Short: 1 };

// "#" + first 4 bytes of arcusPositionId as hex -- "arcu" from encodeBytes32String("arcus-1").
const STRUCTURED_NAME = "Laxu ETH-PERP Long 5x #61726375";

async function deployPositionTokenFixture({
  direction = Direction.Long,
  leverage = 5n,
  entryPrice = 2000n * PRICE_SCALE,
  size = (5n * PRICE_SCALE) / 2n, // 2.5 "size units" -> notional 5000 USDG @ entry (5x leverage on 1000 deposit)
  initialDeposit = 1000n * PRICE_SCALE,
  listed = false,
  defaultStopLoss = 0n,
  defaultTakeProfit = 0n,
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
      defaultStopLoss,
      defaultTakeProfit
    );

  if (listed) await positionToken.connect(creator).list("");

  for (const account of [depositor, creator]) {
    await usdg.mint(account.address, 1_000_000n * PRICE_SCALE);
    await usdg.connect(account).approve(positionToken.target, ethers.MaxUint256);
  }

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
  };
}

const feeOn = (assets) => (assets * BUY_IN_FEE_BPS) / BPS_DENOMINATOR;

async function reportPrice(positionToken, backendOperator, markPrice, funding, timestamp) {
  return positionToken.connect(backendOperator).applyReport(markPrice, funding, timestamp);
}

// A listed position with `depositor` holding shares bought in at price 1 (net of the fee).
async function boughtInFixture() {
  const fixture = await deployPositionTokenFixture({ listed: true });
  const { positionToken, depositor, backendOperator } = fixture;

  const assets = 100n * PRICE_SCALE;
  const netAssets = assets - feeOn(assets);

  await positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address);
  await positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, 0n, 0n);

  return { ...fixture, depositedShares: netAssets };
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
      expect(await positionToken.listed()).to.equal(false);
    });

    it("cannot be initialized twice", async function () {
      const { positionToken, creator, market, direction, leverage, entryPrice, size, initialDeposit, arcusPositionId, usdg, backendOperator } =
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
          0n,
          0n
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
            0n
          )
      ).to.be.revertedWith("PositionToken: asset mismatch");
    });
  });

  describe("PositionTokenFactory.createPosition", function () {
    it("creates a position with the 10-argument signature, unlisted and with no nickname", async function () {
      const [, creator, operator] = await ethers.getSigners();

      const MockUSDG = await ethers.getContractFactory("MockUSDG");
      const usdg = await MockUSDG.deploy();
      const PositionToken = await ethers.getContractFactory("PositionToken");
      const implementation = await PositionToken.deploy(usdg.target);
      const Factory = await ethers.getContractFactory("PositionTokenFactory");
      const factory = await Factory.deploy(implementation.target, operator.address, usdg.target);

      const args = [
        creator.address,
        ethers.encodeBytes32String("ETH-PERP"),
        Direction.Long,
        5n,
        2000n * PRICE_SCALE,
        (5n * PRICE_SCALE) / 2n,
        1000n * PRICE_SCALE,
        ethers.encodeBytes32String("arcus-1"),
        1900n * PRICE_SCALE,
        2400n * PRICE_SCALE,
      ];
      const address = await factory.connect(operator).createPosition.staticCall(...args);
      await expect(factory.connect(operator).createPosition(...args)).to.emit(factory, "PositionCreated");

      const token = PositionToken.attach(address);
      expect(await token.nickname()).to.equal("");
      expect(await token.name()).to.equal(STRUCTURED_NAME);
      expect(await token.listed()).to.equal(false);
      expect(await token.arcusOperator()).to.equal(operator.address);
      expect(await token.balanceOf(creator.address)).to.equal(1000n * PRICE_SCALE);
      expect(await token.defaultStopLoss()).to.equal(1900n * PRICE_SCALE);
      expect(await token.defaultTakeProfit()).to.equal(2400n * PRICE_SCALE);
      expect(await token.defaultsActive()).to.equal(true);
    });
  });

  describe("list", function () {
    it("is creator-only", async function () {
      const { positionToken, otherAccount } = await deployPositionTokenFixture();

      await expect(positionToken.connect(otherAccount).list("mine")).to.be.revertedWith(
        "PositionToken: not creator"
      );
    });

    it("sets the nickname once and shows it as a name suffix", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      await expect(positionToken.connect(creator).list("Moon Shot"))
        .to.emit(positionToken, "Listed")
        .withArgs("Moon Shot");

      expect(await positionToken.listed()).to.equal(true);
      expect(await positionToken.nickname()).to.equal("Moon Shot");
      expect(await positionToken.name()).to.equal(`${STRUCTURED_NAME} · Moon Shot`);
    });

    it("is one-way: a second call reverts", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      await positionToken.connect(creator).list("first");
      await expect(positionToken.connect(creator).list("second")).to.be.revertedWith(
        "PositionToken: already listed"
      );
      expect(await positionToken.nickname()).to.equal("first");
    });

    it("rejects a nickname over 32 bytes and accepts exactly 32", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      await expect(positionToken.connect(creator).list("x".repeat(33))).to.be.revertedWith(
        "PositionToken: nickname too long"
      );
      await positionToken.connect(creator).list("x".repeat(32));
      expect(await positionToken.listed()).to.equal(true);
    });

    it('allows list("") and leaves no suffix', async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      await positionToken.connect(creator).list("");
      expect(await positionToken.listed()).to.equal(true);
      expect(await positionToken.name()).to.equal(STRUCTURED_NAME);
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
    it("rejects a non-creator buy-in while unlisted and accepts it after list()", async function () {
      const { positionToken, depositor, creator } = await deployPositionTokenFixture();

      await expect(
        positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address)
      ).to.be.revertedWith("PositionToken: not listed");

      await positionToken.connect(creator).list("");
      await expect(
        positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address)
      ).to.emit(positionToken, "DepositRequested");
    });

    it("lets the creator top up their own unlisted position with no fee", async function () {
      const { positionToken, creator, usdg } = await deployPositionTokenFixture();

      const assets = 100n * PRICE_SCALE;
      const balBefore = await usdg.balanceOf(creator.address);

      await expect(positionToken.connect(creator).requestDeposit(assets, creator.address, creator.address))
        .to.emit(positionToken, "DepositRequested")
        .withArgs(creator.address, assets, 0n)
        .and.not.to.emit(positionToken, "CreatorFeeCollected");

      expect(await usdg.balanceOf(creator.address)).to.equal(balBefore - assets);
      expect(await positionToken.pendingDepositRequest(0, creator.address)).to.equal(assets);
    });

    it("sends exactly 2% of a non-creator buy-in to the creator and queues the net amount", async function () {
      const { positionToken, depositor, creator, usdg } = await deployPositionTokenFixture({ listed: true });

      const assets = 100n * PRICE_SCALE;
      const fee = feeOn(assets);
      expect(fee).to.equal(2n * PRICE_SCALE);
      const netAssets = assets - fee;

      const creatorBalBefore = await usdg.balanceOf(creator.address);

      await expect(positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address))
        .to.emit(positionToken, "DepositRequested")
        .withArgs(depositor.address, netAssets, 0n);

      expect(await usdg.balanceOf(creator.address)).to.equal(creatorBalBefore + fee);
      expect(await positionToken.pendingDepositRequest(0, depositor.address)).to.equal(netAssets);
    });

    it("reverts when controller or owner isn't the caller", async function () {
      const { positionToken, depositor, otherAccount } = await deployPositionTokenFixture({ listed: true });

      await expect(
        positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, otherAccount.address, depositor.address)
      ).to.be.revertedWith("PositionToken: caller must be owner and controller");
      await expect(
        positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, otherAccount.address)
      ).to.be.revertedWith("PositionToken: caller must be owner and controller");
    });

    it("only the backend operator can fulfill a deposit", async function () {
      const { positionToken, depositor, otherAccount } = await deployPositionTokenFixture({ listed: true });

      await positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address);

      await expect(
        positionToken.connect(otherAccount).fulfillDepositRequest(0, depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: not backend operator");
    });

    it("auto-settles on fulfil: mints shares straight to the buyer, nothing left pending or claimable", async function () {
      const { positionToken, depositor, backendOperator } = await deployPositionTokenFixture({ listed: true });

      const assets = 100n * PRICE_SCALE;
      const netAssets = assets - feeOn(assets);

      await positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address);

      // mark 2400 -> pnl = 2.5 * 400 = 1000 on a 1000 deposit -> NAV/share = 2, so the buyer gets
      // half as many shares per asset. The contract prices this itself.
      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await reportPrice(positionToken, backendOperator, 2400n * PRICE_SCALE, 0n, ts);
      const nav = 2n * PRICE_SCALE;
      expect(await positionToken.navPerShare()).to.equal(nav);
      const expectedShares = (netAssets * PRICE_SCALE) / nav;
      const balBefore = await positionToken.balanceOf(depositor.address);

      await expect(positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, 0n, 0n))
        .to.emit(positionToken, "DepositFulfilled")
        .withArgs(depositor.address, netAssets, expectedShares, nav, 0n, 0n);

      expect(await positionToken.balanceOf(depositor.address)).to.equal(balBefore + expectedShares);
      expect(await positionToken.pendingDepositRequest(0, depositor.address)).to.equal(0n);
      expect(await positionToken.claimableDepositRequest(0, depositor.address)).to.equal(0n);
      expect(await positionToken.maxMint(depositor.address)).to.equal(0n);
      expect(await positionToken.totalPendingDepositAssets()).to.equal(0n);
    });

    it("rejects requestDeposit once the position is closed", async function () {
      const { positionToken, depositor, backendOperator, entryPrice } = await deployPositionTokenFixture({ listed: true });

      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);

      await expect(
        positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address)
      ).to.be.revertedWith("PositionToken: position closed");
    });
  });

  describe("redeem flow", function () {
    it("reverts when controller or owner isn't the caller", async function () {
      const { positionToken, depositor, otherAccount, depositedShares } = await boughtInFixture();

      await expect(
        positionToken.connect(depositor).requestRedeem(depositedShares, otherAccount.address, depositor.address)
      ).to.be.revertedWith("PositionToken: caller must be owner and controller");
      // Even with an ERC-20 allowance, redeeming someone else's shares is refused.
      await positionToken.connect(depositor).approve(otherAccount.address, depositedShares);
      await expect(
        positionToken.connect(otherAccount).requestRedeem(depositedShares, otherAccount.address, depositor.address)
      ).to.be.revertedWith("PositionToken: caller must be owner and controller");
    });

    it("only the backend operator can fulfill a redeem", async function () {
      const { positionToken, depositor, otherAccount, depositedShares } = await boughtInFixture();

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);

      await expect(
        positionToken.connect(otherAccount).fulfillRedeemRequest(0, depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: not backend operator");
    });

    it("reverts fulfillment if the vault hasn't received the freed USDG yet", async function () {
      // The creator's initialDeposit shares were minted at genesis with no matching USDG ever
      // entering the vault (the real capital lives on Arcus) -- so redeeming them requires the
      // backend to have actually sent freed USDG back in first.
      const { positionToken, creator, backendOperator, initialDeposit } = await deployPositionTokenFixture();

      await positionToken.connect(creator).requestRedeem(initialDeposit, creator.address, creator.address);

      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, creator.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: insufficient assets to fulfill redeem");
    });

    it("auto-settles on fulfil: pays USDG straight to the redeemer, nothing left pending or claimable", async function () {
      const { positionToken, depositor, backendOperator, usdg, depositedShares } = await boughtInFixture();

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);

      // A price move since the buy-in, then the backend having sent the payout into the token.
      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await reportPrice(positionToken, backendOperator, 2100n * PRICE_SCALE, 0n, ts);
      const nav = await positionToken.navPerShare();
      const expectedAssets = (depositedShares * nav) / PRICE_SCALE;
      await usdg.mint(positionToken.target, expectedAssets);

      const balBefore = await usdg.balanceOf(depositor.address);
      await expect(positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, 0n, 0n))
        .to.emit(positionToken, "RedeemFulfilled")
        .withArgs(depositor.address, depositedShares, expectedAssets, nav, 0n, 0n);

      expect(await usdg.balanceOf(depositor.address)).to.equal(balBefore + expectedAssets);
      expect(await positionToken.balanceOf(depositor.address)).to.equal(0n);
      expect(await positionToken.pendingRedeemRequest(0, depositor.address)).to.equal(0n);
      expect(await positionToken.claimableRedeemRequest(0, depositor.address)).to.equal(0n);
      expect(await positionToken.totalPendingRedeemShares()).to.equal(0n);
    });
  });

  describe("cancel", function () {
    it("cancelDepositRequest reverts before 20 minutes, then refunds the full pending amount", async function () {
      const { positionToken, depositor, usdg } = await deployPositionTokenFixture({ listed: true });

      const assets = 100n * PRICE_SCALE;
      const netAssets = assets - feeOn(assets);
      await positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address);

      await expect(positionToken.connect(depositor).cancelDepositRequest()).to.be.revertedWith(
        "PositionToken: too early to cancel"
      );

      await time.increase(REQUEST_CANCEL_TIMEOUT);
      const balBefore = await usdg.balanceOf(depositor.address);
      const pendingBefore = await positionToken.totalPendingDepositAssets();

      await expect(positionToken.connect(depositor).cancelDepositRequest())
        .to.emit(positionToken, "DepositRequestCancelled")
        .withArgs(depositor.address, netAssets);

      expect(await usdg.balanceOf(depositor.address)).to.equal(balBefore + netAssets);
      expect(await positionToken.totalPendingDepositAssets()).to.equal(pendingBefore - netAssets);
      expect(await positionToken.pendingDepositRequest(0, depositor.address)).to.equal(0n);
    });

    it("cancelRedeemRequest reverts before 20 minutes, then re-mints the shares", async function () {
      const { positionToken, depositor, depositedShares } = await boughtInFixture();

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);
      expect(await positionToken.balanceOf(depositor.address)).to.equal(0n);

      await expect(positionToken.connect(depositor).cancelRedeemRequest()).to.be.revertedWith(
        "PositionToken: too early to cancel"
      );

      await time.increase(REQUEST_CANCEL_TIMEOUT);
      const supplyBefore = await positionToken.totalSupply();

      await expect(positionToken.connect(depositor).cancelRedeemRequest())
        .to.emit(positionToken, "RedeemRequestCancelled")
        .withArgs(depositor.address, depositedShares);

      expect(await positionToken.balanceOf(depositor.address)).to.equal(depositedShares);
      expect(await positionToken.totalPendingRedeemShares()).to.equal(0n);
      // Pending redeem shares already counted in totalSupply, so re-minting leaves it unchanged.
      expect(await positionToken.totalSupply()).to.equal(supplyBefore);
    });

    it("fulfil after a cancel reverts", async function () {
      const { positionToken, depositor, backendOperator, usdg, depositedShares } = await boughtInFixture();

      await positionToken.connect(depositor).requestDeposit(50n * PRICE_SCALE, depositor.address, depositor.address);
      await time.increase(REQUEST_CANCEL_TIMEOUT);
      await positionToken.connect(depositor).cancelDepositRequest();
      await expect(
        positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: no pending deposit");

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);
      await time.increase(REQUEST_CANCEL_TIMEOUT);
      await positionToken.connect(depositor).cancelRedeemRequest();
      await usdg.mint(positionToken.target, depositedShares);
      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: no pending redeem");
    });

    it("cancel after a fulfil reverts", async function () {
      const { positionToken, depositor, backendOperator, usdg, depositedShares } = await boughtInFixture();

      await time.increase(REQUEST_CANCEL_TIMEOUT);
      await expect(positionToken.connect(depositor).cancelDepositRequest()).to.be.revertedWith(
        "PositionToken: no pending deposit"
      );

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);
      await usdg.mint(positionToken.target, depositedShares);
      await positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, 0n, 0n);
      await time.increase(REQUEST_CANCEL_TIMEOUT);
      await expect(positionToken.connect(depositor).cancelRedeemRequest()).to.be.revertedWith(
        "PositionToken: no pending redeem"
      );
    });

    it("a second requestDeposit resets the 20-minute clock", async function () {
      const { positionToken, depositor } = await deployPositionTokenFixture({ listed: true });

      await positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address);
      await time.increase(REQUEST_CANCEL_TIMEOUT - 60n);
      await positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address);
      await time.increase(120n); // past the first request's deadline, not the second's

      await expect(positionToken.connect(depositor).cancelDepositRequest()).to.be.revertedWith(
        "PositionToken: too early to cancel"
      );

      await time.increase(REQUEST_CANCEL_TIMEOUT);
      await positionToken.connect(depositor).cancelDepositRequest();
    });
  });

  describe("requestClose", function () {
    it("succeeds for an unlisted creator holding 100%", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      await expect(positionToken.connect(creator).requestClose())
        .to.emit(positionToken, "CloseRequested")
        .withArgs(creator.address);
      expect(await positionToken.closeRequested()).to.equal(true);
    });

    it("is creator-only", async function () {
      const { positionToken, otherAccount } = await deployPositionTokenFixture();

      await expect(positionToken.connect(otherAccount).requestClose()).to.be.revertedWith(
        "PositionToken: not creator"
      );
    });

    it("succeeds for a listed position once the creator holds 100% again", async function () {
      const { positionToken, creator, depositor, backendOperator, usdg, depositedShares } =
        await boughtInFixture();

      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: creator must hold full supply"
      );

      // The buyer redeems out at price 1.
      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);
      await usdg.mint(positionToken.target, depositedShares);
      await positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, 0n, 0n);

      await expect(positionToken.connect(creator).requestClose()).to.emit(positionToken, "CloseRequested");
    });

    it("reverts while another holder has a redeem pending", async function () {
      const { positionToken, creator, depositor, depositedShares } = await boughtInFixture();

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);
      expect(await positionToken.balanceOf(creator.address)).to.not.equal(await positionToken.totalSupply());
      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: creator must hold full supply"
      );
    });

    it("reverts while a deposit is pending", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      await positionToken.connect(creator).requestDeposit(10n * PRICE_SCALE, creator.address, creator.address);
      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: deposit pending"
      );
    });

    it("reverts after the creator transfers tokens away", async function () {
      const { positionToken, creator, otherAccount } = await deployPositionTokenFixture();

      await positionToken.connect(creator).transfer(otherAccount.address, 1n);
      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: creator must hold full supply"
      );
    });

    it("reverts while the creator has a redeem pending", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      // Pending redeem shares are burned but still counted in totalSupply.
      await positionToken.connect(creator).requestRedeem(1n, creator.address, creator.address);
      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: creator must hold full supply"
      );
    });

    it("reverts if a close is already requested", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture();

      await positionToken.connect(creator).requestClose();
      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: close already requested"
      );
    });
  });

  describe("close", function () {
    async function closeRequestedFixture() {
      const fixture = await deployPositionTokenFixture();
      await fixture.positionToken.connect(fixture.creator).requestClose();
      return fixture;
    }

    it("only the backend operator can close", async function () {
      const { positionToken, otherAccount, entryPrice } = await closeRequestedFixture();

      await expect(positionToken.connect(otherAccount).close(entryPrice, 0n, false)).to.be.revertedWith(
        "PositionToken: not backend operator"
      );
    });

    it("close(..., false) reverts without a prior request", async function () {
      const { positionToken, backendOperator, entryPrice } = await deployPositionTokenFixture();

      await expect(positionToken.connect(backendOperator).close(entryPrice, 0n, false)).to.be.revertedWith(
        "PositionToken: no close request"
      );
    });

    it("close(..., true) records a liquidation without a request", async function () {
      const { positionToken, backendOperator, entryPrice } = await deployPositionTokenFixture({ listed: true });

      await expect(positionToken.connect(backendOperator).close(entryPrice, 0n, true))
        .to.emit(positionToken, "PositionClosed");
      expect(await positionToken.closedReason()).to.equal(1); // ClosedReason.Liquidated
    });

    it("locks finalNavValue using the same PnL formula and freezes totalAssets", async function () {
      const { positionToken, backendOperator, initialDeposit } = await closeRequestedFixture();

      await expect(positionToken.connect(backendOperator).close(2100n * PRICE_SCALE, 0n, false))
        .to.emit(positionToken, "PositionClosed")
        .withArgs(initialDeposit + 250n * PRICE_SCALE, false);

      expect(await positionToken.closed()).to.equal(true);
      expect(await positionToken.finalNavValue()).to.equal(initialDeposit + 250n * PRICE_SCALE);
      expect(await positionToken.totalAssets()).to.equal(initialDeposit + 250n * PRICE_SCALE);
      expect(await positionToken.closedReason()).to.equal(0); // ClosedReason.UserClosed
    });

    it("cannot be closed twice", async function () {
      const { positionToken, backendOperator, entryPrice } = await closeRequestedFixture();

      await positionToken.connect(backendOperator).close(entryPrice, 0n, false);
      await expect(positionToken.connect(backendOperator).close(entryPrice, 0n, false)).to.be.revertedWith(
        "PositionToken: already closed"
      );
    });

    it("rejects applyReport and list after closure", async function () {
      const { positionToken, backendOperator, creator, entryPrice } = await closeRequestedFixture();

      await positionToken.connect(backendOperator).close(entryPrice, 0n, false);

      const ts = (await ethers.provider.getBlock("latest")).timestamp + 1000;
      await expect(reportPrice(positionToken, backendOperator, entryPrice, 0n, ts)).to.be.revertedWith(
        "PositionToken: position closed"
      );
      await expect(positionToken.connect(creator).list("")).to.be.revertedWith("PositionToken: position closed");
    });
  });

  // Real units from here on: USDG and shares at 6 decimals, size = base quantity x 1e6, prices x 1e18.
  describe("buy-ins and redeems keep leverage constant", function () {
    const USD = 10n ** 6n;
    const ETH = 10n ** 6n; // size scale

    // $500 at 5x: 1.25 ETH long from $2,000.
    async function realUnitsFixture({ listed = true } = {}) {
      return deployPositionTokenFixture({
        entryPrice: 2000n * PRICE_SCALE,
        size: (125n * ETH) / 100n,
        initialDeposit: 500n * USD,
        listed,
      });
    }

    async function report(positionToken, backendOperator, mark, funding) {
      const ts = (await ethers.provider.getBlock("latest")).timestamp + 60;
      await reportPrice(positionToken, backendOperator, mark, funding, ts);
    }

    /// The value formula re-implemented off the contract's own state, to check totalAssets() against.
    async function modelValue(positionToken) {
      const [size, entry, mark, capital, funding, settled] = await Promise.all([
        positionToken.size(),
        positionToken.entryPrice(),
        positionToken.markPrice(),
        positionToken.capital(),
        positionToken.fundingAccrued(),
        positionToken.fundingSettled(),
      ]);
      const pnl = (size * (mark - entry)) / PRICE_SCALE; // Long
      return capital + pnl + (funding - settled);
    }

    it("starts with capital equal to initialDeposit", async function () {
      const { positionToken } = await realUnitsFixture();
      expect(await positionToken.capital()).to.equal(500n * USD);
      expect(await positionToken.fundingSettled()).to.equal(0n);
      expect(await positionToken.navPerShare()).to.equal(PRICE_SCALE);
    });

    it("a buy-in at NAV 1.48 leaves NAV at 1.48 and grows size, entry and capital", async function () {
      const { positionToken, creator, backendOperator } = await realUnitsFixture();

      // mark 2192: pnl = 1.25 x 192 = $240 -> V = $740 on 500 shares -> NAV 1.48.
      await report(positionToken, backendOperator, 2192n * PRICE_SCALE, 0n);
      const nav = (148n * PRICE_SCALE) / 100n;
      expect(await positionToken.navPerShare()).to.equal(nav);

      // Creator top-up (no fee) of $148: dS = 148 x 1.25 / 740 = 0.25 ETH, filled at mark.
      const assets = 148n * USD;
      const addedSize = (25n * ETH) / 100n;
      await positionToken.connect(creator).requestDeposit(assets, creator.address, creator.address);
      await expect(
        positionToken.connect(backendOperator).fulfillDepositRequest(0, creator.address, addedSize, 2192n * PRICE_SCALE)
      )
        .to.emit(positionToken, "DepositFulfilled")
        .withArgs(creator.address, assets, 100n * USD, nav, addedSize, 2192n * PRICE_SCALE);

      expect(await positionToken.navPerShare()).to.be.closeTo(nav, 1n);
      expect(await positionToken.size()).to.equal((150n * ETH) / 100n);
      // (1.25 x 2000 + 0.25 x 2192) / 1.5 = 2032
      expect(await positionToken.entryPrice()).to.equal(2032n * PRICE_SCALE);
      expect(await positionToken.capital()).to.equal(648n * USD);
      expect(await positionToken.totalAssets()).to.equal(888n * USD);
    });

    it("redeeming 50% pays 50% of totalAssets, halves capital and effective funding, and keeps NAV", async function () {
      const { positionToken, creator, backendOperator, usdg } = await realUnitsFixture({ listed: false });

      // V = 500 + 240 - 10 = $730 -> NAV 1.46
      await report(positionToken, backendOperator, 2192n * PRICE_SCALE, -10n * USD);
      const navBefore = await positionToken.navPerShare();
      expect(navBefore).to.equal((146n * PRICE_SCALE) / 100n);

      const shares = 250n * USD;
      await positionToken.connect(creator).requestRedeem(shares, creator.address, creator.address);
      await usdg.mint(positionToken.target, 365n * USD);

      const balBefore = await usdg.balanceOf(creator.address);
      await positionToken
        .connect(backendOperator)
        .fulfillRedeemRequest(0, creator.address, (625n * ETH) / 1000n, 2192n * PRICE_SCALE);

      expect(await usdg.balanceOf(creator.address)).to.equal(balBefore + 365n * USD);
      expect(await positionToken.capital()).to.equal(250n * USD);
      expect(await positionToken.fundingSettled()).to.equal(-5n * USD);
      expect(await positionToken.size()).to.equal((625n * ETH) / 1000n);
      expect(await positionToken.totalAssets()).to.equal(365n * USD);
      expect(await positionToken.navPerShare()).to.equal(navBefore);
    });

    it("two buy-ins then a redeem with mark moves in between: NAV follows the same formula throughout", async function () {
      const { positionToken, depositor, backendOperator, usdg } = await realUnitsFixture();

      async function buyIn(gross, mark) {
        await report(positionToken, backendOperator, mark, 0n);
        const [S, V] = [await positionToken.size(), await positionToken.totalAssets()];
        await positionToken.connect(depositor).requestDeposit(gross, depositor.address, depositor.address);
        const net = await positionToken.pendingDepositRequest(0, depositor.address);
        const addedSize = (net * S) / V;
        const navBefore = await positionToken.navPerShare();
        await positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, addedSize, mark);
        expect(await positionToken.totalAssets()).to.equal(await modelValue(positionToken));
        // 6-dp shares round each mint by at most one unit; NAV drifts well under a millionth.
        expect(await positionToken.navPerShare()).to.be.closeTo(navBefore, navBefore / 1_000_000n);
      }

      await buyIn(100n * USD, 2100n * PRICE_SCALE);
      await buyIn(250n * USD, 1950n * PRICE_SCALE);

      await report(positionToken, backendOperator, 2300n * PRICE_SCALE, -3n * USD);
      expect(await positionToken.totalAssets()).to.equal(await modelValue(positionToken));

      const shares = await positionToken.balanceOf(depositor.address);
      const supply = await positionToken.totalSupply();
      const closedSize = (shares * (await positionToken.size())) / supply;
      const navBefore = await positionToken.navPerShare();
      await positionToken.connect(depositor).requestRedeem(shares, depositor.address, depositor.address);
      await usdg.mint(positionToken.target, (shares * navBefore) / PRICE_SCALE);
      await positionToken
        .connect(backendOperator)
        .fulfillRedeemRequest(0, depositor.address, closedSize, 2300n * PRICE_SCALE);

      expect(await positionToken.totalAssets()).to.equal(await modelValue(positionToken));
      expect(await positionToken.navPerShare()).to.be.closeTo(navBefore, navBefore / 1_000_000n);
    });

    it("close() after buy-ins and redeems locks finalNavValue from capital", async function () {
      const { positionToken, depositor, backendOperator, usdg } = await realUnitsFixture();

      await report(positionToken, backendOperator, 2100n * PRICE_SCALE, 0n);
      await positionToken.connect(depositor).requestDeposit(200n * USD, depositor.address, depositor.address);
      await positionToken
        .connect(backendOperator)
        .fulfillDepositRequest(0, depositor.address, (25n * ETH) / 100n, 2100n * PRICE_SCALE);

      const half = (await positionToken.balanceOf(depositor.address)) / 2n;
      await positionToken.connect(depositor).requestRedeem(half, depositor.address, depositor.address);
      await usdg.mint(positionToken.target, 1_000n * USD);
      await positionToken
        .connect(backendOperator)
        .fulfillRedeemRequest(0, depositor.address, (5n * ETH) / 100n, 2100n * PRICE_SCALE);

      const finalMark = 2250n * PRICE_SCALE;
      const finalFunding = -2n * USD;
      const [size, entry, capital, settled] = await Promise.all([
        positionToken.size(),
        positionToken.entryPrice(),
        positionToken.capital(),
        positionToken.fundingSettled(),
      ]);
      const expected = capital + (size * (finalMark - entry)) / PRICE_SCALE + (finalFunding - settled);

      await positionToken.connect(backendOperator).close(finalMark, finalFunding, true);
      expect(await positionToken.finalNavValue()).to.equal(expected);
    });

    it("a redeem pending at close can no longer be fulfilled -- it is paid by claim instead", async function () {
      const { positionToken, creator, backendOperator, usdg } = await realUnitsFixture({ listed: false });

      await positionToken.connect(creator).requestRedeem(100n * USD, creator.address, creator.address);
      await positionToken.connect(backendOperator).close(2200n * PRICE_SCALE, 0n, true);
      expect(await positionToken.navPerShare()).to.equal((15n * PRICE_SCALE) / 10n); // (500 + 250) / 500

      await usdg.mint(positionToken.target, 150n * USD);
      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, creator.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: position closed");
    });

    it("rejects a buy-in fulfil once closed", async function () {
      const { positionToken, depositor, backendOperator } = await realUnitsFixture();

      await positionToken.connect(depositor).requestDeposit(100n * USD, depositor.address, depositor.address);
      await positionToken.connect(backendOperator).close(2000n * PRICE_SCALE, 0n, true);
      await expect(
        positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: position closed");
    });
  });

  describe("settle and claim", function () {
    const SUPPLY = 1000n * PRICE_SCALE;

    // Creator 50%, depositor 30%, otherAccount 20%, then liquidated on Arcus.
    async function threeHolderClosedFixture() {
      const fixture = await deployPositionTokenFixture({ initialDeposit: SUPPLY });
      const { positionToken, creator, depositor, otherAccount, backendOperator, entryPrice } = fixture;
      await positionToken.connect(creator).transfer(depositor.address, (SUPPLY * 30n) / 100n);
      await positionToken.connect(creator).transfer(otherAccount.address, (SUPPLY * 20n) / 100n);
      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);
      return fixture;
    }

    it("cancelDepositRequest works immediately once closed", async function () {
      const { positionToken, depositor, backendOperator, usdg, entryPrice } =
        await deployPositionTokenFixture({ listed: true });

      const assets = 100n * PRICE_SCALE;
      await positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address);
      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);

      const before = await usdg.balanceOf(depositor.address);
      await positionToken.connect(depositor).cancelDepositRequest();
      expect(await usdg.balanceOf(depositor.address)).to.equal(before + assets - feeOn(assets));
    });

    it("settle() is operator-only and reverts unless closed, funded and not yet settled", async function () {
      const fixture = await deployPositionTokenFixture({ listed: true });
      const { positionToken, backendOperator, depositor, otherAccount, usdg, entryPrice } = fixture;
      const amount = 500n * PRICE_SCALE;

      await expect(positionToken.connect(backendOperator).settle(0n)).to.be.revertedWith(
        "PositionToken: not closed"
      );

      // A pending buy-in is still owed back, so it doesn't count towards the payout.
      const deposit = 100n * PRICE_SCALE;
      await positionToken.connect(depositor).requestDeposit(deposit, depositor.address, depositor.address);
      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);
      await usdg.mint(positionToken.target, amount);

      await expect(positionToken.connect(otherAccount).settle(amount)).to.be.revertedWith(
        "PositionToken: not backend operator"
      );
      await expect(positionToken.connect(backendOperator).settle(amount + 1n)).to.be.revertedWith(
        "PositionToken: settlement not funded"
      );
      await expect(positionToken.connect(backendOperator).settle(amount))
        .to.emit(positionToken, "Settled")
        .withArgs(amount, SUPPLY);
      await expect(positionToken.connect(backendOperator).settle(amount)).to.be.revertedWith(
        "PositionToken: already settled"
      );
    });

    it("claim() reverts before settlement", async function () {
      const { positionToken, creator } = await threeHolderClosedFixture();
      await expect(positionToken.connect(creator).claim()).to.be.revertedWith("PositionToken: not settled");
    });

    it("pays 1,000 USDG out 500/300/200 and keeps totalAssets/totalSupply constant between claims", async function () {
      const { positionToken, backendOperator, creator, depositor, otherAccount, usdg } =
        await threeHolderClosedFixture();
      const recovered = 1000n * PRICE_SCALE;
      await usdg.mint(positionToken.target, recovered);
      await positionToken.connect(backendOperator).settle(recovered);

      const nav = await positionToken.navPerShare();
      expect(nav).to.equal(PRICE_SCALE);

      for (const [holder, expected] of [
        [creator, 500n],
        [depositor, 300n],
        [otherAccount, 200n],
      ]) {
        const before = await usdg.balanceOf(holder.address);
        await expect(positionToken.connect(holder).claim())
          .to.emit(positionToken, "Claimed")
          .withArgs(holder.address, expected * PRICE_SCALE, expected * PRICE_SCALE);
        expect(await usdg.balanceOf(holder.address)).to.equal(before + expected * PRICE_SCALE);
        expect(await positionToken.balanceOf(holder.address)).to.equal(0n);
        if ((await positionToken.totalSupply()) > 0n) expect(await positionToken.navPerShare()).to.equal(nav);
      }

      expect(await positionToken.totalSupply()).to.equal(0n);
      expect(await positionToken.totalAssets()).to.equal(0n);
      expect(await usdg.balanceOf(positionToken.target)).to.equal(0n);
      await expect(positionToken.connect(creator).claim()).to.be.revertedWith("PositionToken: nothing to claim");
    });

    it("pays a redeem caught pending at close its pro-rata share", async function () {
      const { positionToken, backendOperator, creator, usdg, entryPrice } = await deployPositionTokenFixture({
        initialDeposit: SUPPLY,
      });
      const pending = 200n * PRICE_SCALE;
      await positionToken.connect(creator).requestRedeem(pending, creator.address, creator.address);
      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);

      const recovered = 600n * PRICE_SCALE; // 0.6 per share
      await usdg.mint(positionToken.target, recovered);
      await positionToken.connect(backendOperator).settle(recovered);

      const before = await usdg.balanceOf(creator.address);
      await expect(positionToken.connect(creator).claim())
        .to.emit(positionToken, "Claimed")
        .withArgs(creator.address, SUPPLY, recovered);
      expect(await usdg.balanceOf(creator.address)).to.equal(before + recovered);
      expect(await positionToken.pendingRedeemRequest(0, creator.address)).to.equal(0n);
      expect(await positionToken.totalPendingRedeemShares()).to.equal(0n);
      expect(await positionToken.totalSupply()).to.equal(0n);
    });

    it("claimFor pays the holder, never the caller, and rejects contract addresses", async function () {
      const { positionToken, backendOperator, depositor, otherAccount, usdg } = await threeHolderClosedFixture();
      const recovered = 1000n * PRICE_SCALE;
      await usdg.mint(positionToken.target, recovered);
      await positionToken.connect(backendOperator).settle(recovered);

      await expect(positionToken.connect(otherAccount).claimFor(usdg.target)).to.be.revertedWith(
        "PositionToken: holder is a contract"
      );

      const callerBefore = await usdg.balanceOf(otherAccount.address);
      const holderBefore = await usdg.balanceOf(depositor.address);
      await positionToken.connect(otherAccount).claimFor(depositor.address);
      expect(await usdg.balanceOf(depositor.address)).to.equal(holderBefore + 300n * PRICE_SCALE);
      expect(await usdg.balanceOf(otherAccount.address)).to.equal(callerBefore);
    });

    it("recoverExcess returns only the float above unclaimed + pending deposits, and claims still pay in full", async function () {
      const fixture = await deployPositionTokenFixture({ initialDeposit: SUPPLY, listed: true });
      const { positionToken, backendOperator, creator, depositor, deployer, usdg, entryPrice } = fixture;

      const deposit = 100n * PRICE_SCALE;
      const pendingNet = deposit - feeOn(deposit);
      await positionToken.connect(depositor).requestDeposit(deposit, depositor.address, depositor.address);
      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);

      const recovered = 800n * PRICE_SCALE;
      const float = 300n * PRICE_SCALE;
      await usdg.mint(positionToken.target, recovered + float);
      await positionToken.connect(backendOperator).settle(recovered);

      await expect(positionToken.connect(creator).recoverExcess(creator.address)).to.be.revertedWith(
        "PositionToken: not backend operator"
      );
      const before = await usdg.balanceOf(deployer.address);
      await positionToken.connect(backendOperator).recoverExcess(deployer.address);
      expect(await usdg.balanceOf(deployer.address)).to.equal(before + float);
      expect(await usdg.balanceOf(positionToken.target)).to.equal(recovered + pendingNet);
      await expect(positionToken.connect(backendOperator).recoverExcess(deployer.address)).to.be.revertedWith(
        "PositionToken: nothing to recover"
      );

      const creatorBefore = await usdg.balanceOf(creator.address);
      await positionToken.connect(creator).claim();
      expect(await usdg.balanceOf(creator.address)).to.equal(creatorBefore + recovered);
      await positionToken.connect(depositor).cancelDepositRequest(); // the refund is still there
    });

    it("settle(0) records a fully wiped liquidation; claim pays 0 and burns the shares", async function () {
      const { positionToken, backendOperator, creator, usdg } = await threeHolderClosedFixture();

      await positionToken.connect(backendOperator).settle(0n);
      const before = await usdg.balanceOf(creator.address);
      await expect(positionToken.connect(creator).claim())
        .to.emit(positionToken, "Claimed")
        .withArgs(creator.address, 500n * PRICE_SCALE, 0n);
      expect(await usdg.balanceOf(creator.address)).to.equal(before);
      expect(await positionToken.balanceOf(creator.address)).to.equal(0n);
    });
  });

  describe("per-holder stop loss / take profit", function () {
    const SL = 1900n * PRICE_SCALE;
    const TP = 2400n * PRICE_SCALE;
    const SIZE = (5n * PRICE_SCALE) / 2n; // fixture default: 2.5 units long from 2,000 on 1,000

    async function report(positionToken, backendOperator, mark) {
      const ts = (await ethers.provider.getBlock("latest")).timestamp + 60;
      await reportPrice(positionToken, backendOperator, mark, 0n, ts);
    }

    // Creator 50% on the defaults, depositor 30%, otherAccount 20%.
    async function threeHolderFixture(opts = {}) {
      const fixture = await deployPositionTokenFixture({
        listed: true,
        defaultStopLoss: SL,
        defaultTakeProfit: TP,
        ...opts,
      });
      const { positionToken, creator, depositor, otherAccount } = fixture;
      await positionToken.connect(creator).transfer(depositor.address, 300n * PRICE_SCALE);
      await positionToken.connect(creator).transfer(otherAccount.address, 200n * PRICE_SCALE);
      return fixture;
    }

    const effective = async (positionToken, who) => {
      const [sl, tp, usingDefault] = await positionToken.effectiveTriggers(who);
      return [sl, tp, usingDefault];
    };

    it("stores the defaults at creation and rejects defaults on the wrong side of entry", async function () {
      const { positionToken } = await deployPositionTokenFixture({ defaultStopLoss: SL, defaultTakeProfit: TP });
      expect(await positionToken.defaultStopLoss()).to.equal(SL);
      expect(await positionToken.defaultTakeProfit()).to.equal(TP);
      expect(await positionToken.defaultsActive()).to.equal(true);

      const none = await deployPositionTokenFixture();
      expect(await none.positionToken.defaultsActive()).to.equal(false);

      await expect(deployPositionTokenFixture({ defaultStopLoss: 2100n * PRICE_SCALE })).to.be.revertedWith(
        "PositionToken: stop loss must be below price"
      );
      await expect(
        deployPositionTokenFixture({ direction: Direction.Short, defaultTakeProfit: 2100n * PRICE_SCALE })
      ).to.be.revertedWith("PositionToken: take profit must be below price");
    });

    it("effectiveTriggers: defaults -> custom -> cleared (not the defaults) -> defaults again", async function () {
      const { positionToken, depositor } = await threeHolderFixture();

      expect(await effective(positionToken, depositor.address)).to.deep.equal([SL, TP, true]);

      await expect(positionToken.connect(depositor).setTriggers(1950n * PRICE_SCALE, 0n))
        .to.emit(positionToken, "TriggersSet")
        .withArgs(depositor.address, 1950n * PRICE_SCALE, 0n, true);
      expect(await effective(positionToken, depositor.address)).to.deep.equal([1950n * PRICE_SCALE, 0n, false]);

      await expect(positionToken.connect(depositor).clearTriggers())
        .to.emit(positionToken, "TriggersSet")
        .withArgs(depositor.address, 0n, 0n, true);
      expect(await effective(positionToken, depositor.address)).to.deep.equal([0n, 0n, false]);

      await expect(positionToken.connect(depositor).useDefaultTriggers())
        .to.emit(positionToken, "TriggersSet")
        .withArgs(depositor.address, 0n, 0n, false);
      expect(await effective(positionToken, depositor.address)).to.deep.equal([SL, TP, true]);
    });

    it("setTriggers works with a zero balance", async function () {
      const { positionToken, otherAccount } = await deployPositionTokenFixture({ listed: true });
      await positionToken.connect(otherAccount).setTriggers(SL, TP);
      expect(await effective(positionToken, otherAccount.address)).to.deep.equal([SL, TP, false]);
    });

    it("setTriggers rejects an already-breached level and the wrong side for the direction", async function () {
      const { positionToken, depositor, backendOperator } = await threeHolderFixture();
      await report(positionToken, backendOperator, 2100n * PRICE_SCALE);

      // Long: SL must be below mark, TP above.
      await expect(positionToken.connect(depositor).setTriggers(2150n * PRICE_SCALE, 0n)).to.be.revertedWith(
        "PositionToken: stop loss must be below price"
      );
      await expect(positionToken.connect(depositor).setTriggers(2100n * PRICE_SCALE, 0n)).to.be.revertedWith(
        "PositionToken: stop loss must be below price"
      );
      // 2,050 was fine at entry but is already breached at a 2,100 mark.
      await expect(positionToken.connect(depositor).setTriggers(0n, 2050n * PRICE_SCALE)).to.be.revertedWith(
        "PositionToken: take profit must be above price"
      );

      const short = await deployPositionTokenFixture({ direction: Direction.Short, listed: true });
      await expect(
        short.positionToken.connect(short.depositor).setTriggers(1900n * PRICE_SCALE, 0n)
      ).to.be.revertedWith("PositionToken: stop loss must be above price");
      await expect(
        short.positionToken.connect(short.depositor).setTriggers(0n, 2100n * PRICE_SCALE)
      ).to.be.revertedWith("PositionToken: take profit must be below price");
      await short.positionToken.connect(short.depositor).setTriggers(2100n * PRICE_SCALE, 1900n * PRICE_SCALE);
    });

    it("setTriggers is rejected once closed", async function () {
      const { positionToken, depositor, backendOperator, entryPrice } = await threeHolderFixture();
      await positionToken.connect(backendOperator).close(entryPrice, 0n, true);
      await expect(positionToken.connect(depositor).setTriggers(SL, 0n)).to.be.revertedWith(
        "PositionToken: position closed"
      );
    });

    it("executeTrigger is operator-only and reverts for a holder whose own level isn't hit", async function () {
      const { positionToken, creator, depositor, otherAccount, backendOperator, usdg } = await threeHolderFixture();
      await positionToken.connect(depositor).setTriggers(1950n * PRICE_SCALE, 0n);
      await positionToken.connect(otherAccount).clearTriggers();
      await usdg.mint(positionToken.target, 1000n * PRICE_SCALE);

      // 1,940 breaches the depositor's 1,950 -- but not the creator's default 1,900.
      await report(positionToken, backendOperator, 1940n * PRICE_SCALE);

      await expect(
        positionToken.connect(depositor).executeTrigger(depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: not backend operator");
      await expect(
        positionToken.connect(backendOperator).executeTrigger(creator.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: trigger not hit");
      await expect(
        positionToken.connect(backendOperator).executeTrigger(otherAccount.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: trigger not hit");
      await expect(
        positionToken.connect(backendOperator).executeTrigger(backendOperator.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: nothing to exit");
    });

    it("pays exactly shares x NAV and leaves the others' NAV and leverage unchanged", async function () {
      const { positionToken, depositor, backendOperator, usdg } = await threeHolderFixture();
      await positionToken.connect(depositor).setTriggers(1950n * PRICE_SCALE, 0n);
      await usdg.mint(positionToken.target, 1000n * PRICE_SCALE);

      // V = 1,000 + 2.5 x (1,940 - 2,000) = 850 on 1,000 shares -> NAV 0.85.
      const mark = 1940n * PRICE_SCALE;
      await report(positionToken, backendOperator, mark);
      const nav = await positionToken.navPerShare();
      expect(nav).to.equal((85n * PRICE_SCALE) / 100n);
      const leverageBefore = (SIZE * mark) / (await positionToken.totalAssets());

      const shares = 300n * PRICE_SCALE;
      const closedSize = (SIZE * shares) / (1000n * PRICE_SCALE); // 0.75
      const balBefore = await usdg.balanceOf(depositor.address);
      await expect(positionToken.connect(backendOperator).executeTrigger(depositor.address, closedSize, mark))
        .to.emit(positionToken, "TriggerExecuted")
        .withArgs(depositor.address, true, false, shares, 255n * PRICE_SCALE, mark);

      expect(await usdg.balanceOf(depositor.address)).to.equal(balBefore + 255n * PRICE_SCALE);
      expect(await positionToken.balanceOf(depositor.address)).to.equal(0n);
      expect(await positionToken.size()).to.equal(SIZE - closedSize);
      expect(await positionToken.capital()).to.equal(700n * PRICE_SCALE);
      expect(await positionToken.navPerShare()).to.be.closeTo(nav, 1n);
      const leverageAfter = ((await positionToken.size()) * mark) / (await positionToken.totalAssets());
      expect(leverageAfter).to.be.closeTo(leverageBefore, 1n);
      expect(await positionToken.closed()).to.equal(false);
    });

    it("fires a Short's take profit when the mark falls to it", async function () {
      const { positionToken, depositor, backendOperator, usdg } = await threeHolderFixture({
        direction: Direction.Short,
        defaultStopLoss: 2100n * PRICE_SCALE,
        defaultTakeProfit: 1800n * PRICE_SCALE,
      });
      await usdg.mint(positionToken.target, 1000n * PRICE_SCALE);
      await report(positionToken, backendOperator, 1790n * PRICE_SCALE);
      await expect(positionToken.connect(backendOperator).executeTrigger(depositor.address, 0n, 0n))
        .to.emit(positionToken, "TriggerExecuted")
        .withArgs(depositor.address, false, true, 300n * PRICE_SCALE, anyUint, 1790n * PRICE_SCALE);
    });

    it("reverts when the token can't pay without touching pending buy-in USDG", async function () {
      const { positionToken, depositor, backendOperator } = await threeHolderFixture();
      // The depositor's own pending buy-in is the only USDG in the token.
      await positionToken.connect(depositor).requestDeposit(500n * PRICE_SCALE, depositor.address, depositor.address);
      await report(positionToken, backendOperator, 1890n * PRICE_SCALE);
      await expect(
        positionToken.connect(backendOperator).executeTrigger(depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: insufficient assets");
    });

    it("only exits the wallet balance, not tokens posted as LendingPool collateral", async function () {
      const { positionToken, depositor, backendOperator, usdg } = await threeHolderFixture();
      // Stand-in pool: any contract holding the depositor's collateral.
      const pool = usdg.target;
      await positionToken.connect(depositor).transfer(pool, 100n * PRICE_SCALE);
      await usdg.mint(positionToken.target, 1000n * PRICE_SCALE);
      await report(positionToken, backendOperator, 1890n * PRICE_SCALE);

      await expect(positionToken.connect(backendOperator).executeTrigger(depositor.address, 0n, 0n))
        .to.emit(positionToken, "TriggerExecuted")
        .withArgs(depositor.address, true, true, 200n * PRICE_SCALE, anyUint, 1890n * PRICE_SCALE);
      expect(await positionToken.balanceOf(pool)).to.equal(100n * PRICE_SCALE);
    });

    it("a sole creator's SL empties the position, which closes and settles at zero; a pending buy-in refunds at once", async function () {
      const { positionToken, creator, depositor, backendOperator, usdg } = await deployPositionTokenFixture({
        listed: true,
        defaultStopLoss: SL,
      });
      const gross = 100n * PRICE_SCALE;
      const net = gross - feeOn(gross);
      await positionToken.connect(depositor).requestDeposit(gross, depositor.address, depositor.address);

      // V = 1,000 + 2.5 x (1,890 - 2,000) = 725.
      await report(positionToken, backendOperator, 1890n * PRICE_SCALE);
      await usdg.mint(positionToken.target, 725n * PRICE_SCALE);

      await expect(positionToken.connect(backendOperator).executeTrigger(creator.address, SIZE, 1890n * PRICE_SCALE))
        .to.emit(positionToken, "TriggerExecuted")
        .withArgs(creator.address, true, true, 1000n * PRICE_SCALE, 725n * PRICE_SCALE, 1890n * PRICE_SCALE)
        .and.to.emit(positionToken, "PositionClosed")
        .withArgs(0n, false)
        .and.to.emit(positionToken, "Settled")
        .withArgs(0n, 0n);

      expect(await positionToken.totalSupply()).to.equal(0n);
      expect(await positionToken.size()).to.equal(0n);
      expect(await positionToken.closed()).to.equal(true);
      expect(await positionToken.settled()).to.equal(true);
      expect(await positionToken.settlementAssets()).to.equal(0n);

      const before = await usdg.balanceOf(depositor.address);
      await expect(positionToken.connect(depositor).cancelDepositRequest())
        .to.emit(positionToken, "DepositRequestCancelled")
        .withArgs(depositor.address, net);
      expect(await usdg.balanceOf(depositor.address)).to.equal(before + net);
    });

    it("a redeem of the last share also auto-closes and settles at zero", async function () {
      const { positionToken, creator, backendOperator, usdg } = await deployPositionTokenFixture();
      await positionToken.connect(creator).requestRedeem(1000n * PRICE_SCALE, creator.address, creator.address);
      await usdg.mint(positionToken.target, 1000n * PRICE_SCALE);
      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, creator.address, SIZE, 2000n * PRICE_SCALE)
      )
        .to.emit(positionToken, "PositionClosed")
        .withArgs(0n, false);
      expect(await positionToken.closed()).to.equal(true);
      expect(await positionToken.settled()).to.equal(true);
    });

    it("retireDefaultTriggers reverts unless a default is breached; afterwards new buyers have no defaults", async function () {
      const { positionToken, depositor, otherAccount, backendOperator } = await threeHolderFixture();

      await expect(positionToken.connect(depositor).retireDefaultTriggers()).to.be.revertedWith(
        "PositionToken: not backend operator"
      );
      await expect(positionToken.connect(backendOperator).retireDefaultTriggers()).to.be.revertedWith(
        "PositionToken: default not hit"
      );

      await report(positionToken, backendOperator, 1890n * PRICE_SCALE);
      await expect(positionToken.connect(backendOperator).retireDefaultTriggers())
        .to.emit(positionToken, "DefaultTriggersRetired")
        .withArgs(1890n * PRICE_SCALE);
      expect(await positionToken.defaultsActive()).to.equal(false);
      await expect(positionToken.connect(backendOperator).retireDefaultTriggers()).to.be.revertedWith(
        "PositionToken: defaults not active"
      );

      const newBuyer = (await ethers.getSigners())[5];
      expect(await effective(positionToken, newBuyer.address)).to.deep.equal([0n, 0n, true]);
      // Nobody still on the defaults can be exited any more.
      await expect(
        positionToken.connect(backendOperator).executeTrigger(otherAccount.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: trigger not hit");
    });

    it("a custom trigger is cleared once it fires, so buying in again doesn't re-trigger it", async function () {
      const { positionToken, depositor, backendOperator, usdg } = await threeHolderFixture();
      await positionToken.connect(depositor).setTriggers(1950n * PRICE_SCALE, 0n);
      await usdg.mint(positionToken.target, 1000n * PRICE_SCALE);
      await report(positionToken, backendOperator, 1940n * PRICE_SCALE);
      await positionToken.connect(backendOperator).executeTrigger(depositor.address, 0n, 0n);

      const t = await positionToken.holderTriggers(depositor.address);
      expect(t.custom).to.equal(false);
      // Back on the defaults, which 1,940 doesn't breach.
      expect(await effective(positionToken, depositor.address)).to.deep.equal([SL, TP, true]);

      await positionToken.connect(depositor).requestDeposit(100n * PRICE_SCALE, depositor.address, depositor.address);
      await positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, 0n, 0n);
      expect(await positionToken.balanceOf(depositor.address)).to.be.gt(0n);
      await expect(
        positionToken.connect(backendOperator).executeTrigger(depositor.address, 0n, 0n)
      ).to.be.revertedWith("PositionToken: trigger not hit");
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
