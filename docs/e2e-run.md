# End-to-end run on Monad testnet (Spec 03 Phase 5)

Driven by `npm run e2e` (Backend/scripts/e2e.ts) against the backend running with every worker on (`ENABLE_INDEXER/RECONCILER/REPORTER/LIQUIDATOR=true`). Users A and B are plain wallets (A [0x4fAFD4…8e1e](https://testnet.monadvision.com/address/0x4fAFD49A3b15A3473f05716Ee394F452b44b8e1e), B [0xCAAED3…16AD](https://testnet.monadvision.com/address/0xCAAED360B33D2FD74A9961c7Dd065b4d384016AD)); the open request and the payment report are driven in-process (they need a Privy session over HTTP), everything else is on-chain.

## Step 1 — Open: A opens ETH long, $50 at 3x — **PASS**

_2026-10-05T19:00:05.303Z_

- open request `cmuvm3f420001oqsvn7abrmoe`: ETH long, $50 at 3x; pay $50.00 to slot wallet [0x27faec…e503](https://testnet.monadvision.com/address/0x27faec53e9fdae9e4fac0af5cc4731e77ae8e503)
- A paid: [0x19d1add7…](https://testnet.monadvision.com/tx/0x19d1add70c09045c58d7f052807ac359388ca2cae034f5c8c465a633540c298f)
- status **minted** after 152 s; entry orders sent: 1
- paymentTxHash: [0x19d1add7…](https://testnet.monadvision.com/tx/0x19d1add70c09045c58d7f052807ac359388ca2cae034f5c8c465a633540c298f)
- depositTxHash: [0x38509ca9…](https://testnet.monadvision.com/tx/0x38509ca97624ff89ca092088c19ac0c8207dcbd073642ae1d83f36a896e85721)
- position token [0xaedd43…53f9](https://testnet.monadvision.com/address/0xaedd433235a6d5605535fcabbc157d6bde4253f9); venue entry 2711.29, size 0.053 ETH; slot `cmuvdcs6r000213az63sqmnb8`
- venueDrift: ours 53000 @ 2711290000000000000000 / venue 53000 @ 2711290000000000000000
- NAV per share 0.9986114; totalAssets $49.93057; capital $50.00

Checks:

- ✅ the token exists
- ✅ venueDrift(): sizes match exactly
- ✅ venueDrift(): entries match exactly
- ✅ isPriceFresh() == true
- ✅ NAV equals the $50 deposit within fees (≤ $1: taker fee + spread)

## Step 2 — Funding: two reporter ticks — **FAIL**

_2026-10-05T19:02:35.714Z_

- waiting two reporter ticks (120 s + margin)
- computeFundingTarget terms: venueTotal $49.765464 = positionEquity $47.787627 + freeAboveReserve $1.977837; capital $50.00; pricePnL $-0.1802; fundingSettled $0.00; mark $2707.89 (live true) → target $-0.054336
- on-chain fundingAccrued $0.00, lastFundingTimestamp 1791226680 (266 s ago)

Checks:

- ❌ applyFunding was pushed (0 FundingUpdated event(s) since mint)
- ❌ lastFundingTimestamp is recent (266 s ≤ 2 ticks + 60 s)

## Step 2 — Funding: two reporter ticks — **PASS**

_2026-10-05T19:28:53.584Z_

- waiting two reporter ticks (120 s + margin)
- computeFundingTarget terms: venueTotal $49.791434 = positionEquity $47.813597 + freeAboveReserve $1.977837; capital $50.00; pricePnL $-0.15423; fundingSettled $0.00; mark $2708.38 (live true) → target $-0.054336
- push rule: |target − accrued| = $0.054336 vs threshold $0.10; funding age 519 s vs heartbeat 1800 s
- waiting for applyFunding: threshold or heartbeat, at most 1461 s more
- applyFunding → FundingUpdated {"fundingAccrued":"-58576","timestamp":"1791228520"} [0x37e6f74f…](https://testnet.monadvision.com/tx/0x37e6f74ff7e8600a12aa525391bfaf41f688ae890f92c8fa62d8b886a5bd22a9)
- on-chain fundingAccrued $-0.058576, lastFundingTimestamp 1791228520 (13 s ago)

Checks:

- ✅ the reporter evaluated the position on both ticks (2 NAV report rows since 2026-10-05T19:04:16.615Z)
- ✅ applyFunding was pushed (1 FundingUpdated event(s) since mint)
- ✅ lastFundingTimestamp is recent (13 s)

## Step 3 — Borrow: A borrows 30% against all its tokens — **PASS**

_2026-10-05T19:28:59.622Z_

- lending pool [0x556677…62Dd](https://testnet.monadvision.com/address/0x5566777B0635E5185Ee5039634576fDB5c8962Dd)
- A deposited all 50 shares as collateral: approve [0x3b99de8d…](https://testnet.monadvision.com/tx/0x3b99de8d373e73ffca2266502c68c5ed419efdab786ec736125e40f964cee5b4), depositCollateral [0xc1e8876b…](https://testnet.monadvision.com/tx/0xc1e8876be449661bc5925af1864e81fa148f31945d715c52ee7b218a90bfad3e)
- collateral value $49.867754; borrowed 30% = $14.960326: [0xb0a458f3…](https://testnet.monadvision.com/tx/0xb0a458f3be0e02e8a2d9a6495b009770131f7b2c4ad3c2ef7074f3eba0bd1ae6)
- health factor 2.0000

Checks:

- ✅ health factor > 1

## Step 4 — Deliberate failure: borrow above the LTV — **PASS**

_2026-10-05T19:29:01.149Z_

- availableToBorrow $9.973551 (50% LTV for a 3x position); trying $10.970907
- simulation: reverted — The contract function "borrow" reverted with the following reason:
- on-chain attempt: [0xa2150226…](https://testnet.monadvision.com/tx/0xa215022673e1763c0aab0a75c82592d76c0b708e71a9cb98d50df393d5cb40ed) → status **reverted**

Checks:

- ✅ the over-LTV borrow is refused in simulation
- ✅ and reverts on-chain

## Step 5 — List + buy-in: B buys in $20 — **FAIL**

_2026-10-05T19:35:06.509Z_

- A listed it as "e2e ETH long": [0x064b4363…](https://testnet.monadvision.com/tx/0x064b4363faecda52f0c80932b68903d55f515e16c2d12ce984f59aefbad8bd3f)
- B buys in $20: approve [0xcec230b1…](https://testnet.monadvision.com/tx/0xcec230b137bf9bc4dd8c6648ba6536b99c95788025b570551cf14e9c476bd25b), requestDeposit [0xd3d7968d…](https://testnet.monadvision.com/tx/0xd3d7968dfecfdb068d03b9f09e5e3a483d116b9b472dbc03f12108f5db88c429)
- **error:** timed out after 360 s waiting for DepositFulfilled for B

## Step 5 — List + buy-in: B buys in $20 — **PASS**

_2026-10-05T19:49:24.594Z_

- resuming B's $20 buy-in from an earlier attempt: requestDeposit [0xd3d7968d…](https://testnet.monadvision.com/tx/0xd3d7968dfecfdb068d03b9f09e5e3a483d116b9b472dbc03f12108f5db88c429) (already fulfilled)
- fulfilled [0xda824be3…](https://testnet.monadvision.com/tx/0xda824be3a5a7ee27c767574f2924df0ef9f94b05bb77ed4c4631190de685b643): $19.60 → 19.655738 shares at NAV 0.99716428; venue grew 20000 (size6) @ $2710.48
- creator fee $0.40; paid to A in that tx: $0.40
- venueDrift: ours 73000 @ 2711068082191780821917 / venue 73000 @ 2711070000000000000000 (entry diff 1917808219178083)

Checks:

- ✅ B's net assets = $20 × 0.98
- ✅ B's shares = 20 × 0.98 / NAV (19655738 vs 19655738, ±1 rounding)
- ✅ the creator received the 2% fee
- ✅ venueDrift(): sizes match exactly
- ✅ venueDrift(): entries agree within one price tick ($0.01; Perpl keeps a sub-tick entry residue)

## Step 6 — Redeem: B redeems half — **PASS**

_2026-10-05T19:49:59.201Z_

- B redeems half (9.827869 of 19.655738 shares): [0x4c417c65…](https://testnet.monadvision.com/tx/0x4c417c6586d4e62912aa894a24926f1a06393fa8d8eb3bce3b52a8414ff4d64d)
- fulfilled [0xacf99eca…](https://testnet.monadvision.com/tx/0xacf99eca298d549df5799adb3be7125735a8b3480bee2a8f03744f2d1146678e): paid $9.787388 at NAV 0.9958810859200142; venue reduced 10000 (size6) @ $2709.04
- venueDrift: ours 63000 @ 2711068082191780821917 / venue 63000 @ 2711070000000000000000 (entry diff 1917808219178083)

Checks:

- ✅ the requested shares were redeemed
- ✅ payout = shares × NAV (9787388 vs 9787388, ±1 rounding)
- ✅ B received it ($9.787388)
- ✅ venueDrift(): sizes match exactly
- ✅ venueDrift(): entries agree within one price tick ($0.01; Perpl keeps a sub-tick entry residue)

## Step 7 — Trigger: B's stop-loss / take-profit on the live mark — **PASS**

_2026-10-05T19:54:01.838Z_

- mark $2708.96; B set stop-loss $2707.61 / take-profit $2710.31: [0xd6b52ef6…](https://testnet.monadvision.com/tx/0xd6b52ef66bb0a23329b39898c97784ad5647d039e983717a5d8a94021dd86436)
- executeTrigger [0x93fb5e43…](https://testnet.monadvision.com/tx/0x93fb5e438f7a65feae397719d6f71b431e67e190c806a951bea680b5b2f48736): stop-loss at mark $2706.53; 9.827869 shares → $9.333299
- token currentMark() at that block: $2706.53 (the live Perpl mark via PerplReader)

Checks:

- ✅ fired on a mark that had crossed the level
- ✅ the mark used is the live on-chain mark at that block
- ✅ B was paid ($9.333299)
- ✅ B holds no shares afterwards

## Step 8 — Backend down: borrowing keeps working — **PASS**

_2026-10-05T20:05:06.080Z_

- backend down (http://localhost:4000/health unreachable) from 2026-10-05T19:54:42.626Z
- t+0 min: isPriceFresh true, funding age 69 s, borrow $0.10 [0x65d86ad9…](https://testnet.monadvision.com/tx/0x65d86ad9589da30dc58fa9a04a52f7cfa8d09a3897dad401a74e086fad80cd82)
- t+2 min: isPriceFresh true, funding age 192 s, borrow $0.10 [0x7dd5fd7b…](https://testnet.monadvision.com/tx/0x7dd5fd7bc9a5346d47957de7680321f83332bb99853dbe7cef9f0ffbe6c0d59f)
- t+4 min: isPriceFresh true, funding age 318 s, borrow $0.10 [0xa1fab58e…](https://testnet.monadvision.com/tx/0xa1fab58ebd793a2df44cd98f45a2124b8bd44dd2bf6d9c240b019f0a95c863ab)
- t+6 min: isPriceFresh true, funding age 442 s, borrow $0.10 [0x14c28d8f…](https://testnet.monadvision.com/tx/0x14c28d8f9392a04cb3517699a5480e250d8a6ae4730aaa2622640100adeadf8a)
- t+8 min: isPriceFresh true, funding age 565 s, borrow $0.10 [0xc01ea892…](https://testnet.monadvision.com/tx/0xc01ea892388b67829c648cce131afc5bd71a49a512cf77adbedda30507ec10f6)
- t+10 min: isPriceFresh true, funding age 690 s, borrow $0.10 [0x742b3f20…](https://testnet.monadvision.com/tx/0x742b3f205899ac41eef14f02e98066135e4402068d62ac06db7bf6ecb03448e4)

Checks:

- ✅ every check: isPriceFresh() == true and a $0.10 borrow succeeded, with the backend down for 10 min

## Step 9 — Close: repay, withdraw, requestClose, settle, claims — **FAIL**

_2026-10-05T20:06:28.598Z_

- A repays $15.56043 (+ interest accrued since): [0xef8aadbf…](https://testnet.monadvision.com/tx/0xef8aadbf4b6b38f8996817c05abd8af4b9cdfc13f1eadca2a849f050bc9ee166)
- **error:** withdrawCollateral reverted (0xf774dae3926dfea55e540a97537a01593271510dabd44024afdcc5f1732719a6)

## Step 9 — Close: repay, withdraw, requestClose, settle, claims — **PASS**

_2026-10-05T20:16:36.202Z_

- A withdraws 50 shares of collateral: [0xba27321e…](https://testnet.monadvision.com/tx/0xba27321e5d72a13082b97567c30272681816e61e26003c33018051567dad4bb8)
- A requestClose(): [0xf5c05e37…](https://testnet.monadvision.com/tx/0xf5c05e372b41706357c60ed5cff93f4a5451a85bc644a44bd1ef68fd3fac07e7)
- backend closed it: [0xa6b9bb58…](https://testnet.monadvision.com/tx/0xa6b9bb5882b7ae75d633daf5728c9c153024bfe986b5d4ee5bc638a16bf5a479) (final NAV value $50.12234, liquidated false)
- settle(): [0xc58c9ebf…](https://testnet.monadvision.com/tx/0xc58c9ebf548b91499360b684fef160d8b7e68da7260b09abc95674d3432a4a99) — $50.086611 for 50 shares
- claim pushed to A: [0xafb6a727…](https://testnet.monadvision.com/tx/0xafb6a72763a8ee36eb7a77f2627256b36abe7b65a4f3d76b9e056f1e493907bc) — $50.086611
- slot `cmuvdcs6r000213az63sqmnb8` is **free**; Perpl balance $100.00 (reserve $100.00)
- reconciler pass at 2026-10-05T20:16:28.318Z: drifted 0, unswept 0, stranded 0/0, missed liquidations 0

Checks:

- ✅ the backend closed the venue position and called close()
- ✅ the slot account is swept to exactly its reserve
- ✅ the slot is free again
- ✅ the reconciler's next pass is clean
- ✅ the holder (A) received the settlement

## Step 10 — Refund path: a wrong payment is refunded — **PASS**

_2026-10-05T20:17:06.247Z_

- open request `cmuvoxl640001xzr9zg9v0awa` for $20.00; A pays the wrong amount, $19.00
- payment: [0xc0e191c4…](https://testnet.monadvision.com/tx/0xc0e191c4d74d990faeb0cf90be6c60ffefcf8cfe7adb8647251da8a7fac4152a)
- status **refunded**: refund [0x972409ff…](https://testnet.monadvision.com/tx/0x972409ff7f869d7f640ca8acbcccb99d725f828169ba7245e1cc294dd7b4a269); error recorded: "Payment rejected: paid 19000000 base units, expected 20000000"

Checks:

- ✅ refunded on-chain
- ✅ A got the full $19.00 back (net change $0.00)
- ✅ the slot is released


## Incidents and fixes during the run

Steps 1, 2, 5 and 9 did not pass on the first try. The failed attempts stay in the log above; each was
fixed in the backend (or the check corrected), and the step re-run against the fixed code. One fix moved
money back; one holder (B) was underpaid by $0.45 (#5) and has since been paid it.

1. **Indexer could not start (before step 1).** Monad's public RPC refuses `eth_getLogs` over more than
   100 blocks; the backfill asked for ~90,000. *Fix:* every `getLogs` on the shared client is split into
   100-block windows (`RPC_LOGS_MAX_RANGE`), with a global cap on windows in flight.
2. **Mint bookkeeping transaction expired (step 1).** The DB transaction that records a minted position
   ran past Prisma's 5 s default against Neon. The token itself was created; the backend was restarted
   with a 30 s interactive-transaction timeout and its resume finished the mint (`minted` after 152 s).
3. **No funding push within two ticks (step 2, first attempt).** Correct behaviour, not a bug: the target
   (−$0.054, the entry fee) was under the push threshold (max($0.10, 0.1% of capital)) and the heartbeat is
   30 min. The step was rewritten to prove the reporter evaluated the position on both ticks and to wait
   for the heartbeat push, which landed on schedule.
4. **B's buy-in was never seen (step 5, first attempt).** Restarting the backend mid-step-1 left the new
   token unwatched: its `PositionCreated` was behind the resumed checkpoint and its DB row was written
   8 s after the indexer's bootstrap. *Fixes:* the indexer's minute tick catches up any DB-known token
   that is not watched; `INDEXER_BACKFILL_FROM_BLOCK` re-indexes on boot (used once here, which recovered
   and fulfilled B's deposit); the public RPC's "requests limited to 25/sec" is handled by a
   process-wide throttle (`RPC_MAX_RPS`, default 12) with retry; a failed indexer bootstrap retries with
   backoff, without registering its watchers twice. Step 5 then resumed B's original request rather than
   buying in again.
5. **`recycleFreedMargin` swept the holders' buffer to the float (found at step 9).** After B's redeem
   and trigger exit it withdrew **all** free balance above the reserve ($21.40) instead of what was paid
   out ($19.12), taking the open's sizing buffer with it. The reporter then (correctly) pushed −$2.69 of
   funding: NAV fell to 0.957, and **B's stop-loss exit in step 7 was paid at that NAV — $0.450644 less
   than fair** (the token's `fundingSettled`). *Fix:* recycle at most the amount paid out. *Repair:*
   $2.281923 moved back from the float into the slot account
   ([transfer](https://testnet.monadvision.com/tx/0xd333008bd9b15b5b0700a4d0ebc0dc0423a2dd7b8a2c3f89e68aafc7164c61ca),
   [deposit](https://testnet.monadvision.com/tx/0x66894d95727d865cb1699c475932c002ac3fabfc7d21319872965dd25e49e478));
   the next tick pushed funding −$0.0896 and NAV returned to 1.0020 before A's close, so A's settlement
   is fair.
   **Remediation:** B's shortfall, $0.450644, paid from the float to B
   ([0xe2c229b1…](https://testnet.monadvision.com/tx/0xe2c229b1120f89f4ec95280ee83bcf62312f19c8e53973345f3112c8e74cd9c5)).
   A guard in `recycleFreedMargin` now refuses (and alerts on) any withdrawal above the payout it funded,
   with a regression test.
6. **`withdrawCollateral` ran out of gas (step 9, first attempt).** The node's exact gas estimate left no
   headroom; a trace shows the pool's share transfer succeeding and the function then running out.
   *Fix:* every backend write (and the e2e script) sends with `GAS_BUFFER_BPS` (default +30%) over the
   estimate. Monad charges the full limit, so this is a small, bounded cost.
7. **Trading socket `1008 ping timeout` (throughout).** The server closed slot 1's socket several times
   ("no response to the server's ping") even with an explicit auto-pong and frames handled off the
   receive path. Not resolved; the socket reconnects and every order is decided on-chain by the lot rule
   when its outcome is lost, so no step was affected. The close log now reports event-loop delay to
   test the remaining hypothesis in the Phase 6 soak.

Also during the run: the orphaned backend from the first start (the shell was stopped, its `node` child
was not) was found by its port and killed before any position existed; the backend was then always
stopped by PID, and a single backend process was confirmed before every step.

## Summary

_2026-10-05T20:17:06.252Z_

| Step | What | Result | Key tx |
|---|---|---|---|
| 1 | Open: A opens ETH long, $50 at 3x | **PASS** | [0x19d1add7…](https://testnet.monadvision.com/tx/0x19d1add70c09045c58d7f052807ac359388ca2cae034f5c8c465a633540c298f) |
| 2 | Funding: two reporter ticks | **PASS** — pushed by the heartbeat: the target stayed under the threshold | [0x37e6f74f…](https://testnet.monadvision.com/tx/0x37e6f74ff7e8600a12aa525391bfaf41f688ae890f92c8fa62d8b886a5bd22a9) |
| 3 | Borrow: A borrows 30% against all its tokens | **PASS** | [0xb0a458f3…](https://testnet.monadvision.com/tx/0xb0a458f3be0e02e8a2d9a6495b009770131f7b2c4ad3c2ef7074f3eba0bd1ae6) |
| 4 | Deliberate failure: borrow above the LTV | **PASS** | [0xa2150226…](https://testnet.monadvision.com/tx/0xa215022673e1763c0aab0a75c82592d76c0b708e71a9cb98d50df393d5cb40ed) |
| 5 | List + buy-in: B buys in $20 | **PASS** | [0xda824be3…](https://testnet.monadvision.com/tx/0xda824be3a5a7ee27c767574f2924df0ef9f94b05bb77ed4c4631190de685b643) |
| 6 | Redeem: B redeems half | **PASS** | [0xacf99eca…](https://testnet.monadvision.com/tx/0xacf99eca298d549df5799adb3be7125735a8b3480bee2a8f03744f2d1146678e) |
| 7 | Trigger: B's stop-loss / take-profit on the live mark | **PASS** | [0x93fb5e43…](https://testnet.monadvision.com/tx/0x93fb5e438f7a65feae397719d6f71b431e67e190c806a951bea680b5b2f48736) |
| 8 | Backend down: borrowing keeps working | **PASS** | [0x742b3f20…](https://testnet.monadvision.com/tx/0x742b3f205899ac41eef14f02e98066135e4402068d62ac06db7bf6ecb03448e4) |
| 9 | Close: repay, withdraw, requestClose, settle, claims | **PASS** | [0xc58c9ebf…](https://testnet.monadvision.com/tx/0xc58c9ebf548b91499360b684fef160d8b7e68da7260b09abc95674d3432a4a99) |
| 10 | Refund path: a wrong payment is refunded | **PASS** | [0x972409ff…](https://testnet.monadvision.com/tx/0x972409ff7f869d7f640ca8acbcccb99d725f828169ba7245e1cc294dd7b4a269) |

Steps 1, 2, 5 and 9 passed only after a fix or a corrected check — see **Incidents and fixes** above. One holder (B) was underpaid $0.450644 by incident #5; that was paid back from the float afterwards (see its Remediation line).

## Phase 6 — soak, SHORTENED to 53.4 min at the user's request (not the 1-hour soak) — 2026-10-06T08:08:01.457Z

Backend running with every worker on; 53.4 min from 2026-10-06T07:12:47.740Z to 2026-10-06T08:06:14.465Z. The hour-based criteria below are evaluated over this shorter window only: a funding heartbeat cycle (30 min) and a full hour of reconnects were NOT observed. Funding age comes from the backend's `funding applied` log; /health/ready was checked once, at the end.

- A: ETH long, $20 at 2x — token [0x96e279d0…](https://testnet.monadvision.com/address/0x96e279d0ac6fe012aa5d2a23c5c0d49dfa76d7fa), slot `cmuvdcs6r000213az63sqmnb8` (opened 2026-10-05 20:44–20:47 UTC, reused)
- B: BTC short, $20 at 2x — token [0x80a2fde4…](https://testnet.monadvision.com/address/0x80a2fde41c83b25487ed12f2e25082e00232ffcb), slot `cmuvdcw1q000513az9i6cc1x5` (opened 2026-10-05 20:44–20:47 UTC, reused)

| Criterion | Observed | Result |
|---|---|---|
| WS reconnects ≤ 2 per socket per hour | slot `sqmnb8`: 7, slot `6cc1x5`: 10 | **FAIL** |
| Funding age always < FUNDING_HEARTBEAT_SECONDS + one tick (1860 s) | ~~A: max 3970 s, B: max 2133 s~~ — measurement error (counted past each close); corrected: **A max 1,438 s, B max 1,825 s**, see annotations | **PASS** (corrected) |
| No reconciler / other alerts | 0 alert line(s) | **PASS** |
| No unhandled errors | 0 unhandled; 18 other error-level line(s) | **PASS** |
| /health/ready answered 200 every minute | 1/1 | **PASS** |

Trading-socket closes during the soak, with the event-loop delay since the previous close:

| Time | Slot | Close | Server pings seen | Event-loop max (ms) | Event-loop p99 (ms) |
|---|---|---|---|---|---|
| 2026-10-06T07:18:45.058Z | `6cc1x5` | 1008 ping timeout | 109 | 72 | 35 |
| 2026-10-06T07:22:05.340Z | `6cc1x5` | 1008 ping timeout | 39 | 125 | 35 |
| 2026-10-06T07:22:16.845Z | `sqmnb8` | 1008 ping timeout | 165 | 58 | 35 |
| 2026-10-06T07:22:40.094Z | `sqmnb8` | 1008 ping timeout | 4 | 44 | 35 |
| 2026-10-06T07:23:58.461Z | `6cc1x5` | 1008 ping timeout | 22 | 62 | 35 |
| 2026-10-06T07:23:58.466Z | `sqmnb8` | 1008 ping timeout | 15 | 0 | 0 |
| 2026-10-06T07:26:11.671Z | `sqmnb8` | 1008 ping timeout | 26 | 41 | 35 |
| 2026-10-06T07:27:01.663Z | `6cc1x5` | 1008 ping timeout | 36 | 37 | 34 |
| 2026-10-06T07:31:49.950Z | `6cc1x5` | 1008 ping timeout | 57 | 44 | 34 |
| 2026-10-06T07:31:49.954Z | `sqmnb8` | 1008 ping timeout | 67 | 0 | 0 |
| 2026-10-06T07:38:10.056Z | `sqmnb8` | 1008 ping timeout | 19 | 278904 | 46 |
| 2026-10-06T07:38:29.048Z | `sqmnb8` | 1008 ping timeout | 3 | 47 | 34 |
| 2026-10-06T07:40:24.851Z | `6cc1x5` | 1008 ping timeout | 2 | 212 | 46 |
| 2026-10-06T07:49:32.976Z | `6cc1x5` | 1008 ping timeout | 109 | 69 | 35 |
| 2026-10-06T07:56:06.312Z | `6cc1x5` | 1008 ping timeout | 78 | 145 | 35 |
| 2026-10-06T08:00:23.402Z | `6cc1x5` | 1008 ping timeout | 28 | 228 | 35 |
| 2026-10-06T08:01:47.740Z | `6cc1x5` | 1006  | 0 | 82879 | 82879 |

Error-level lines (not unhandled):

- 2026-10-06T07:43:55.663Z [indexer] event handler failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:46:44.760Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:48:08.154Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:49:31.258Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:50:52.348Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:52:12.147Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:53:36.953Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:54:56.903Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T07:56:17.348Z [close-position] settlement resume attempt failed: venue position still 0.00045 after 3 close attempts; resume job retries
- 2026-10-06T08:01:47.724Z [market-sync] market sync tick threw: GET /v1/pub/context failed: read ECONNRESET
- 2026-10-06T08:01:57.767Z [reconciler] reconciliation pass threw: 
- 2026-10-06T08:01:57.777Z [reporter] lending pool retry pass failed: 
- 2026-10-06T08:01:57.782Z [close-position] settlement tick threw: 
- 2026-10-06T08:01:57.787Z [liquidator] liquidation tick threw: 
- 2026-10-06T08:01:58.343Z [indexer] checkpoint update failed: 
- 2026-10-06T08:02:07.787Z [reporter] reporting tick threw: 
- 2026-10-06T08:02:58.851Z [market-sync] market sync tick threw: 
- 2026-10-06T08:03:07.793Z [close-position] settlement tick threw: 

Closed through the normal flow afterwards:

- A: requestClose [0x839de356…](https://testnet.monadvision.com/tx/0x839de356bdbe0e926cf031a7206a98a0bffed3e5a2b28501fb924f2ead752491) → close [0x429f3355…](https://testnet.monadvision.com/tx/0x429f3355727e5019bf927b25b159bff63976a6bff9477dbe2daf3b323e56ac03) → settle [0x73ce0bed…](https://testnet.monadvision.com/tx/0x73ce0bedbbeef9d54cfe94710492748a084c44bcc82bfa45bfc6fbe45c2efee9) → claim [0x090ce148…](https://testnet.monadvision.com/tx/0x090ce148845be7724b26ffe204842fb93f1308f226adfccee141748e33e4a64b) ($19.703932); slot swept to reserve: false, free: true
- B: requestClose [0x0f5ae295…](https://testnet.monadvision.com/tx/0x0f5ae295a8b49da12f074bc9ce494591b42667d861191e7ca5938518621ee52d) → close [0x12c5e681…](https://testnet.monadvision.com/tx/0x12c5e6814086c2d818fbf7b93c64608da59c31d46cd7e0301bca1d5cda059866) → settle [0x883a3ae3…](https://testnet.monadvision.com/tx/0x883a3ae3d9b299b5227ad4571f641f2c86fbb367245dffbd3304bd80143da24a) → claim [0xfcd8ea4e…](https://testnet.monadvision.com/tx/0xfcd8ea4eaeb7b2acdc4c65c57e17c39c9bf93776ff1bdead93ce105a2af2b046) ($20.068528); slot swept to reserve: true, free: true

### Phase 6 — annotations (read with the table above)

**Corrected funding age (the row above is a measurement error, superseded here).** The script measured each
position to the end of the window, but funding is only owed while a position is open (A closed at 07:24:02,
B at 07:58:27). From the backend's `funding applied` log, up to each close: **A max 1,438 s; B max 1,825 s**
(07:00:15 → 07:30:41, the heartbeat), then 1,666 s (07:30:41 → 07:58:27). Both are under 1,860 s:
**PASS**. `scripts/soak.ts` now measures to the close.

**This PC slept twice during the soak** (Windows System log, Kernel-Power): Modern Standby
**07:31:50 → 07:36:26** and **08:00:24 → 08:01:43**. They account for the two outliers in the close table:
the 278,904 ms event-loop maximum reported at 07:38:10 (the process was suspended for 4 min 36 s), and the
`1006` close at 08:01:47 with 82,879 ms. They also account for the 08:01–08:03 error lines: on wake, Perpl
REST answered `ECONNRESET` and the DB pool timed out ("Timed out fetching a new connection from the
connection pool"); every worker recovered by itself (reconciler pass complete at 08:05:02, `/health/ready`
200, no restart).

**Trading-socket reconnects: still FAIL, and the evidence points at the server.** Leaving out the two closes
caused by standby, slot `…sqmnb8` closed 6 times and slot `…6cc1x5` 9 times in 53.4 min, all
`1008 ping timeout` ("no response to the server's ping"), against a budget of 2 per hour. Outside standby
the event loop's worst delay before any of them was 278 ms (p99 ~35 ms), so our process was not late with
its pong. Twice the two sockets (separate accounts, separate connections) were closed within 4–5 ms of
each other (07:23:58.461/.466, 07:31:49.950/.954), and the same happened at 07:08:27.722/.725 before the
window. Two independent sockets timing out in the same instant points to a server-side sweep, not this
process. Every order whose outcome a close interrupts is decided on-chain (lot rule), so no money was
affected; the reconnects are a known gap to raise with Perpl.

**Problems the soak found, all fixed (commits on Laxu-Monad):**

1. *Mint bookkeeping raced the indexer for the pool row* (20:44 on 10-05, A's open): Prisma's upsert lost
   to the indexer's `PoolCreated` handler and aborted the mint transaction; the resume finished it 80 s
   later. Fix: `INSERT … ON CONFLICT DO NOTHING` from all three writers (`lendingPoolRows.ts`).
2. *A settled position's claim was never pushed* (A, 07:24): the genesis-mint `Transfer` had been dropped
   (its catch-up ran before the mint's DB row existed), so `pushClaims` found no holders and marked the pass
   done. Fix: the creator is always a claim candidate (the chain balance decides). A's claim was then pushed
   by the backend ([0x090ce148…](https://testnet.monadvision.com/tx/0x090ce148845be7724b26ffe204842fb93f1308f226adfccee141748e33e4a64b)).
3. *A BTC buy-side IOC with `p: 0` never fills* (B's close, 07:43–07:56, 9 resume attempts): reproduced on
   slot 1 — the BTC `open_short` (sell) with `p: 0` filled, the `close_short` (buy) with `p: 0` was
   canceled unfilled (`st:5 sr:16`) against a full book, and the same close at mark + 1% filled at once.
   ETH `close_short` with `p: 0` filled. Fix: every market order carries an explicit limit at the slippage
   bound (mark × (1 ± slippage), rounded against the trader). B's close then went through on the next resume.
4. *Indexer catch-up after an outage was slow* (the session's 10 h gap left 118,700 blocks to backfill): it
   ran 18 queries per 100-block window (~37 min). Fix: one multi-event `getLogs` per window (~3.5 min here).

Also: the first soak attempt (10-05 20:47) was cut off when the session ended; its two positions stayed open
and unattended for ~10 h (still matching Perpl exactly; `isPriceFresh` false until the first push after
restart, as designed) and were reused for this run. The backend was restarted twice inside the window to
deploy fixes 2 and 3 (07:39:30, 07:57:40).


---

## Phase 6 follow-up: keep-alive (Spec 06 Part 1) — 2026-10-08

The original soak result above stays as recorded (**FAIL**, 6–9 closes per socket in 53 min). This section adds what the new instrumentation showed. Docs read: docs.perpl.xyz `websocket.md` and `api-docs-main/websocket.md` (the `~/perpl` copy named in the spec is not on this machine; see `perpl-findings.md`, "Spec 06").

### Audit of `src/venue/perpl/tradingWs.ts` (before the change)

| Question | Answer |
|---|---|
| Does the client send `mt:1` pings? | Yes: `setInterval` 30 s, trading socket only, started in the `open` handler right after the sign-in frame was *sent* (not after it succeeded), no jitter. |
| Market-data socket | `services/marketData.ts` sends no pings (correct per docs: "Market-data connections do not need `mt: 1`"). It sets `Origin` when `PERPL_ORIGIN` is set. |
| `mt:2` pong replies | Fell into `default: return`: ignored, not logged. |
| Protocol pings | `ws` 8.21.0, `autoPong: true` (explicit); `receiverOnPing` calls `websocket.pong()` before emitting `'ping'`, so a `'ping'` listener cannot suppress the pong. No code intercepts control frames. |
| Between us and Perpl | The handshake is answered by `server: cloudflare` (envoy upstream header on REST). No VPN or proxy of ours. |
| Sign-in first frame | Yes, in `open`, signing is synchronous (ms), far inside the 10 s idle window. Measured: the wallet snapshot (proof the sign-in worked) arrived 1.9 s after the socket was created. |
| Request budget | Outgoing frames are sign-in, orders, pings only. `sentLast60s` at close was 1 and 2. |
| Closes | Logged with code and event-loop delay; 1008/3401/others all went to the same backoff reconnect (1 s, 2 s, ... 60 s, reset on a wallet snapshot). A fresh timestamp and nonce is built on every connect. 1001 was not reconnected at once. 1013: frames were already queued off the receive callback. |
| Heavy inline work | None: `enqueue` + `setImmediate` drain in batches of 50. |

### What the instrumentation showed (`scripts/wsKeepAlive.ts`, `.e2e/ws-keepalive-idle30.*`)

- The **server pings every 5.0 s** (median gap 5000 ms, min about 4.6 s) at protocol level, on both sockets.
- **We answer every one with 0 ms lag** (337 pings, 337 pongs sent at the same millisecond).
- Our `mt:1` pings are **answered with `mt:2`** every time (55 and 56 of them; RTT about 350–500 ms, one 689 ms): the application round trip is long, about 0.4 s.
- Hypothesis (a), our pongs not sent or late: **ruled out**. Hypothesis (b), the server also needs our `mt:1`: **not supported**, since the pings were sent and answered and closes still happened (a pings-off A/B was not run).
- Cause is therefore outside this process: either the path (this PC in Nigeria, about 0.4 s RTT, via Cloudflare) or the server.

### Run: idle, two slot sockets, no orders, 30.05 min, run locally on this PC (no hosted backend was available to me)

Ping period 30 s (default), PC kept awake with `SetThreadExecutionState` (no stall over 10 s was seen).

| Time (UTC) | Slot | Close | Uptime | Since last server ping | Since last data frame |
|---|---|---|---|---|---|
| 13:39:46.508 | `…sqmnb8` | 1008 ping timeout | 1,688 s | 1,048 ms | 412 ms |
| 13:39:46.513 | `…6cc1x5` | 1008 ping timeout | 1,688 s | 1,055 ms | 419 ms |

- **Closes: 1 per socket in 30 min** (2 in total), both `1008 ping timeout`. The earlier soak had 6–9 per socket in 53 min.
- **The two closes were 5 ms apart**, and ping #337 had arrived 546 ms late (gap 5,546 ms against 5,000) on both sockets at the same instant, 1 s before the close. Both sockets lost about half a second together and then the server closed both. A data frame had arrived 0.4 s before each close, and every earlier pong had been sent immediately.
- Both reconnected and held to the end of the run (44 more server pings each after the reconnect).

### What changed

- `PERPL_WS_PING_MS` (default 30000, 0 = off): the app ping now starts **after** the sign-in succeeded (first wallet snapshot), with ±2 s jitter (`PingTimer` in `keepAlive.ts`), and stops on close / error / stop. Never on the market-data socket.
- Every socket keeps a `SocketTimeline`; every close is logged at **info** with code, reason, uptime, ms since the last server ping / data frame / pong sent / app ping / app pong, counts, the server ping gap, and requests in the last 60 s. Debug logs show each server ping received, pong sent, app ping sent and app pong received (with RTT). A `closed` event carries the same summary.
- 1001 now reconnects immediately.
- Tests: `keepAlive.test.ts` (timer start/stop, jitter, no double start, timeline) and `keepAlive.socket.test.ts` (a real socket against a local server: sign-in is the first frame, no ping before the sign-in succeeds, pings after, close summary). 87 backend tests pass, `tsc` clean.

### Honest read

The earlier numbers are not explained by a missing ping: the 30 s pings were already being sent. The improvement from 6–9 to 1 per socket could come from the new start timing, but more likely from the environment (the soak ran with open positions and two Modern Standby sleeps; this run was idle and kept awake), so it should not be credited to the change. One close per socket in 30 min is 2/h, **right at the budget, not under it**. Not run: the second 30–45 min run with small orders, and a run from a hosted machine to separate "this PC's network" from "the server". For Perpl: `1008 ping timeout` hits both of an account pair's sockets within 5 ms, about 1 s after a protocol ping that we answered immediately, while data frames were still arriving.

---

## Transactions cited in the README

Every hash the README links, in one place. All are from the run above except where noted. `createPosition` and `createPool` for step 1 are not printed in the step log; they were read on 2026-10-09 from the `PositionTokenFactory` and `LendingPoolFactory` logs in blocks 68478619–68479519, and their receipts name step 1's token (`0xaedd433235a6d5605535fcabbc157d6bde4253f9`) and pool (`0x5566777B0635E5185Ee5039634576fDB5c8962Dd`). Each hash was checked with `eth_getTransactionReceipt` on the Monad testnet RPC on 2026-10-09.

| Step | Transaction | Receipt status |
|---|---|---|
| 1. Pay AUSD to the slot | [0x19d1add70c09045c58d7f052807ac359388ca2cae034f5c8c465a633540c298f](https://testnet.monadvision.com/tx/0x19d1add70c09045c58d7f052807ac359388ca2cae034f5c8c465a633540c298f) | success |
| 1. Deposit into Perpl | [0x38509ca97624ff89ca092088c19ac0c8207dcbd073642ae1d83f36a896e85721](https://testnet.monadvision.com/tx/0x38509ca97624ff89ca092088c19ac0c8207dcbd073642ae1d83f36a896e85721) | success |
| 1. `createPosition` (block 68478731, from factory logs) | [0x0e985052e84d99d152a5af61f9226b8f944097dea5440c1c195d39e295bb6a91](https://testnet.monadvision.com/tx/0x0e985052e84d99d152a5af61f9226b8f944097dea5440c1c195d39e295bb6a91) | success |
| 1. `createPool` (block 68478737, from factory logs) | [0x8de67bc98362590fd9ccd91e87b9eb6fc14294662c1f1b4f39c7f8ce84a04397](https://testnet.monadvision.com/tx/0x8de67bc98362590fd9ccd91e87b9eb6fc14294662c1f1b4f39c7f8ce84a04397) | success |
| 2. `applyFunding` | [0x37e6f74ff7e8600a12aa525391bfaf41f688ae890f92c8fa62d8b886a5bd22a9](https://testnet.monadvision.com/tx/0x37e6f74ff7e8600a12aa525391bfaf41f688ae890f92c8fa62d8b886a5bd22a9) | success |
| 3. `depositCollateral` | [0xc1e8876be449661bc5925af1864e81fa148f31945d715c52ee7b218a90bfad3e](https://testnet.monadvision.com/tx/0xc1e8876be449661bc5925af1864e81fa148f31945d715c52ee7b218a90bfad3e) | success |
| 3. `borrow` | [0xb0a458f3be0e02e8a2d9a6495b009770131f7b2c4ad3c2ef7074f3eba0bd1ae6](https://testnet.monadvision.com/tx/0xb0a458f3be0e02e8a2d9a6495b009770131f7b2c4ad3c2ef7074f3eba0bd1ae6) | success |
| 4. Borrow above LTV | [0xa215022673e1763c0aab0a75c82592d76c0b708e71a9cb98d50df393d5cb40ed](https://testnet.monadvision.com/tx/0xa215022673e1763c0aab0a75c82592d76c0b708e71a9cb98d50df393d5cb40ed) | reverted (intended) |
| 5. Buy-in fulfilled | [0xda824be3a5a7ee27c767574f2924df0ef9f94b05bb77ed4c4631190de685b643](https://testnet.monadvision.com/tx/0xda824be3a5a7ee27c767574f2924df0ef9f94b05bb77ed4c4631190de685b643) | success |
| 6. Redeem fulfilled | [0xacf99eca298d549df5799adb3be7125735a8b3480bee2a8f03744f2d1146678e](https://testnet.monadvision.com/tx/0xacf99eca298d549df5799adb3be7125735a8b3480bee2a8f03744f2d1146678e) | success |
| 7. Stop-loss executed | [0x93fb5e438f7a65feae397719d6f71b431e67e190c806a951bea680b5b2f48736](https://testnet.monadvision.com/tx/0x93fb5e438f7a65feae397719d6f71b431e67e190c806a951bea680b5b2f48736) | success |
| 8. Borrow with the backend down (t+10 min) | [0x742b3f205899ac41eef14f02e98066135e4402068d62ac06db7bf6ecb03448e4](https://testnet.monadvision.com/tx/0x742b3f205899ac41eef14f02e98066135e4402068d62ac06db7bf6ecb03448e4) | success |
| 9. `repay` | [0xef8aadbf4b6b38f8996817c05abd8af4b9cdfc13f1eadca2a849f050bc9ee166](https://testnet.monadvision.com/tx/0xef8aadbf4b6b38f8996817c05abd8af4b9cdfc13f1eadca2a849f050bc9ee166) | success |
| 9. `withdrawCollateral` | [0xba27321e5d72a13082b97567c30272681816e61e26003c33018051567dad4bb8](https://testnet.monadvision.com/tx/0xba27321e5d72a13082b97567c30272681816e61e26003c33018051567dad4bb8) | success |
| 9. `settle` | [0xc58c9ebf548b91499360b684fef160d8b7e68da7260b09abc95674d3432a4a99](https://testnet.monadvision.com/tx/0xc58c9ebf548b91499360b684fef160d8b7e68da7260b09abc95674d3432a4a99) | success |
| 9. Claim pushed to A | [0xafb6a72763a8ee36eb7a77f2627256b36abe7b65a4f3d76b9e056f1e493907bc](https://testnet.monadvision.com/tx/0xafb6a72763a8ee36eb7a77f2627256b36abe7b65a4f3d76b9e056f1e493907bc) | success |
| 10. Wrong payment refunded | [0x972409ff7f869d7f640ca8acbcccb99d725f828169ba7245e1cc294dd7b4a269](https://testnet.monadvision.com/tx/0x972409ff7f869d7f640ca8acbcccb99d725f828169ba7245e1cc294dd7b4a269) | success |
| Privy signer spike (not this run): allowed `approve(dead, 1000)` from the user's wallet, signed only by the server key | [0x370e8a29a2c5a29fbdfc9a99db1b2b5b7b745e195ab81a1f64af367cb2f7cc8f](https://testnet.monadvision.com/tx/0x370e8a29a2c5a29fbdfc9a99db1b2b5b7b745e195ab81a1f64af367cb2f7cc8f) | success; see `docs/privy-findings.md` |
