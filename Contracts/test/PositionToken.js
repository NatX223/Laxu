const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PRICE_SCALE = 10n ** 18n;
const BPS_DENOMINATOR = 10_000n;
const BUY_IN_FEE_BPS = 200n; // 2%
const REQUEST_CANCEL_TIMEOUT = 20n * 60n;
const Direction = { Long: 0, Short: 1 };

const STRUCTURED_NAME = "Laxu ETH-PERP Long 5x #arcus-1";

async function deployPositionTokenFixture({
  direction = Direction.Long,
  leverage = 5n,
  entryPrice = 2000n * PRICE_SCALE,
  size = (5n * PRICE_SCALE) / 2n, // 2.5 "size units" -> notional 5000 USDG @ entry (5x leverage on 1000 deposit)
  initialDeposit = 1000n * PRICE_SCALE,
  listed = false,
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
      backendOperator.address
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
  await positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, PRICE_SCALE);

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
          backendOperator.address
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
            backendOperator.address
          )
      ).to.be.revertedWith("PositionToken: asset mismatch");
    });
  });

  describe("PositionTokenFactory.createPosition", function () {
    it("creates a position with the 8-argument signature, unlisted and with no nickname", async function () {
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
      ];
      const address = await factory.connect(operator).createPosition.staticCall(...args);
      await expect(factory.connect(operator).createPosition(...args)).to.emit(factory, "PositionCreated");

      const token = PositionToken.attach(address);
      expect(await token.nickname()).to.equal("");
      expect(await token.name()).to.equal(STRUCTURED_NAME);
      expect(await token.listed()).to.equal(false);
      expect(await token.arcusOperator()).to.equal(operator.address);
      expect(await token.balanceOf(creator.address)).to.equal(1000n * PRICE_SCALE);
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
        positionToken.connect(otherAccount).fulfillDepositRequest(0, depositor.address, PRICE_SCALE)
      ).to.be.revertedWith("PositionToken: not backend operator");
    });

    it("auto-settles on fulfil: mints shares straight to the buyer, nothing left pending or claimable", async function () {
      const { positionToken, depositor, backendOperator } = await deployPositionTokenFixture({ listed: true });

      const assets = 100n * PRICE_SCALE;
      const netAssets = assets - feeOn(assets);

      await positionToken.connect(depositor).requestDeposit(assets, depositor.address, depositor.address);

      // price per share = 2 (i.e. NAV/share doubled since genesis) -> half as many shares per asset
      const fulfillmentPrice = 2n * PRICE_SCALE;
      const expectedShares = (netAssets * PRICE_SCALE) / fulfillmentPrice;
      const balBefore = await positionToken.balanceOf(depositor.address);

      await expect(
        positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, fulfillmentPrice)
      )
        .to.emit(positionToken, "DepositFulfilled")
        .withArgs(0n, fulfillmentPrice);

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

    it("auto-settles on fulfil: pays USDG straight to the redeemer, nothing left pending or claimable", async function () {
      const { positionToken, depositor, backendOperator, usdg, depositedShares } = await boughtInFixture();

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);

      // simulate the backend having reduced Arcus margin and sent the freed USDG back
      const fulfillmentPrice = (3n * PRICE_SCALE) / 2n;
      const expectedAssets = (depositedShares * fulfillmentPrice) / PRICE_SCALE;
      await usdg.mint(positionToken.target, expectedAssets);

      const balBefore = await usdg.balanceOf(depositor.address);
      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, fulfillmentPrice)
      )
        .to.emit(positionToken, "RedeemFulfilled")
        .withArgs(0n, fulfillmentPrice);

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
        positionToken.connect(backendOperator).fulfillDepositRequest(0, depositor.address, PRICE_SCALE)
      ).to.be.revertedWith("PositionToken: no pending deposit");

      await positionToken.connect(depositor).requestRedeem(depositedShares, depositor.address, depositor.address);
      await time.increase(REQUEST_CANCEL_TIMEOUT);
      await positionToken.connect(depositor).cancelRedeemRequest();
      await usdg.mint(positionToken.target, depositedShares);
      await expect(
        positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, PRICE_SCALE)
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
      await positionToken.connect(backendOperator).fulfillRedeemRequest(0, depositor.address, PRICE_SCALE);
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

    it("reverts once listed", async function () {
      const { positionToken, creator } = await deployPositionTokenFixture({ listed: true });

      await expect(positionToken.connect(creator).requestClose()).to.be.revertedWith(
        "PositionToken: listed - exit via requestRedeem"
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
