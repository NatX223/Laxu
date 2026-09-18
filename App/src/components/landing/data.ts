/**
 * Content + per-card visual constants, transcribed from `Laxu Landing.dc.html`.
 * The orbit is 7 cards on a circle: the angle step is 360/7 = 51.43deg, starting at -90.
 */

export const COPY = {
  navCtaLabel: "Open app",
  ctaLabel: "Tokenize a position",
  secondaryCtaLabel: "Read the docs",
  showCtaStats: true,
  showChainCredit: true,
  faqMultiOpen: false,
  spin: true,
  slideThreshold: 0.85,
} as const;

export type PositionCard = {
  title: string;
  status: "OPEN" | "AT RISK";
  statusInk: string;
  statusBg: string;
  headerBg: string;
  markBg: string;
  markRadius: string;
  entry: string;
  mark: string;
  size: string;
  unrealized: string;
  unrealizedInk: string;
  /** track fill behind the slider knob */
  fill: string;
  /** position on the orbit circle */
  angle: number;
  radius: number;
  /** static 3D tilt baked into each card */
  tilt: string;
  shadow: string;
};

export const POSITION_CARDS: PositionCard[] = [
  {
    title: "ETH long, 5×",
    status: "OPEN",
    statusInk: "#5b2fd6",
    statusBg: "#fdfbf7",
    headerBg: "rgba(91,47,214,0.94)",
    markBg: "#ff8a3d",
    markRadius: "50% 50% 50% 4px",
    entry: "$4,182.50",
    mark: "$4,943.80",
    size: "12.4 ETH",
    unrealized: "+18.2%",
    unrealizedInk: "#0b7a55",
    fill: "rgba(91,47,214,0.16)",
    angle: -90,
    radius: 425,
    tilt: "perspective(1200px) rotateX(5deg) rotateY(11deg) rotateZ(-4.5deg) scale(1.06)",
    shadow: "0 30px 60px rgba(26,23,20,0.22)",
  },
  {
    title: "BTC long, 3×",
    status: "OPEN",
    statusInk: "#3b3fc4",
    statusBg: "#fdfbf7",
    headerBg: "rgba(59,63,196,0.94)",
    markBg: "#ff8a3d",
    markRadius: "4px 50% 50% 50%",
    entry: "$94,210",
    mark: "$99,845",
    size: "0.84 BTC",
    unrealized: "+17.9%",
    unrealizedInk: "#0b7a55",
    fill: "rgba(59,63,196,0.16)",
    angle: -38.57,
    radius: 440,
    tilt: "perspective(1200px) rotateX(7deg) rotateY(-12deg) rotateZ(4deg) scale(0.96)",
    shadow: "0 16px 36px rgba(26,23,20,0.14)",
  },
  {
    title: "NVDA short, 8×",
    status: "OPEN",
    statusInk: "#34680a",
    statusBg: "#fdfbf7",
    headerBg: "rgba(52,104,10,0.95)",
    markBg: "#ff8a3d",
    markRadius: "50% 4px 50% 50%",
    entry: "$214.60",
    mark: "$198.30",
    size: "420 NVDA",
    unrealized: "+60.7%",
    unrealizedInk: "#0b7a55",
    fill: "rgba(52,104,10,0.16)",
    angle: 12.86,
    radius: 420,
    tilt: "perspective(1200px) rotateX(4deg) rotateY(9deg) rotateZ(3deg) scale(1)",
    shadow: "0 22px 48px rgba(26,23,20,0.17)",
  },
  {
    title: "ARB long, 10×",
    status: "AT RISK",
    statusInk: "#fdfbf7",
    statusBg: "#a3321c",
    headerBg: "rgba(16,96,110,0.94)",
    markBg: "#ff8a3d",
    markRadius: "50% 50% 4px 50%",
    entry: "$0.8420",
    mark: "$0.7910",
    size: "38,000 ARB",
    unrealized: "−60.6%",
    unrealizedInk: "#a3321c",
    fill: "rgba(16,96,110,0.16)",
    angle: 64.29,
    radius: 445,
    tilt: "perspective(1200px) rotateX(8deg) rotateY(-14deg) rotateZ(-5.5deg) scale(0.92)",
    shadow: "0 12px 28px rgba(26,23,20,0.12)",
  },
  {
    title: "LINK short, 4×",
    status: "OPEN",
    statusInk: "#0b7a55",
    statusBg: "#fdfbf7",
    headerBg: "rgba(11,122,85,0.94)",
    markBg: "#ff8a3d",
    markRadius: "50% 50% 50% 50% / 4px 50% 50% 50%",
    entry: "$24.80",
    mark: "$23.15",
    size: "1,150 LINK",
    unrealized: "+26.6%",
    unrealizedInk: "#0b7a55",
    fill: "rgba(11,122,85,0.18)",
    angle: 115.71,
    radius: 452,
    tilt: "perspective(1200px) rotateX(3deg) rotateY(12deg) rotateZ(4.5deg) scale(1.08)",
    shadow: "0 34px 70px rgba(26,23,20,0.24)",
  },
  {
    title: "TSLA long, 20×",
    status: "AT RISK",
    statusInk: "#fdfbf7",
    statusBg: "#7d2313",
    headerBg: "rgba(163,50,28,0.95)",
    markBg: "#ffb37d",
    markRadius: "50% 50% 50% 50% / 50% 4px 50% 50%",
    entry: "$438.20",
    mark: "$427.50",
    size: "1,250 TSLA",
    unrealized: "−48.9%",
    unrealizedInk: "#a3321c",
    fill: "rgba(163,50,28,0.16)",
    angle: 167.14,
    radius: 438,
    tilt: "perspective(1200px) rotateX(6deg) rotateY(-10deg) rotateZ(-3deg) scale(0.98)",
    shadow: "0 18px 42px rgba(26,23,20,0.15)",
  },
  {
    title: "HOOD short, 6×",
    status: "OPEN",
    statusInk: "#1a1714",
    statusBg: "#fdfbf7",
    headerBg: "rgba(26,23,20,0.95)",
    markBg: "#c8f04a",
    markRadius: "50% 50% 50% 50% / 50% 50% 4px 50%",
    entry: "$118.40",
    mark: "$110.35",
    size: "640 HOOD",
    unrealized: "+40.8%",
    unrealizedInk: "#0b7a55",
    fill: "rgba(26,23,20,0.12)",
    angle: 218.57,
    radius: 428,
    tilt: "perspective(1200px) rotateX(4deg) rotateY(10deg) rotateZ(2.8deg) scale(1.03)",
    shadow: "0 26px 56px rgba(26,23,20,0.2)",
  },
];

