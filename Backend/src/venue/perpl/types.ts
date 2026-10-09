/**
 * Perpl API shapes Laxu reads (types.md). Integers that are prices or sizes
 * are scaled by the market's price/size decimals; `Amount` strings are
 * collateral amounts (see units.parseApiAmount for the unit question).
 */

/// What every signed call and the trading socket need for one slot.
export interface PerplCredentials {
  /// The slot wallet: owner of the Perpl account.
  address: string;
  /// Exchange account id, decimal string. Null until createAccount ran.
  perplAccountId: string | null;
  /// Opaque `X-API-Key` token.
  apiKey: string;
  /// Ed25519 private key: 64-hex seed (with or without 0x) or PKCS#8 PEM.
  apiSecret: string;
}

export interface BlockTimestamp {
  b?: number;
  /// Milliseconds.
  t?: number;
}

/// History records carry the transaction too. `txid` comes WITHOUT a 0x
/// prefix on testnet (seen 2026-10-09); prefix it before building a link.
export interface BlockTxLogTimestamp extends BlockTimestamp {
  /// Transaction index in the block.
  tx?: number;
  txid?: string;
  /// Log index in the transaction.
  l?: number;
}

export interface ApiAccount {
  mt?: number;
  in: number;
  id: number;
  fr: boolean;
  /// Order forwarding enabled.
  fw: boolean;
  ft: number;
  /// Last forwarded request id.
  lfr: number;
  b: string;
  lb: string;
}

export interface ApiWallet {
  mt: number;
  sn?: number;
  at?: BlockTimestamp;
  addr: string;
  n: number;
  fl: number;
  as?: ApiAccount[];
}

export interface ApiOrder {
  at?: BlockTimestamp & { tx?: number; txid?: string; l?: number };
  rq: number;
  mkt: number;
  acc: number;
  oid: number;
  st: number;
  sr?: number;
  fr?: number;
  t: number;
  r?: boolean;
  p?: number;
  os?: number;
  /// Weighted-average fill price.
  fp?: number;
  /// Filled size (cumulative).
  fs?: number;
  /// Fee paid, Amount (gross: includes `bfa`).
  f?: string;
  /// Builder-fee portion of `f`; omitted or "0" when zero.
  bfa?: string;
  lv?: number;
}

/// `LiquiditySide` on a fill.
export const LiquiditySide = { Maker: 1, Taker: 2 } as const;

export interface ApiFill {
  at?: BlockTxLogTimestamp;
  mkt: number;
  acc: number;
  oid: number;
  /// Order type (1 OpenLong ... 4 CloseShort).
  t: number;
  /// LiquiditySide: 1 maker, 2 taker.
  l: number;
  p?: number;
  s: number;
  /// Fee, gross (protocol + `bfa`); negative = rebate. API Amount (CNS units).
  f: string;
  /// Builder-fee portion of `f`; omitted (or "0") when zero. Never add it to `f`.
  bfa?: string;
}

export interface ApiPosition {
  at?: BlockTxLogTimestamp;
  mkt: number;
  acc: number;
  pid: number;
  rq?: number;
  oid?: number;
  st: number;
  sr?: number;
  /// 1 = Long, 2 = Short.
  sd: number;
  c?: string;
  ep?: number;
  s?: number;
  fee?: string;
  /// Fee the close/decrease itself paid; included in `fee`.
  cfee?: string;
  lv?: number;
  /// Realized delta PnL of this event.
  dpnl?: string;
  /// Realized funding PnL of this event (positive = received).
  fnd?: string;
  xp?: number;
  ots?: BlockTimestamp;
  /// Settlement events (updates only).
  e?: ApiPosition[];
}

export interface ApiAccountEvent {
  at?: BlockTxLogTimestamp;
  in: number;
  id: number;
  et: number;
  m?: number;
  r?: number;
  o?: number;
  p?: number;
  a: string;
  b: string;
  lb: string;
  f: string;
  bfa?: string;
}

/// `AccountEventType` values Laxu reads.
export const AccountEventType = { Settlement: 4, Liquidation: 5, Funding: 8 } as const;

export interface HistoryPage<T> {
  d: T[];
  np?: string;
}

export interface ApiMarketConfig {
  is_open: boolean;
  price_decimals: number;
  size_decimals: number;
  min_posting_amount: string;
  min_settle_amount?: string;
  initial_margin: number;
  maintenance_margin: number;
  maker_fee?: number;
  taker_fee: number;
}

export interface ApiMarketState {
  at?: BlockTimestamp;
  orl?: number;
  mrk?: number;
  lst?: number;
  mid?: number;
  bid?: number;
  ask?: number;
  prv?: number;
}

/**
 * One funding interval's rate (types.md FundingEvent). `rate` is in micros
 * (10^-6) per funding interval -- checked on testnet: `ppl` = idx x rate / 10^6
 * for every market. Positive: longs pay shorts. `at` is when the rate APPLIES;
 * the newest event's `at.t` is an estimate until its block arrives, and the
 * same `feb` is then republished with the exact time.
 */
export interface ApiFundingEvent {
  at: BlockTimestamp;
  feb: number;
  rate: number;
  idx: number;
  ppl: number;
  sum: number;
  div: number;
}

export interface ApiFundingSeries {
  mt?: number;
  sn?: number;
  at?: BlockTimestamp;
  m: number;
  /// Oldest first.
  d: ApiFundingEvent[];
}

export interface ApiMarket {
  id: number;
  instance_id?: number;
  perpetual_id: number;
  symbol: string;
  name: string;
  icon?: string;
  order_ttl_blocks: number;
  order_max_market_slippage_bps: number;
  order_max_neg_pnl_collat_bps?: number;
  config: ApiMarketConfig;
  state?: ApiMarketState;
  funding_interval_sec?: number;
  funding?: ApiFundingEvent;
}

export interface ApiToken {
  id?: number;
  address?: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface ApiInstance {
  id: number;
  address: string;
  collateral_token_id: number;
  min_account_open_amount: string;
  min_deposit_amount: string;
  min_withdraw_amount: string;
}

export interface ApiContext {
  chain?: { chain_id: number };
  instances: ApiInstance[];
  tokens: ApiToken[];
  markets: ApiMarket[];
}

export interface ApiTicker {
  mt: number;
  sn?: number;
  d: Record<string, ApiMarketState | undefined>;
}

export interface ApiStatus {
  code: number;
  error?: string;
}

export interface BatchStatusResponse {
  mt?: number;
  cid?: number;
  status: ApiStatus;
  statuses?: ApiStatus[];
}

/// One order as the client describes it -- the body of an mt:22 frame.
export interface OrderSpec {
  rq: number;
  mkt: number;
  acc: number;
  oid?: number;
  t: number;
  p?: number;
  s: number;
  a?: string;
  ms?: number;
  mnp?: number;
  fl: number;
  lv: number;
  lb: number;
  /// Builder fee, hundred-thousandths (1 = 0.1 bps). Only on a builder-bound
  /// key and <= its enrolled ceiling; see builder.ts.
  bf?: number;
}
