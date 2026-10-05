const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Default test venue: one Perpl-style perp with priceDecimals 2 / lotDecimals 6, so the suites'
// existing 1e18 prices and sizes convert exactly.
const PERP_ID = 32n;
const PRICE_DECIMALS = 2n;
const LOT_DECIMALS = 6n;
const ACCOUNT_ID = 7n;
const STATUS_LIVE = 4; // Perpl: 0 = Paused, anything else is not paused

/// 1e18 price -> Perpl PNS. Throws unless exact, so a test can't silently round.
function toPNS(price, priceDecimals = PRICE_DECIMALS) {
  const div = 10n ** (18n - priceDecimals);
  if (price % div !== 0n) throw new Error(`price ${price} not representable at ${priceDecimals} decimals`);
  return price / div;
}

/// Laxu size (qty x 10^sizeDecimals) -> Perpl LNS. Throws unless exact.
function toLNS(size, lotDecimals = LOT_DECIMALS, sizeDecimals = 18n) {
  const num = size * 10n ** lotDecimals;
  const den = 10n ** sizeDecimals;
  if (num % den !== 0n) throw new Error(`size ${size} not representable at ${lotDecimals} lot decimals`);
  return num / den;
}

/**
 * Deploys MockPerplExchange + PerplReader, maps `market` to PERP_ID with the mark at `markPrice`,
 * and (unless `position: null`) opens the matching venue position for ACCOUNT_ID.
 * `sizeDecimals` is the collateral's decimals as the reader sees them (Laxu size scale).
 */
async function deployVenue({
  market,
  markPrice,
  sizeDecimals = 18n,
  refPriceMaxAgeSec = 0n,
  position, // { direction, entryPrice, size } or null
} = {}) {
  const exchange = await (await ethers.getContractFactory("MockPerplExchange")).deploy();
  await exchange.setExchangeInfo(sizeDecimals, ethers.ZeroAddress);
  const reader = await (await ethers.getContractFactory("PerplReader")).deploy(exchange.target);

  await exchange.setPerp(
    PERP_ID, PRICE_DECIMALS, LOT_DECIMALS, toPNS(markPrice), await time.latest(), refPriceMaxAgeSec, STATUS_LIVE
  );
  await reader.setMarket(market, PERP_ID);

  if (position) {
    await exchange.setPosition(
      PERP_ID, ACCOUNT_ID, position.direction, toPNS(position.entryPrice),
      toLNS(position.size, LOT_DECIMALS, sizeDecimals), 0n, 0n
    );
  }
  return { exchange, reader, accountId: ACCOUNT_ID, perpId: PERP_ID };
}

async function exchangeOf(positionToken) {
  const reader = await ethers.getContractAt("PerplReader", await positionToken.venueReader());
  const exchange = await ethers.getContractAt("MockPerplExchange", await reader.exchange());
  const perpId = await reader.perpIdOf(await positionToken.market());
  return { reader, exchange, perpId };
}

/// Moves the venue mark (stamped "now"). No operator transaction involved.
async function setMark(positionToken, markPrice, { status = STATUS_LIVE, timestamp, refPriceMaxAgeSec = 0n } = {}) {
  const { exchange, perpId } = await exchangeOf(positionToken);
  const ts = timestamp ?? BigInt(await time.latest());
  await exchange.setPerp(perpId, PRICE_DECIMALS, LOT_DECIMALS, toPNS(markPrice), ts, refPriceMaxAgeSec, status);
}

/// The old `applyReport` path, split the new way: the venue mark moves on its own, and the
/// operator reports funding via applyFunding. Returns the applyFunding transaction.
async function report(positionToken, operator, markPrice, funding = 0n) {
  await setMark(positionToken, markPrice);
  const last = await positionToken.lastFundingTimestamp();
  const now = BigInt(await time.latest()) + 1n;
  const ts = now > last ? now : last + 1n;
  return positionToken.connect(operator).applyFunding(funding, ts);
}

module.exports = {
  PERP_ID, PRICE_DECIMALS, LOT_DECIMALS, ACCOUNT_ID, STATUS_LIVE,
  toPNS, toLNS, deployVenue, exchangeOf, setMark, report,
};