export const FLOWS = [
  {
    eyebrow: "01 · BORROW",
    eyebrowInk: "#5b2fd6",
    title: "Borrow against it",
    body: "Deposit the position token as collateral and draw USDG without touching the trade. Every position gets its own isolated pool, so a blow-up on one market never leaks bad debt into anyone else's.",
    src: "/laxu/flow-borrow.png",
    alt: "Borrow flow — collateral deposit screen",
  },
  {
    eyebrow: "02 · TRADE",
    eyebrowInk: "#7d3d12",
    title: "Sell the whole thing",
    body: "A position that used to be locked to your account is now an ERC-20 anyone can hold. Hand the entry, size and leverage to another trader instead of unwinding it into the book at market.",
    src: "/laxu/flow-trade.png",
    alt: "Trade flow — position listed for sale",
  },
  {
    eyebrow: "03 · SHARE",
    eyebrowInk: "#075c40",
    title: "Let others buy in",
    body: "Others mint shares of your open position through a standard ERC-4626 deposit and ride the same entry. You keep your stake and earn a fee every time someone joins.",
    src: "/laxu/flow-share.png",
    alt: "Share flow — equity buy-in split",
  },
];

export const ASSET_CLASSES = [
  {
    pill: "STOCKS",
    title: "Stocks",
    badge: "EQUITIES",
    badgeBg: "#5b2fd6",
    glow: "radial-gradient(64% 64% at 50% 50%, rgba(91,47,214,0.16) 0%, rgba(255,255,255,0) 72%)",
    dropShadow: "drop-shadow(0 22px 30px rgba(46,18,112,0.26))",
    src: "/laxu/asset-stocks.png",
    alt: "Stocks",
    body: "Leveraged exposure to TSLA, NVDA, HOOD and the rest of the tokenized equity book — minted as a position you can lend against overnight.",
    tags: ["TSLA", "NVDA", "HOOD", "+42 MORE"],
  },
  {
    pill: "CRYPTO",
    title: "Crypto",
    badge: "PERPS",
    badgeBg: "#a3521a",
    glow: "radial-gradient(64% 64% at 50% 50%, rgba(255,138,61,0.2) 0%, rgba(255,255,255,0) 72%)",
    dropShadow: "drop-shadow(0 22px 30px rgba(125,61,18,0.24))",
    src: "/laxu/asset-crypto.png",
    alt: "Crypto",
    body: "The majors and the long tail — ETH, BTC, SOL, ARB. Deep perp liquidity, up to 20× leverage, every position its own transferable ERC-20.",
    tags: ["ETH", "BTC", "ARB", "+80 MORE"],
  },
  {
    pill: "PTOKENS",
    title: "pTokens",
    badge: "POOLED",
    badgeBg: "#0b7a55",
    glow: "radial-gradient(64% 64% at 50% 50%, rgba(15,155,108,0.18) 0%, rgba(255,255,255,0) 72%)",
    dropShadow: "drop-shadow(0 22px 30px rgba(7,61,43,0.24))",
    src: "/laxu/asset-ptokens.png",
    alt: "pTokens",
    body: "Arcus's own pooled tokens sit alongside your individual ones. Hold the pool for broad exposure, or mint a single position when you want your own entry.",
    tags: ["SHARED POOL", "ARCUS NATIVE"],
  },
];

