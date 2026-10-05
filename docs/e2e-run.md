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
money back, and one holder (B) was left underpaid by $0.45 (#5).

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
   is fair. B's $0.45 was not made good.
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

Steps 1, 2, 5 and 9 passed only after a fix or a corrected check — see **Incidents and fixes** above. One holder (B) was underpaid $0.450644 by incident #5.
