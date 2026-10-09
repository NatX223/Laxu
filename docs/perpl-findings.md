# Perpl testnet findings (Spec 03 Phase 2)

Raw probe log: every `npm run probe` run appends a section below. Frame evidence is
`Backend/fixtures/perpl/recordings/<file>#L<line>` (redacted JSONL, one frame per line).


## Summary — every VERIFY(spec03), answered (2026-10-05, Monad testnet)

Probed with `npm run probe` (Backend/scripts/probe.ts) on slots 1 (account 824) and 2 (account 841),
ETH market (perp 32), $5–$20 deposits at 2x, plus two ad-hoc experiments. Raw sections follow below,
newest last. Frame citations point into `Backend/fixtures/perpl/recordings/*.jsonl` (redacted).
Phase 3 comments cite the anchors in the first column.

| Anchor | VERIFY | Answer | Phase 3 action | Evidence (section below) |
|---|---|---|---|---|
| <a id="v-units-75"></a>`v-units-75` | units.ts:75 — API `Amount` format | **CNS base-unit integer string.** `min_account_open_amount` "100000000" == `getMinAccountOpenCNS()` 100000000. `collateralDecimals` = 6 = AUSD `decimals()`, so the minimum account open is **100 AUSD** (the docs' "10.0" example is not testnet). Wallet `b`/`lb`, fees `f`, position `c` are all CNS integers. | Keep `parseApiAmount`'s integer branch; the decimal branch is unused. | context; slot; open |
| <a id="v-units-171"></a>`v-units-171` | units.ts:171 — margin scale | **Contradicts the design.** `initial_margin` / `maintenance_margin` (= on-chain `getMarginFractions` "Hdths") are **max leverage in hundredths**: ETH 1200 = 12x (8.33% IM), maint 2000 = 20x (5%, the docs' "2000 = 5%"). Proof: `lv` 1000 (10x) fills at 10x — impossible under the 1e4-fraction reading (8.33x max) — and `lv` 1300/1500/2000/5000 are all **accepted and silently clamped to 1200**. Laxu's `floor(10000 / initial_margin)` is wrong both ways: ETH 8 (true 12), BTC 6 (15), **MON / ZEC / LIT / NEAR 20 (true 3)**, **PUMP 20 (true 5)**; SOL 10 is right by coincidence. An order above the true max is clamped, so it needs more margin than Laxu deposited. | `maxLeverage = min(20, floor(initial_margin / 100))`; fractions = `100 / value`; re-sync markets. | markets; Experiment: leverage limit |
| <a id="v-adapter-98"></a>`v-adapter-98` | adapter.ts:98 — `balanceCNS` vs position deposits | **Confirmed.** API wallet `b`/`lb` == on-chain `balanceCNS`/`lockedBalanceCNS`. Opening moved exactly `depositCNS` + fee out of `balanceCNS` (drop 18822469 = 18809490 + 12979); `lockedBalanceCNS` stayed 0 throughout (IOC only). | None (delete the VERIFY). | slot; open |
| <a id="v-tradingws-471"></a>`v-tradingws-471` | tradingWs.ts:471 — heartbeat seed | **Confirmed.** First `mt:100` `sn` = `mt:19` `sn` + 1, then +1 per beat; `sn` == `h` == block number. No gap in 609 recorded heartbeats across 9 connections. | Keep the gap check; default `PERPL_HEARTBEAT_GAP_RECONNECT=true`. | heartbeat |
| <a id="v-tradingws-63"></a>`v-tradingws-63` | tradingWs.ts:63 — IOC status sequence | All 19 IOCs that executed produced **one** `mt:24` straight to `st:4` (Filled, `sr:43`), ~1.0–1.5 s after send, no Open/PartiallyFilled first. **But 3 of 22 acked (`code:0`) IOCs never executed**: rq 1 and rq 3 vanished silently (no `mt:24`, never in order-history, `lb` passed — not caused by `lb`; looks like testnet forwarder loss), and rq 13's socket was closed by the server 3 s after its ack. | Keep "wait for terminal"; the lookup path must cover silent loss (see `v-adapter-216`). | open; Experiment: silently dropped IOC orders |
| <a id="v-adapter-216"></a>`v-adapter-216` | adapter.ts:216 — order-history latency | **Contradicts the design.** History showed the rq **27.3 s** and **22.7 s** after send (WS outcome at ~1.3 s); `count=100` once timed out at 15 s. `findOrderOutcome` says `not_placed` as soon as head ≥ `lb` (`lb` = head + 20 blocks ≈ 6 s) and history is empty — so an order that **filled** while its WS frames were lost (e.g. the 1008 close below) would be declared `not_placed` and **re-sent under a new rq: a double order**. (In the one real case, rq 13, `not_placed` happened to be right: lots 14 → 21 = one 7-lot fill.) | `not_placed` only once history is known to cover blocks ≥ `lb` (or ≥ 60 s after `lb`) **and** the on-chain position shows no fill; use `count=20` pages. | open; increase |
| <a id="v-adapter-277"></a>`v-adapter-277` | adapter.ts:277 — does `pnlCNS` include premium? | **Yes.** After a funding event: `pnlCNS` 103880 = `deltaPnlCNS` 104580 + `premiumPnlCNS` −700. Venue equity = **`depositCNS + pnlCNS`** (= `PerplReader.venueEquity`, already right). The backend's `deposit + pnl + premium` counts funding twice (here 700 CNS on a $37.72 position = 0.002% — under the 1% stop condition, but it grows with funding). API `c` + unrealized omits accrued funding. Before funding, all three sums matched exactly in 3 samples over 10 min. | `equityAsset = deposit + pnl`; drop `premiumAsset` from the sum. | equity (16:40 and 17:07) |
| <a id="v-adapter-185"></a>`v-adapter-185` | adapter.ts:185 — unit of `a` on t:6 | **CNS integer string**: `a: "5000000"` moved `depositCNS` by exactly 5000000 ($5). The human-decimal form was not needed. | Keep `assetToApiAmount`. | add-margin |
| <a id="v-adapter-334"></a>`v-adapter-334` | adapter.ts:334 — t:6 status | **Contradicts the design.** A **successful** t:6 sends **no** success `mt:24`: the collateral lands (block 68451787: `mt:27` event `sr:6` c +5000000, `mt:21` `et:3` a −5000000, both `rq: 0`), and the only `mt:24` for the rq, 6 blocks later, is **`st:7 / sr:32`** (OrderDescIdTooLow). The adapter's "instant" rule would report it `failed` → a retry doubles the margin. | Confirm t:6 by the on-chain `depositCNS` delta (wait for it), never by `mt:24`; treat `sr:32` on a t:6 as "maybe applied" until that check. | add-margin + its note |
| <a id="v-phase-b"></a>`v-phase-b` | Spec 01 Phase B — premium reset on increase | **Confirmed**: `premiumPnlCNS` −700 → 0 when 7 lots were added to 14 (entry re-averaged 268707 → 268977). | None. | increase |
| <a id="v-close"></a>`v-close` | close / withdraw | IOC close: one `st:4` frame; `depositCNS` → 0. Withdrawals of 9,899.99 and 9,955.05 AUSD each succeeded first try, leaving exactly the 100 AUSD reserve; the exchange-wide allowance was 1.6M–4.5M AUSD (+750 AUSD/block) — not binding. `getWithdrawAllowanceData(block)` returns real data only when `block == lastAllowanceBlock`; a few blocks later it returns all zeros (informational — the backend does not use it). | None. | close --slot 2; close --slot 1 |

### Further findings the design must absorb

1. <a id="f-remargin"></a>**Every size change re-margins the whole position to the new order's `lv`** (slot 2: a 12x add after a 10x open left `c` = 2 lots' notional / 12; slot 1: the `increase` set `depositCNS` = 21 lots' notional / 2, releasing the earlier +$5 t:6 margin back to the balance). Buy-ins/redeems must send the position's own `lv`, and margin added with t:6 does not survive the next size change.
2. <a id="f-fee"></a>**Taker fee** `taker_fee: 345` is micros (0.0345%), as `feeMicrosToPpm` assumes; on-chain `getTakerFee` also returns 345 despite the "Per100K" name.
3. <a id="f-1008"></a>**Unexplained socket close**: the server closed one trading socket with `1008 "ping timeout"` 6 s after sign-in (our app ping is every 30 s; other sockets lived 30–60 s fine). The recovery path handled it. Watch it in the Phase 6 soak.
4. <a id="f-neon"></a>**Neon direct host cold starts**: the first connection after idle failed ("Can't reach database server") three times today; the backend needs a retry on boot / first query.
5. <a id="f-slot-balance"></a>**Slot balances**: both Perpl accounts held ~10,000 AUSD before the probes (not from provisioning). Settlement treats `balance − reserve` as recovered user money, so this would have been paid to holders. Per the user's decision both were withdrawn and swept to the float; both now sit at exactly the 100 AUSD reserve. Provisioning/reconciler should alert on `balance > reserve` for a `free` slot.

### Equity stop condition (§2.4)
Not triggered: the backend formula is off by `premiumPnlCNS` only (0.002% of position value here), and the cause is explained (double-counted funding). The design contradictions above (`v-units-171`, `v-adapter-216`, `v-adapter-334`, `f-remargin`) are the reason to stop and review before Phase 3.

---

# Raw probe log

## context — 2026-10-05T16:17:16.045Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| — | Collateral token and decimals | 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC (AUSD); getExchangeInfo().collateralDecimals = 6; token decimals() = 6; matches ASSET_ADDRESS | eth_call getExchangeInfo / decimals() on 0x1964C32f0bE608E7D29302AFF5E61268E72080cc; Backend/fixtures/perpl/context.testnet.json |
| units.ts:75 | API `Amount` format (CNS integer vs human decimal) | CNS base-unit integer string: min_account_open_amount "100000000" == getMinAccountOpenCNS() 100000000 (= 100 AUSD at 6 dp) | Backend/fixtures/perpl/context.testnet.json instances[0].min_account_open_amount; eth_call getMinAccountOpenCNS() |

<details><summary>raw result</summary>

```json
{
  "collateralToken": "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
  "configuredAsset": "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
  "collateralDecimals": 6,
  "tokenDecimals": 6,
  "apiToken": {
    "ver": 270,
    "id": 1,
    "address": "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
    "symbol": "AUSD",
    "name": "AUSD",
    "decimals": 6,
    "display_precision": 2,
    "usd_index": "<index_name>"
  },
  "instance": {
    "ver": 270,
    "id": 12,
    "address": "0x1964c32f0be608e7d29302aff5e61268e72080cc",
    "collateral_token_id": 1,
    "min_account_open_amount": "100000000",
    "min_deposit_amount": "10000000",
    "min_withdraw_amount": "10000",
    "max_account_trigger_orders": 16
  },
  "min_account_open_amount_raw": "100000000",
  "getMinAccountOpenCNS": "100000000",
  "minAccountOpenHuman": "100"
}
```

</details>

## slot --slot 1 — 2026-10-05T16:17:33.155Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| adapter.ts:98 (1/2) | API wallet `b`/`lb` vs on-chain balanceCNS / lockedBalanceCNS | API b="10000000000" lb="0" fw=true lfr=0; chain balanceCNS=10000000000 lockedBalanceCNS=0; identical (CNS integers) | GET /v1/trading/wallet (rest-*.jsonl); eth_call getAccountByAddr(0x27faec53e9fdae9e4fac0af5cc4731e77ae8e503) |

<details><summary>raw result</summary>

```json
{
  "slot": 1,
  "accountId": "824",
  "api": {
    "sn": 68446864,
    "b": "10000000000",
    "lb": "0",
    "fw": true,
    "lfr": 0,
    "id": 824
  },
  "chain": {
    "accountId": "824",
    "balanceCNS": "10000000000",
    "lockedBalanceCNS": "0",
    "frozen": 0
  },
  "reserveAsset": "100000000",
  "scale": {
    "cnsDecimals": 6,
    "assetDecimals": 6
  }
}
```

</details>

## markets — 2026-10-05T16:17:59.375Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| units.ts:171 | ETH: scale of initial_margin / maintenance_margin | API initial_margin=1200, maintenance_margin=2000; chain getMarginFractions: init=1200, maint=2000 (Hdths), dynamicInit=1200; getPerpetualInfo marginTol=100 (decimals 9). Perpl UI max leverage: (fill in from UI) | /v1/pub/context markets[32].config; eth_call getMarginFractions(32,0), getPerpetualInfo(32) |
| units.ts:171 | BTC: scale of initial_margin / maintenance_margin | API initial_margin=1500, maintenance_margin=2500; chain getMarginFractions: init=1500, maint=2500 (Hdths), dynamicInit=1500; getPerpetualInfo marginTol=100 (decimals 9). Perpl UI max leverage: (fill in from UI) | /v1/pub/context markets[16].config; eth_call getMarginFractions(16,0), getPerpetualInfo(16) |

<details><summary>raw result</summary>

```json
{
  "ETH": {
    "api": {
      "initial_margin": 1200,
      "maintenance_margin": 2000,
      "taker_fee": 345,
      "maker_fee": 45,
      "min_posting_amount": "0"
    },
    "chain": {
      "getMarginFractions": {
        "perpInitMarginFracHdths": "1200",
        "perpMaintMarginFracHdths": "2000",
        "dynamicInitMarginFracHdths": "1200",
        "oiMaxLNS": "1000000000"
      },
      "getPerpetualInfo": {
        "marginTol": "100",
        "marginTolDecimals": "9",
        "priceDecimals": "2",
        "lotDecimals": "3"
      },
      "getTakerFee": "345"
    },
    "laxuMaxLeverage": 8
  },
  "BTC": {
    "api": {
      "initial_margin": 1500,
      "maintenance_margin": 2500,
      "taker_fee": 345,
      "maker_fee": 45,
      "min_posting_amount": "0"
    },
    "chain": {
      "getMarginFractions": {
        "perpInitMarginFracHdths": "1500",
        "perpMaintMarginFracHdths": "2500",
        "dynamicInitMarginFracHdths": "1500",
        "oiMaxLNS": "100000000000"
      },
      "getPerpetualInfo": {
        "marginTol": "100",
        "marginTolDecimals": "9",
        "priceDecimals": "1",
        "lotDecimals": "5"
      },
      "getTakerFee": "345"
    },
    "laxuMaxLeverage": 6
  }
}
```

</details>

## heartbeat --slot 1 — 2026-10-05T16:18:32.058Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| tradingWs.ts:471 | Is the first mt:100 `sn` == mt:19 `sn` + 1, and do heartbeats step by 1? | mt:19 sn=68447054; first mt:100 sn=68447055, 68447056, 68447057, 68447058, 68447059; first == snapshot+1: true; consecutive: true; heads h=68447055, 68447056, 68447057, 68447058, 68447059 | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L2-L9 |

<details><summary>raw result</summary>

```json
{
  "snapshotSn": 68447054,
  "beatSns": [
    68447055,
    68447056,
    68447057,
    68447058,
    68447059
  ],
  "beatHeads": [
    68447055,
    68447056,
    68447057,
    68447058,
    68447059
  ],
  "beatTimes": [
    "2026-10-05T16:18:30.777Z",
    "2026-10-05T16:18:31.057Z",
    "2026-10-05T16:18:31.331Z",
    "2026-10-05T16:18:31.774Z",
    "2026-10-05T16:18:31.923Z"
  ],
  "consecutive": true,
  "seededFromSnapshot": true
}
```

</details>

## open --slot 1 --usd 20 --lev 2 — 2026-10-05T16:28:27.563Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| tradingWs.ts:63 | IOC status sequence for one rq (does it always end Filled/Canceled/Expired? Open/PartiallyFilled first?) | rq 11: st4/sr43 fs=14 (L335); outcome=filled, filled 14000 size6 of 14000 @ 2687070000000000000000 | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L327-L335 |
| adapter.ts:216 / findOrderOutcome | Attempts (an expired IOC is looked up, then retried with a new rq) | rq 11 (lb 68448939): ws:filled, lookups 0, frames Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L327-L337 | order-history lookups in rest-*.jsonl |
| adapter.ts:216 | Latency until order-history shows the rq (250 ms polling) | 27319 ms after send (WS outcome at 1330 ms; 36 polls); history statuses: st4 | GET /v1/trading/order-history (rest-*.jsonl) |
| adapter.ts:98 (2/2) | Do position deposits leave balanceCNS? | balanceCNS 10020007056 → 10040007056 (after deposit) → 10021184587 (after fill): dropped 18822469; position depositCNS=18809490, pnlCNS=-8540, premiumPnlCNS=0; lockedBalanceCNS=0 | deposit [0x85162c10…](https://testnet.monadvision.com/tx/0x85162c10b80b9aa6ca0e9e5f2ed0a21299b00ddd29d44119421755b775a8bd77); eth_call getAccountByAddr / getPosition before & after |

<details><summary>raw result</summary>

```json
{
  "file": "C:\\Users\\ADMIN\\Documents\\Hackathons\\Laxu\\Backend\\fixtures\\perpl\\recordings\\cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl",
  "amount": "20000000",
  "fundTx": "0xf64d536a133c89318a50b8c205d4a86b5a3cbecf23f095a1fdf47b009ad42c63",
  "depositTx": "0x85162c10b80b9aa6ca0e9e5f2ed0a21299b00ddd29d44119421755b775a8bd77",
  "accountBefore": {
    "accountId": "824",
    "balanceCNS": "10020007056",
    "lockedBalanceCNS": "0",
    "frozen": 0
  },
  "accountAfterDeposit": {
    "accountId": "824",
    "balanceCNS": "10040007056",
    "lockedBalanceCNS": "0",
    "frozen": 0
  },
  "positionBefore": {
    "accountId": "824",
    "positionType": 0,
    "depositCNS": "0",
    "pricePNS": "0",
    "lotLNS": "0",
    "entryBlock": "0",
    "pnlCNS": "0",
    "deltaPnlCNS": "0",
    "premiumPnlCNS": "0",
    "markPricePNS": "268780",
    "markPriceValid": true
  },
  "positionAfter": {
    "accountId": "824",
    "positionType": 0,
    "depositCNS": "18809490",
    "pricePNS": "268707",
    "lotLNS": "14",
    "entryBlock": "68448927",
    "pnlCNS": "-8540",
    "deltaPnlCNS": "-8540",
    "premiumPnlCNS": "0",
    "markPricePNS": "268646",
    "markPriceValid": true
  },
  "accountAfter": {
    "accountId": "824",
    "balanceCNS": "10021184587",
    "lockedBalanceCNS": "0",
    "frozen": 0
  },
  "request": {
    "requestId": "11",
    "lastExecBlock": "68448939"
  },
  "attempts": [
    {
      "rq": "11",
      "lb": "68448939",
      "sentAt": 1791217675091,
      "result": "ws:filled",
      "lookups": 0
    }
  ],
  "lots": "14",
  "size6": "14000",
  "mark18": "2687800000000000000000",
  "outcome": {
    "requestId": "11",
    "orderId": "4485868879872",
    "filledSize6": "14000",
    "avgPrice18": "2687070000000000000000",
    "feeAsset": "12979",
    "reason": "TakerOrderFilled",
    "status": "filled"
  },
  "wsOutcomeMs": 1330,
  "history": {
    "found": true,
    "latencyMs": 27319,
    "polls": 36,
    "entries": [
      {
        "at": {
          "b": 68448927,
          "t": 1791217675000,
          "tx": 4,
          "txid": "28d348c4784bd8bd57901d5d96a8cc5b067b24c7083327430b05274f9a3c6434",
          "l": 4
        },
        "c": {},
        "rq": 11,
        "mkt": 32,
        "acc": 824,
        "oid": 4485868879872,
        "scid": 0,
        "st": 4,
        "sr": 43,
        "t": 1,
        "os": 14,
        "fp": 268707,
        "fs": 14,
        "f": "12979",
        "bfa": "0",
        "fl": 4,
        "mm": 10,
        "lv": 200,
        "mnp": 1000
      }
    ]
  },
  "frames": [
    {
      "line": 327,
      "dir": "out",
      "mt": 22
    },
    {
      "line": 329,
      "dir": "in",
      "mt": 3
    },
    {
      "line": 335,
      "dir": "in",
      "mt": 24
    }
  ],
  "events": [
    {
      "line": 335,
      "mt": 24,
      "st": 4,
      "sr": 43,
      "fs": 14,
      "fp": 268707,
      "os": 14,
      "f": "12979"
    }
  ]
}
```

</details>

## Experiment: silently dropped IOC orders vs `lb` (slot 1) — 2026-10-05T16:20–16:27Z

Ad-hoc diagnostic (one-off script, same `PerplTradingConnection.sendOrder` path), run after the first `open` probe died with `OrderOutcomeUnknownError`.

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| tradingWs.ts:63 / adapter.ts:216 | Can an order acked `code:0` vanish? | **Yes.** rq 1 (open, lb = head+~18) and rq 3 (close, lb = head+~18) were each acked `mt:3 code:0`, then **no `mt:24` ever arrived**, order-history never listed them, and heartbeats kept flowing past `lb` (so per the docs: not placed). | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L20-L22 (rq 1), Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L151-L153 (rq 3) |
| — | Is `lb = head + order_ttl_blocks` the cause? | **No.** Six 1-lot IOCs with lb = head+20, +19, +15, +10, +5 and lb=0 **all** filled (`st:4 sr:43`), each ~5 blocks after head, ~1.0–1.5 s after send. rq 2 (lb 0) also filled in 1.27 s. The two drops look like intermittent testnet forwarder losses — the case the backend's lookup → `not_placed` → new-rq path exists for. | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L134-L141 (rq 2), Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L197-L281 (rq 4–9), Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L300-L310 (close, rq 10) |
| — | Taker fee unit | `taker_fee: 345` is **micros** (0.0345%), as `feeMicrosToPpm` assumes: rq 2 fee `f`=12962 CNS on 14 lots × $2683.61 = $37.57 → 0.0345%. (On-chain `getTakerFee` also returns 345; its "Per100K" naming would mean 0.345% — the fills say otherwise.) | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L141 |
| adapter.ts:216 | REST `order-history?count=100` | Timed out once (15 s, axios) during a lookup; `count=20` polls answered in ~0.3–0.7 s. | rest-2026-10-05.jsonl (16:24:50Z entry, `status: null`) |

## Experiment: leverage limit — what `initial_margin` means (slot 2, ETH) — 2026-10-05T16:33Z

1-lot ETH IOCs with increasing `lv`, then closed (lb=0). `initial_margin`/`maintenance_margin` and on-chain `getMarginFractions` both say 1200 / 2000 for ETH.

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| units.ts:171 | Is `initial_margin` a 1e4 fraction (1200 = 12% → 8.33x) or max leverage in hundredths (1200 = 12x)? | **Max leverage in hundredths.** `lv` 1000 (10x) filled at 10x (position `c` 270158 ≈ $2.688/10) — impossible under the 8.33x reading. `lv` 1300, 1500, 2000, 5000 were **all accepted and silently clamped to `lv` 1200**: each lot posted ≈ $2.69/12 (≈225 k CNS) and the position reports `lv: 1200`. No rejection is ever sent. | Backend/fixtures/perpl/recordings/cmuvdcw1q000513az9i6cc1x5-2026-10-05.jsonl#L24-L56 (rq 1–3), Backend/fixtures/perpl/recordings/cmuvdcw1q000513az9i6cc1x5-2026-10-05.jsonl#L107-L140 (rq 5–7) |
| units.ts:171 | `maintenance_margin` scale | Same scale by every consistent reading: 2000 = 20x = **5%** (the docs' own example "2000 = 5%"), and for every market maint-leverage > init-leverage (ETH 12x/20x, BTC 15x/25x, MON 3x/5x, ZEC 3x/10x). Not observed via a liquidation. | /v1/pub/context (fixtures/perpl/context.testnet.json) |
| — | Does adding size keep the position's leverage? | **No — each fill re-margins the whole position to the new order's `lv`.** After rq 1 (10x, c=270158) the 12x rq 2 left c=450771 = 2 lots' notional/12; the first lot's extra margin went back to the balance. | Backend/fixtures/perpl/recordings/cmuvdcw1q000513az9i6cc1x5-2026-10-05.jsonl#L24-L41 |

## close --slot 2 — 2026-10-05T16:39:38.935Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| close | IOC close: statuses, final balance | no open position; outcome -; balanceCNS after close 9999985671 | - |
| withdraw | Withdraw everything above the reserve; getWithdrawAllowanceData before/after | withdrew 9899985671 asset units ok; balanceCNS → 100000000 (reserve 100000000); allowanceCNS 1608673336507 → 0, cnsPerBlock 750664176, expiry 68459813 → 0 | withdraw [0x956b7695…](https://testnet.monadvision.com/tx/0x956b769579aec25d9d5a6cd7a1200b211ed1832e4243579743e9e1460a107c1d); sweep [0x1ebd003e…](https://testnet.monadvision.com/tx/0x1ebd003efe474d92631b4afd27c8f9276d33e8c56b6364b3212943e48a3a35f6) |

<details><summary>raw result</summary>

```json
{
  "close": {
    "skipped": "no open position"
  },
  "balanceCNSAfterClose": "9999985671",
  "reserveAsset": "100000000",
  "withdrawAsset": "9899985671",
  "withdrawTx": "0x956b769579aec25d9d5a6cd7a1200b211ed1832e4243579743e9e1460a107c1d",
  "allowanceBefore": {
    "block": "68451242",
    "allowanceCNS": "1608673336507",
    "expiryBlock": "68459813",
    "lastAllowanceBlock": "68453385",
    "cnsPerBlock": "750664176"
  },
  "allowanceAfter": {
    "block": "68451242",
    "allowanceCNS": "0",
    "expiryBlock": "0",
    "lastAllowanceBlock": "0",
    "cnsPerBlock": "0"
  },
  "balanceCNSAfterWithdraw": "100000000",
  "sweepTx": "0x1ebd003efe474d92631b4afd27c8f9276d33e8c56b6364b3212943e48a3a35f6",
  "sweptAsset": "9899985671",
  "decimals": 6
}
```

</details>

## equity --slot 1 — 2026-10-05T16:40:45.470Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| adapter.ts:277 | Does pnlCNS include premiumPnlCNS? Which sum matches API `c` + unrealized (and the Perpl UI)? | 16:30:38: deposit+pnl=18803750, +premium=18803750, deposit+pricePnl@mark=18803750, pnlCNS=-5740 vs pricePnl@mark=-5740, premium=0; API c+uPnL=18803750; value=37613240 ‖ 16:35:42: deposit+pnl=18851630, +premium=18851630, deposit+pricePnl@mark=18851630, pnlCNS=42140 vs pricePnl@mark=42140, premium=0; API c+uPnL=18851630; value=37661120 ‖ 16:40:45: deposit+pnl=18870390, +premium=18870390, deposit+pricePnl@mark=18870390, pnlCNS=60900 vs pricePnl@mark=60900, premium=0; API c+uPnL=18870390; value=37679880 ‖ Perpl UI: (fill in) | eth_call getPosition; GET /v1/trading/positions (rest-*.jsonl) |

<details><summary>raw result</summary>

```json
[
  {
    "at": "2026-10-05T16:30:38.518Z",
    "chain": {
      "depositCNS": "18809490",
      "pnlCNS": "-5740",
      "deltaPnlCNS": "-5740",
      "premiumPnlCNS": "0",
      "lotLNS": "14",
      "pricePNS": "268707",
      "markPNS": "268666",
      "markValid": true
    },
    "derived": {
      "pricePnlAtMark6": "-5740",
      "depositPlusPnl": "18803750",
      "depositPlusPnlPlusPremium": "18803750",
      "depositPlusPricePnl": "18803750",
      "positionValue6": "37613240"
    },
    "api": {
      "c": "18809490",
      "ep": 268707,
      "s": 14,
      "lv": 200,
      "fee": "12979",
      "unrealizedAtMark6": "-5740",
      "cPlusUnrealized6": "18803750",
      "raw": {
        "at": {},
        "mkt": 32,
        "acc": 824,
        "pid": 4485868879873,
        "rq": 0,
        "oid": 0,
        "st": 1,
        "sr": 0,
        "sd": 1,
        "c": "18809490",
        "ep": 268707,
        "s": 14,
        "fee": "12979",
        "cfee": "0",
        "efs": 32098,
        "lv": 200,
        "cpnl": "0",
        "dpnl": "0",
        "fnd": "0",
        "pay": "0",
        "xfs": 0,
        "ots": {
          "b": 68448927,
          "t": 1791217675000,
          "tx": 4
        }
      }
    },
    "liquidationHypotheses": {
      "maintA": 0.2,
      "liqA": 1679.41875,
      "maintB": 0.024,
      "liqB": 1376.5727459016393
    }
  },
  {
    "at": "2026-10-05T16:35:42.433Z",
    "chain": {
      "depositCNS": "18809490",
      "pnlCNS": "42140",
      "deltaPnlCNS": "42140",
      "premiumPnlCNS": "0",
      "lotLNS": "14",
      "pricePNS": "268707",
      "markPNS": "269008",
      "markValid": true
    },
    "derived": {
      "pricePnlAtMark6": "42140",
      "depositPlusPnl": "18851630",
      "depositPlusPnlPlusPremium": "18851630",
      "depositPlusPricePnl": "18851630",
      "positionValue6": "37661120"
    },
    "api": {
      "c": "18809490",
      "ep": 268707,
      "s": 14,
      "lv": 200,
      "fee": "12979",
      "unrealizedAtMark6": "42140",
      "cPlusUnrealized6": "18851630",
      "raw": {
        "at": {},
        "mkt": 32,
        "acc": 824,
        "pid": 4485868879873,
        "rq": 0,
        "oid": 0,
        "st": 1,
        "sr": 0,
        "sd": 1,
        "c": "18809490",
        "ep": 268707,
        "s": 14,
        "fee": "12979",
        "cfee": "0",
        "efs": 32098,
        "lv": 200,
        "cpnl": "0",
        "dpnl": "0",
        "fnd": "0",
        "pay": "0",
        "xfs": 0,
        "ots": {
          "b": 68448927,
          "t": 1791217675000,
          "tx": 4
        }
      }
    },
    "liquidationHypotheses": {
      "maintA": 0.2,
      "liqA": 1679.41875,
      "maintB": 0.024,
      "liqB": 1376.5727459016393
    }
  },
  {
    "at": "2026-10-05T16:40:45.465Z",
    "chain": {
      "depositCNS": "18809490",
      "pnlCNS": "60900",
      "deltaPnlCNS": "60900",
      "premiumPnlCNS": "0",
      "lotLNS": "14",
      "pricePNS": "268707",
      "markPNS": "269142",
      "markValid": true
    },
    "derived": {
      "pricePnlAtMark6": "60900",
      "depositPlusPnl": "18870390",
      "depositPlusPnlPlusPremium": "18870390",
      "depositPlusPricePnl": "18870390",
      "positionValue6": "37679880"
    },
    "api": {
      "c": "18809490",
      "ep": 268707,
      "s": 14,
      "lv": 200,
      "fee": "12979",
      "unrealizedAtMark6": "60900",
      "cPlusUnrealized6": "18870390",
      "raw": {
        "at": {},
        "mkt": 32,
        "acc": 824,
        "pid": 4485868879873,
        "rq": 0,
        "oid": 0,
        "st": 1,
        "sr": 0,
        "sd": 1,
        "c": "18809490",
        "ep": 268707,
        "s": 14,
        "fee": "12979",
        "cfee": "0",
        "efs": 32098,
        "lv": 200,
        "cpnl": "0",
        "dpnl": "0",
        "fnd": "0",
        "pay": "0",
        "xfs": 0,
        "ots": {
          "b": 68448927,
          "t": 1791217675000,
          "tx": 4
        }
      }
    },
    "liquidationHypotheses": {
      "maintA": 0.2,
      "liqA": 1679.41875,
      "maintB": 0.024,
      "liqB": 1376.5727459016393
    }
  }
]
```

</details>

## add-margin --slot 1 --usd 5 — 2026-10-05T16:42:24.885Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| adapter.ts:185 | Unit of `a` on a t:6 order | cns-integer ("5000000") moved depositCNS by 5000000 | cns-integer: Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L448-L465; deposit [0x425e9437…](https://testnet.monadvision.com/tx/0x425e9437ee9eea5fac3c76f8af2890e36b712bc16b11e01f13464575371373f8) |
| adapter.ts:334 | Which statuses Perpl reports for a t:6 order | cns-integer: ack {"code":0}; mt:24 st7/sr32 | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L448-L465 |

<details><summary>raw result</summary>

```json
{
  "fundTx": "0xf623ddfd19ca5d4b586210bb5db4b45262f5d1abd4c0f5e5c59452dc6e319505",
  "depositTx": "0x425e9437ee9eea5fac3c76f8af2890e36b712bc16b11e01f13464575371373f8",
  "attempts": [
    {
      "form": "cns-integer",
      "a": "5000000",
      "rq": "12",
      "raw": {
        "kind": "order",
        "order": {
          "at": {
            "b": 68451793,
            "t": 1791218541000,
            "tx": 3,
            "txid": "115fb57acce45b3e94d50dfa81576b7d9dcfcd7df3feed097b95c4d5af444307",
            "l": 1
          },
          "c": {
            "b": 68451793,
            "t": 1791218541000,
            "tx": 3
          },
          "rq": 12,
          "mkt": 32,
          "acc": 824,
          "oid": 4486056706075,
          "scid": 0,
          "st": 7,
          "sr": 32,
          "t": 6,
          "r": true,
          "os": 0,
          "fp": 0,
          "fs": 0,
          "f": "0",
          "bfa": "0",
          "fl": 0,
          "mm": 10,
          "lv": 0,
          "mnp": 1000
        }
      },
      "depositCNSBefore": "18809490",
      "depositCNSAfter": "23809490",
      "moved": "5000000",
      "balanceCNSBefore": "10026184587",
      "balanceCNSAfter": "10021184587",
      "statuses": [
        {
          "st": 7,
          "sr": 32,
          "line": 465
        }
      ],
      "ack": [
        {
          "line": 450,
          "status": {
            "code": 0
          }
        }
      ],
      "evidence": "Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L448-L465"
    }
  ]
}
```

</details>

### Note on the add-margin run above (frame-by-frame)

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| adapter.ts:334 | What does a **successful** t:6 report? | **No success status at all, then a failure.** Block 68451787: the collateral was applied once — `mt:27` position event `sr:6`, `c` +5000000 (event `rq: 0`) and `mt:21` account event `et:3`, `a` −5000000 — with no `mt:24` for rq 12 and `lfr` still 11. Block 68451793: the **only** `mt:24` for rq 12 arrives as `st:7 / sr:32` (OrderDescIdTooLow), and `lfr` becomes 12. On-chain `depositCNS` moved by exactly 5000000, once. **The adapter's "instant: first non-failure, else first failure" rule would call this applied add "failed"** — a retry would double it. Confirm a t:6 by the on-chain `depositCNS` delta (or the `mt:27` `sr:6` event), not by `mt:24`. | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L449-L458 |

## equity --slot 1 — 2026-10-05T17:07:30.025Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| adapter.ts:277 | Does pnlCNS include premiumPnlCNS? Which sum matches API `c` + unrealized (and the Perpl UI)? | 17:07:30: deposit+pnl=23913370, +premium=23912670, deposit+pricePnl@mark=23914070, pnlCNS=103880 vs pricePnl@mark=104580, premium=-700; API c+uPnL=23914070; value=37723560 ‖ Perpl UI: (fill in) | eth_call getPosition; GET /v1/trading/positions (rest-*.jsonl) |

<details><summary>raw result</summary>

```json
[
  {
    "at": "2026-10-05T17:07:30.022Z",
    "chain": {
      "depositCNS": "23809490",
      "pnlCNS": "103880",
      "deltaPnlCNS": "104580",
      "premiumPnlCNS": "-700",
      "lotLNS": "14",
      "pricePNS": "268707",
      "markPNS": "269454",
      "markValid": true
    },
    "derived": {
      "pricePnlAtMark6": "104580",
      "depositPlusPnl": "23913370",
      "depositPlusPnlPlusPremium": "23912670",
      "depositPlusPricePnl": "23914070",
      "positionValue6": "37723560"
    },
    "api": {
      "c": "23809490",
      "ep": 268707,
      "s": 14,
      "lv": 200,
      "fee": "12979",
      "unrealizedAtMark6": "104580",
      "cPlusUnrealized6": "23914070",
      "raw": {
        "at": {},
        "mkt": 32,
        "acc": 824,
        "pid": 4485868879873,
        "rq": 0,
        "oid": 0,
        "st": 1,
        "sr": 0,
        "sd": 1,
        "c": "23809490",
        "ep": 268707,
        "s": 14,
        "fee": "12979",
        "cfee": "0",
        "efs": 32098,
        "lv": 200,
        "cpnl": "0",
        "dpnl": "0",
        "fnd": "0",
        "pay": "0",
        "xfs": 0,
        "ots": {
          "b": 68448927,
          "t": 1791217675000,
          "tx": 4
        }
      }
    },
    "liquidationHypotheses": {
      "maintA": 0.2,
      "liqA": 1232.9901785714285,
      "maintB": 0.024,
      "liqB": 1010.64768735363,
      "maintC": 0.05,
      "liqC": 1038.3075187969926
    }
  }
]
```

</details>

## increase --slot 1 --usd 10 — 2026-10-05T17:08:41.992Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| Spec 01 Phase B | Does adding size reset premiumPnlCNS to 0? | premiumPnlCNS -700 → 0; pnlCNS 103880 → 93240; depositCNS 23809490 → 28242585; lots 14 → 21; entry 268707 → 268977; order filled | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L508-L516; deposit [0x46cae1eb…](https://testnet.monadvision.com/tx/0x46cae1ebb14969f5175dcb37654bcd5400fde55941e5e5a2b73c1932351da966) |

<details><summary>raw result</summary>

```json
{
  "file": "C:\\Users\\ADMIN\\Documents\\Hackathons\\Laxu\\Backend\\fixtures\\perpl\\recordings\\cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl",
  "amount": "10000000",
  "fundTx": "0x277a5980ff59b82667c0a85108d3e6be1aa6838b631c1331be7e1df93014608f",
  "depositTx": "0x46cae1ebb14969f5175dcb37654bcd5400fde55941e5e5a2b73c1932351da966",
  "accountBefore": {
    "accountId": "824",
    "balanceCNS": "10021184587",
    "lockedBalanceCNS": "0",
    "frozen": 0
  },
  "accountAfterDeposit": {
    "accountId": "824",
    "balanceCNS": "10031184587",
    "lockedBalanceCNS": "0",
    "frozen": 0
  },
  "positionBefore": {
    "accountId": "824",
    "positionType": 0,
    "depositCNS": "23809490",
    "pricePNS": "268707",
    "lotLNS": "14",
    "entryBlock": "68448927",
    "pnlCNS": "103880",
    "deltaPnlCNS": "104580",
    "premiumPnlCNS": "-700",
    "markPricePNS": "269454",
    "markPriceValid": true
  },
  "positionAfter": {
    "accountId": "824",
    "positionType": 0,
    "depositCNS": "28242585",
    "pricePNS": "268977",
    "lotLNS": "21",
    "entryBlock": "68456940",
    "pnlCNS": "93240",
    "deltaPnlCNS": "93240",
    "premiumPnlCNS": "0",
    "markPricePNS": "269421",
    "markPriceValid": true
  },
  "accountAfter": {
    "accountId": "824",
    "balanceCNS": "10026744283",
    "lockedBalanceCNS": "0",
    "frozen": 0
  },
  "request": {
    "requestId": "14",
    "lastExecBlock": "68456952"
  },
  "attempts": [
    {
      "rq": "13",
      "lb": "68456926",
      "sentAt": 1791220088646,
      "result": "lookup:not_placed",
      "lookups": 2,
      "error": "ConnectionLostError: Perpl trading socket closed (1008)"
    },
    {
      "rq": "14",
      "lb": "68456952",
      "sentAt": 1791220096276,
      "result": "ws:filled",
      "lookups": 0
    }
  ],
  "lots": "7",
  "size6": "7000",
  "mark18": "2694210000000000000000",
  "outcome": {
    "requestId": "14",
    "orderId": "4486394019840",
    "filledSize6": "7000",
    "avgPrice18": "2695170000000000000000",
    "feeAsset": "6509",
    "reason": "TakerOrderFilled",
    "status": "filled"
  },
  "wsOutcomeMs": 1278,
  "history": {
    "found": true,
    "latencyMs": 22683,
    "polls": 31,
    "entries": [
      {
        "at": {
          "b": 68456940,
          "t": 1791220096000,
          "tx": 1,
          "txid": "5bc656901489ac6ee809243f5ea224b5f32e9c815465042f0f775c160a07e436",
          "l": 4
        },
        "c": {},
        "rq": 14,
        "mkt": 32,
        "acc": 824,
        "oid": 4486394019840,
        "scid": 0,
        "st": 4,
        "sr": 43,
        "t": 1,
        "os": 7,
        "fp": 269517,
        "fs": 7,
        "f": "6509",
        "bfa": "0",
        "fl": 4,
        "mm": 10,
        "lv": 200,
        "mnp": 1000
      }
    ]
  },
  "frames": [
    {
      "line": 508,
      "mt": 22
    },
    {
      "line": 511,
      "mt": 3
    },
    {
      "line": 516,
      "mt": 24
    }
  ],
  "events": [
    {
      "line": 516,
      "mt": 24,
      "st": 4,
      "sr": 43,
      "fs": 7,
      "fp": 269517,
      "os": 7,
      "f": "6509"
    }
  ]
}
```

</details>

## close --slot 1 — 2026-10-05T17:09:58.834Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| close | IOC close: statuses, final balance | st4/sr43 fs=21 (L617); outcome filled; balanceCNS after close 10055047572 | Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L609-L617 |
| withdraw | Withdraw everything above the reserve; getWithdrawAllowanceData before/after | withdrew 9955047572 asset units ok; balanceCNS → 100000000 (reserve 100000000); allowanceCNS 4504594376132 → 0, cnsPerBlock 750664176, expiry 68459818 → 0 | withdraw [0x25bcec6b…](https://testnet.monadvision.com/tx/0x25bcec6b9489e8d24acee1affc9a24d59260a5a01437082aecf69b85ad01bf62); sweep [0x77a54af6…](https://testnet.monadvision.com/tx/0x77a54af68b408a11008849ee224f7d864eb46fb88c5415d001b446ca700d4d74) |

<details><summary>raw result</summary>

```json
{
  "close": {
    "rq": "15",
    "attempts": [
      {
        "rq": "15",
        "lb": "68457262",
        "sentAt": 1791220189884,
        "result": "ws:filled",
        "lookups": 0
      }
    ],
    "outcome": {
      "requestId": "15",
      "orderId": "4486414336000",
      "filledSize6": "21000",
      "avgPrice18": "2693590000000000000000",
      "feeAsset": "19516",
      "reason": "TakerOrderFilled",
      "status": "filled"
    },
    "positionAfter": {
      "accountId": "824",
      "positionType": 0,
      "depositCNS": "0",
      "pricePNS": "0",
      "lotLNS": "0",
      "entryBlock": "0",
      "pnlCNS": "0",
      "deltaPnlCNS": "0",
      "premiumPnlCNS": "0",
      "markPricePNS": "269330",
      "markPriceValid": true
    },
    "statuses": [
      "st4/sr43 fs=21 (L617)"
    ],
    "evidence": "Backend/fixtures/perpl/recordings/cmuvdcs6r000213az63sqmnb8-2026-10-05.jsonl#L609-L617"
  },
  "balanceCNSAfterClose": "10055047572",
  "reserveAsset": "100000000",
  "withdrawAsset": "9955047572",
  "withdrawTx": "0x25bcec6b9489e8d24acee1affc9a24d59260a5a01437082aecf69b85ad01bf62",
  "allowanceBefore": {
    "block": "68457261",
    "allowanceCNS": "4504594376132",
    "expiryBlock": "68459818",
    "lastAllowanceBlock": "68457261",
    "cnsPerBlock": "750664176"
  },
  "allowanceAfter": {
    "block": "68457267",
    "allowanceCNS": "0",
    "expiryBlock": "0",
    "lastAllowanceBlock": "0",
    "cnsPerBlock": "0"
  },
  "balanceCNSAfterWithdraw": "100000000",
  "sweepTx": "0x77a54af68b408a11008849ee224f7d864eb46fb88c5415d001b446ca700d4d74",
  "sweptAsset": "9955047572",
  "decimals": 6
}
```

</details>

## faucet (external requestFunds) — 2026-10-05T17:51:22.229Z

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| faucet | Amount received per requestFunds(receiver) | token() = 0xa9012a055bd4e0edff8ce09f960291c09d5322dc; first claim for fresh 0x915eCA694e1ed3a2b686cC2946c19DeCd6b3af9a: tx [0x5023c124…](https://testnet.monadvision.com/tx/0x5023c1240ab0c3ff3c7c401dbc52e8bae3d6fa5a4df348962e2bb3ae45f54611), received 10000000000 (10000 AUSD) | [0x5023c124…](https://testnet.monadvision.com/tx/0x5023c1240ab0c3ff3c7c401dbc52e8bae3d6fa5a4df348962e2bb3ae45f54611) |
| faucet | May a non-receiver call it (caller = Laxu faucet wallet, receiver = user)? | **Yes** — caller 0xB033980fEfda4BB354B7FE6902239B8865261180 ≠ receiver 0x915eCA694e1ed3a2b686cC2946c19DeCd6b3af9a, funds went to the receiver | [0x5023c124…](https://testnet.monadvision.com/tx/0x5023c1240ab0c3ff3c7c401dbc52e8bae3d6fa5a4df348962e2bb3ae45f54611) |
| faucet | Second immediate call (same caller, same receiver) — cooldown? | **reverted in simulation**: { "code": 3, "message": "execution reverted", "data": "0x20e5bc67" } | eth_call revert payload (raw) |
| faucet | Same caller, another fresh receiver right after (is the cooldown per caller or per receiver?) | **reverted in simulation**: { "code": 3, "message": "execution reverted", "data": "0x20e5bc67" } | eth_call revert payload (raw) |

<details><summary>raw result</summary>

```json
{
  "faucet": "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
  "token": "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
  "caller": "0xB033980fEfda4BB354B7FE6902239B8865261180",
  "first": {
    "receiver": "0x915eCA694e1ed3a2b686cC2946c19DeCd6b3af9a",
    "sent": true,
    "txHash": "0x5023c1240ab0c3ff3c7c401dbc52e8bae3d6fa5a4df348962e2bb3ae45f54611",
    "before": "0",
    "after": "10000000000"
  },
  "second": {
    "receiver": "0x915eCA694e1ed3a2b686cC2946c19DeCd6b3af9a",
    "sent": false,
    "simulateRevert": {
      "code": 3,
      "message": "execution reverted",
      "data": "0x20e5bc67"
    },
    "before": "10000000000",
    "after": "10000000000"
  },
  "third": {
    "receiver": "0x06AB6E81Cc8c315d9B062b2B18BB740C563e9e14",
    "sent": false,
    "simulateRevert": {
      "code": 3,
      "message": "execution reverted",
      "data": "0x20e5bc67"
    },
    "before": "0",
    "after": "0"
  }
}
```

</details>

### Note on the external faucet run above (2026-10-05T17:51Z)

| VERIFY | Question | Answer | Evidence |
|---|---|---|---|
| faucet | Exact signature | `requestFunds(address receiver)`, selector `0x544c7cf9`. **Not verified** on Sourcify (proxy or implementation), so it was taken from UI claim txs, whose input is `0x544c7cf9` ++ receiver, and cross-checked against the implementation bytecode (`0xba804df5…2a49` behind the EIP-1967 proxy `0xd236c18D…ee6C`, admin `0x85f263d9…48f2`). | UI claims [0x8c6c7d5d…](https://testnet.monadvision.com/tx/0x8c6c7d5d12011ec41282bb623105a9e5540cf764a98efb6f3ae0faf1957e2d09), [0x8ee8df3b…](https://testnet.monadvision.com/tx/0x8ee8df3bd42d60a5c9f274a8ae9af0874b4ab3894e38d0f096351582274e510c) |
| faucet | Cooldown scope and length | **One global 60 s cooldown for the whole contract**, not per caller or receiver: right after our claim, a call from a *different* wallet (the float, which never claimed) for a fresh receiver reverted with the same `0x20e5bc67` (no args, no public signature), and our faucet wallet was allowed again ~60 s after the claim. Unnamed no-arg views agree: `0x48645704` → 60, `0xd9772a25` → 1791222680 (= 17:51:20Z, our claim's time), `0x905467f6` → 10000000000 (= 10,000 AUSD, the claim amount), `0x14bc2fd7` → 100000000000 (100,000 AUSD, meaning unknown). The faucet held ~997.5M AUSD. | eth_call simulations (scratch script), 17:51:44–17:52:20Z |
| faucet | Consequence for Laxu | Two users claiming within 60 s of each other — or of anyone using the Perpl UI faucet — collide; the second reverts. External mode therefore simulates first and falls back to `transfer` on any revert. | — |
| faucet | Backend `external` mode end to end | `claimTestFunds` for two fresh users 3 s apart: the first went **external** (10,000 AUSD received; the claim row records the amount read from the receipt's Transfer log); the second hit the 60 s cooldown in **simulation** (`0x20e5bc67`, no gas spent) and **fell back to transfer** (1,000 AUSD from the faucet wallet, funded with 2,000 AUSD from the float for this: [0x5f2af101…](https://testnet.monadvision.com/tx/0x5f2af101056194c8f51021c6019b6193c4654f5b30f04449e91a4afaf4227772)). Test rows deleted afterwards. | [0x413716af…](https://testnet.monadvision.com/tx/0x413716af4a1ffd14a984e05511a93c811bf78d7dc2b63dba0a85b06bf81207c6) (external), [0x420878cf…](https://testnet.monadvision.com/tx/0x420878cf606cb4dd5e9c1783c3216e67bbca062f87b1a47b6d49ce187ad30153) (fallback) |


---

## Spec 06

### Docs used (Part 1)

The `~/perpl` folder named in Spec 06 is not on this machine, so the public pages at docs.perpl.xyz were used: `resources/for-developers/api/websocket.md`, `api-docs-main/websocket.md` and `types-and-errors.md`. They differ from the spec's description:

- Keep-alive: "Send a Ping (`mt: 1`) about every 30 seconds"; the server replies with Pong (`mt: 2`); market-data connections do not need `mt: 1`. The pages do not say the server pings at protocol level. **Observed:** it does, every 5.0 s, from the handshake on (`docs/e2e-run.md`, Phase 6 follow-up).
- Close codes: the public pages say `1008` covers "rate, connection, ping, or sign-in timeout limits"; the reason strings ("ping timeout", "idle timeout") appear only in the server's close frame.
- Rate limits (public `types-and-errors.md`): about 50 messages/s per connection and about 5 connections per IP, market-data and trading combined; REST about 60 requests/min authenticated, 100/min public. The spec quotes 60 requests/min and 4 connections per wallet for the trading socket; those figures were **not verifiable** from the public pages. The backend holds one trading socket per slot plus at most one market-data socket from one IP, so it stays under 5 only with 4 or fewer slots open.

### Docs used (Parts 2-5)

Still no `~/perpl` folder; these pages were read from docs.perpl.xyz (the same files the spec names, published at the site root): `rest-endpoints.md`, `types.md`, `integrations.md`, `authentication.md`, `resources/for-developers/api/builder-codes.md`, `exchange/funding.md`.

### Part 2: fills on Perpl (2026-10-09)

Quoted from `rest-endpoints.md`: history endpoints take `page` ("Cursor for pagination (from previous response `np`)") and `count` ("Items per page (max: 100)"); "Server-side filtering by market ID or date range is not currently supported. Filter results client-side if needed."; pages are "newest to oldest". `Fill` is `{ at: BlockTxLogTimestamp, mkt, acc, oid, t, l, p?, s, f, bfa? }`, with `f` "gross: protocol fee + `bfa`".

What the testnet actually returns (slot 1, account 824, and slot 2, account 841):

- **`at.txid` has no `0x` prefix** (`"1b15773e…6894"`). `types.md` only says "Transaction hash". The backend adds `0x` and drops anything that is not 32 bytes of hex. Checked one against the chain: `0xd2523953…790e` is block 68499916, tx index 1, to the Exchange `0x1964…80cc`, status 1, exactly the fill's `at.b` / `at.tx`.
- `bfa` is present as `"0"` on every fill, not omitted as the docs say ("omitted when zero"). Treated as no builder fee.
- Position-history events carry fields `types.md` does not list: `cpnl`, `pay`, `xfs`; `ots` is `{}` on every event.
- **No `Funding` (type 8) account events at all** on either slot, although both held positions through several funding intervals. Funding is realised into the position: each position-history event carries `fnd` (realised funding PnL of that event). Account-history types seen: 1 Deposit, 2 Withdrawal, 3 IncreasePositionCollateral, 4 Settlement.
- Fee amounts `f` are collateral base units (AUSD 6 dp), the same unit as every other API Amount (`v-units-75` above).

**Matching method** (`services/venueFillsMath.ts`): order ids. A fill has `oid` but no `rq`, and a slot is reused across positions, so the backend takes the oids it saved (the entry order on `positions.venue_order_id`, the ledger rows' `venue_order_id`), finds the position's `pid` (saved on `positions.venue_position_pid`, or named by the entry order's position-history event), adds every oid from position-history events with that `pid`, and keeps only fills with account + market + one of those oids. The `pid` step matters: the close order's oid is not stored anywhere in our DB (close ledger rows have no `venue_order_id`). A time window alone would also be wrong: the entry fill (18:57:54) is two minutes before `opened_at` (18:59:51, set when the token minted). The time window (open request − 5 min to close + 10 min) is used only when not a single oid is known.

Checked on the real data: slot 1 held two Laxu ETH longs one after the other, next to probe trades. Position `0xaedd…53f9` gets 5 fills (open, increase, two decreases, close), `0x96e2…d7fa` gets 2 (open, close); no overlap, and none of the 19 probe/e2e fills. Spot-check against `GET /v1/trading/order-history` for oid 4489210494992: `fp` 271592 = price 2715.92, `fs` 14 = 0.014 ETH, `f` 13118 = 0.013118 AUSD, `t` 1 OpenLong, same txid, all as the panel shows.

### Part 3: funding (2026-10-09)

Quoted from `rest-endpoints.md` (`GET /api/v1/market-data/:market_id/funding/:from-:to`): "`from` and `to` are matched against the timestamp each event **applies** at", "The period may cover at most **1024 funding intervals** of the market", the response's `d` is "Funding events, oldest first", and "The **most recent event** may carry an estimated `at.t` ..., which is corrected within about a minute". From `types.md`: `rate: Micros; // Funding rate (10^-6)`, "treat a repeat of a known `feb` as an update, not a new funding event". From `exchange/funding.md`: the direction "depends on whether the funding rate is positive (payment flows from long positions to short positions) or negative (payment flows in the opposite direction)".

**Units, checked on testnet:** `rate` is micros per funding interval. Proof: `ppl` (payment per lot) = floor(`idx` × `rate` / 10^6) for all 8 markets in `/v1/pub/context` and every event in the BTC series (BTC: 823792 × 10 / 10^6 = 8.2 → `ppl` 8; ZEC: 1219187 × 30 / 10^6 = 36.57 → `ppl` 3657 with `div` 100). So:

- percent per interval = `rate` / 10^4 (BTC `rate` 10 = 0.001%);
- annualised (simple, not compounded) = percent × 365 × 86400 / `funding_interval_sec`;
- `funding_interval_sec` is **2580** (43 min, 8571 blocks) on every testnet market, not one hour.

**Bug fixed in the App:** `App/src/lib/markets.ts` read the context's `funding.rate` as "pct per 100k" (`rate / 100_000`), so the trade screen showed funding **10x too high** (BTC 0.0100% instead of 0.0010%). The on-chain contract's `fundingRatePct100k` is a different field; the API's `rate` is micros. Now `rate / 1_000_000`.

**Sign:** positive rate, longs pay shorts. Matches the realised funding seen in position history: the ETH long `pid 4489210494977` has `fnd` −13300 (paid 0.0133 AUSD) and the BTC short `pid 4489238347777` has `fnd` +14535 (received), while rates were positive.

**Other behaviour seen:**

- `to` more than one funding interval past now is refused with a bare `400 Bad Request` (text/plain). The docs say this only for the all-markets endpoint ("`to` may run up to the **longest** funding interval past the current time"); it holds for the per-market one too. The backend clamps `to` to now + 0.9 interval.
- A 30-day request (1005 intervals) is over the cap; the backend splits it (2 requests) and dedupes by `feb`: 991 unique intervals came back for ETH.
- The current rate is the newest event (the ticker has no funding field). It matched `/v1/pub/context`'s `markets[].funding` (BTC 10, ETH 20 micros at `feb` 69467955).
- **Funding paid per position is not in account history.** No `Funding` (type 8) account event exists on either slot. Perpl realises funding into the position when its size changes or it closes, as `fnd` on the position-history event, so the "Fills on Perpl" card sums `fnd` over the position's `pid` events. While a position stays open and unchanged, that figure does not move: the accruing part is in the token's own `fundingAccrued` (the reporter), not on Perpl's history.
- **Not cross-checked against Perpl's web UI**: no browser in this session. Cross-checked against `/v1/pub/context` and the `ppl` identity instead.

### Part 4: programmatic key enrollment (2026-10-09)

Quoted from `integrations.md`: "`/api-key/payload` and `/api-key/enroll` are CORS-enabled ... In **both** cases the request's `Origin` must be whitelisted by Perpl"; "**From a server** (e.g. Node) set the `Origin` header explicitly"; the public key "is sent as raw 32 bytes, `0x`-hex encoded"; proof of possession is "an Ed25519 signature by the API private key over the EIP-712 digest `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`"; enroll errors `404` target profile not found, `409` "Public key already registered (revoked keys can't be re-enrolled — use a fresh key pair)", `423` "Per-profile key limit reached (max 16 active keys)"; "Listing and revoking keys is done from the web UI (`/apikeys`), not the API".

- `Backend/scripts/perpl/enrollSlotKey.ts` (+ `src/venue/perpl/enrollment.ts`, `enrollSlots.ts`). Offline tests run it against a local mock of both endpoints: the wallet signature recovers to the slot wallet, the PoP verifies against the sent public key over the digest built by hand from the formula above, the key is 0x + 64 hex, `Origin` is set on both calls, and neither the token, the seed nor the EVM key appears in the printed output.
- **Not run against Perpl**, not even `--dry-run`: no origin has been whitelisted, and no real key was to be enrolled in this session. The exact rejection text is therefore not known yet. The script prints Perpl's own error body when it is refused.
- **The docs do not show the `typed_data` contents** (only that its message has a human-readable `statement`). The script signs exactly what comes back, as the docs say. The mock's field names are our guess.
- **The 16-key limit cannot be checked in advance**: the API cannot list keys. The script handles `423` with a clear message instead.
- The existing `venue/perpl/enroll.ts` (used by `npm run slots:provision`, Spec 02) **prints a newly enrolled secret to the console**. It was left unchanged, because the slot path was out of scope for this work. Use `slots:enroll` instead.