export const FAQS = [
  {
    q: "Do I still control the trade after I tokenize it?",
    a: "You hold the token and the token holds the position. Closing, adding margin, or taking profit all still route through Arcus — but whoever holds the token is the one who can do it. Transfer the token and you transfer the trade.",
  },
  {
    q: "What happens to lenders if the position gets liquidated?",
    a: "Every tokenized position borrows from its own isolated pool. Arcus liquidates the underlying, the pool is repaid first out of remaining equity, and the token settles to whatever is left. A bad market on one position can never socialise losses onto other pools.",
  },
  {
    q: "Does Laxu run its own matching engine?",
    a: "No. Execution, pricing, funding and liquidations are Arcus's perps API. Laxu is the ownership layer on top: minting the position into a token, running the isolated lending pools, and handling buy-ins.",
  },
  {
    q: "Who sets the price when I sell a position?",
    a: "You do, by accepting an offer. Buyers bid against the position's live equity on Arcus, so a trade with a good entry can change hands above its mark — and a losing one usually clears below. Nothing settles until you accept.",
  },
  {
    q: "What exactly do buy-in participants own?",
    a: "ERC-4626 shares of your open position. They take pro-rata P&L from the block they mint in — not your earlier gains — and can redeem out at any time. You keep your original stake and collect a fee on every mint.",
  },
  {
    q: "What does it cost?",
    a: "Minting is gas on Robinhood Chain. Arcus's own funding and trading fees are unchanged. Laxu takes a cut of buy-in mints and nothing on borrowing beyond the pool's interest rate, which the pool's own utilisation sets.",
  },
];

export const CTA_STATS = [
  "NON-CUSTODIAL",
  "ERC-20 · ERC-4626",
  "EXECUTION BY ARCUS",
  "ROBINHOOD CHAIN",
];

export const FOOTER_LINKS = [
  { heading: "PRODUCT", links: ["Tokenize", "Borrow", "Marketplace", "Buy-ins", "Markets"] },
  { heading: "DEVELOPERS", links: ["Docs", "Contracts", "Audits", "Arcus API", "Status"] },
  { heading: "COMPANY", links: ["About", "Blog", "Careers", "X / Twitter", "Discord"] },
];
