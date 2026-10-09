# Privy findings (Spec 05)

## Gate decision

**PASS (2026-10-09): do Part 2 as written.** All three results hold on Monad testnet (10143):
- **1.1** Privy signs **and broadcasts** (`sendTransaction`, median 1172 ms); signing-only with viem broadcast also works, so the `PrivyWalletSender` needs no fallback.
- **1.2** Policies enforce `to`, `value`, function name and a numeric parameter limit, deny by default, and a DENY-all rule overrides the ALLOW (so Part 2 must not add one).
- **1.3** The server acted on a user's embedded wallet through a signer with the policy attached (allowed call mined, three forbidden calls `policy_violation`), and after `removeSigners` the same call fails with 401.

Caveats to carry into Part 2: Monad bills the gas **limit**, so never fix a large `gas_limit` on real calls; an estimate-time revert hides a policy decision (`transaction_broadcast_failure` instead of `policy_violation`); signers need a Privy **embedded** wallet (email login). Not measured: concurrent sends from one wallet, stateful limits, signer behaviour for a wallet created under `createOnLogin: 'users-without-wallets'` vs `'all-users'` (the test user's wallet worked as created).

| Result | Decision |
|---|---|
| Privy sends on Monad, policies reject correctly, user-wallet signer works | PASS: Part 2 as written |
| Privy signs but does not broadcast | PASS with fallback (`PrivyWalletSender` signs via Privy, viem broadcasts) |
| Server wallet works, user-wallet signer does not | Part 3 only |
| Nothing works on Monad | FAIL: only 2.7 |

## Run order

```
cd Backend
npx ts-node --transpile-only scripts/privy/00-check.ts            # no signer needed (done)
npx ts-node --transpile-only scripts/privy/00-create-signer.ts    # creates the key quorum + writes .env (done once)
npx ts-node --transpile-only scripts/privy/01-server-wallet.ts --fund --also-sign   # 1.1 (done)
npx ts-node --transpile-only scripts/privy/02-policy.ts                 # 1.2 (P1 only; --with-deny-all [--order-test] reruns P2/P3)
npx ts-node --transpile-only scripts/privy/03-user-signer.ts --wallet 0x...  # 1.3, after "Add signer" in the browser
```

State (wallet ids, addresses, results) goes to `Backend/.e2e/privy-spike.json`, which is gitignored. No script prints a key or secret.

## Measured

### 1.1 Server wallet on Monad testnet (run 2026-10-08, PASS)

Key quorum created by `00-create-signer.ts` (`keyQuorums().create`, 1-of-1, name `laxu-server`, id `pwgeso78bs5m8sqm5z24khor`). Private key format that worked: base64 PKCS8 DER, no PEM header (what `generateP256KeyPair()` returns).

Server wallet `i18i3e1cagebc1bzd1v0ewjy`, address `0x8d69008cb420C27435d6a707206944d828258094`, owned by the quorum. Funded 0.05 MON from the faucet wallet (tx `0x7f61ffc90cbe927f8bc1e939b99761119a4f1e9f37bc6b4e950b65a6f7c006cf`).

| | Path A: `sendTransaction` (Privy signs and broadcasts) | Path B: `signTransaction` + viem `sendRawTransaction` |
|---|---|---|
| Works on 10143 | yes, 5 of 5, receipt of the first `success` | yes, 1 of 1, receipt `success` |
| Tx on chain | chain id 10143 on the tx | hash `0x107adeb3746c04ee3f5eddc8d54f4529f19e80d41aa5480969c4de9d39ab280a` |
| Latency | median **1172 ms** (2498, 1254, 1172, 1029, 939; the first call includes a cold start) | sign step **390 ms** (one sample; broadcast and receipt not included) |
| Who sets gas / nonce | **Privy**: we passed neither; it set gas limit 26456, nonce 0 (the wallet's first tx), maxFeePerGas 182.4 gwei | **us**: nonce, fees and gas come from our own RPC and go into the signed payload |

Path A hashes: `0x937f4804c3f4e2221cfde6920444a8a07a05806df9e18a87d7fb918e8e050ef9`, `0x6cb99c967fd454c816e0fc96ea35ba11c607974ea488ff2f837709bb7fba56a1`, `0x953ff39ada60cd0371967f93581d9e463b0caeda448f4ad4424c571ddb5a4b75`, `0xd89ff1ce0c8a3897fdf51d565d17d30f34b313f3b4873cd8e71a86fc0ac2b8cb`, `0xebcef08cc445279608b67ee26919b315020f0589eb5d0664740a06efb7cd689c`. Only the first receipt was read (over our RPC); the other four were not checked, and none was looked up on MonadVision.

For Part 2: use Path A (`sendTransaction`) in `PrivyWalletSender`. About 1 s per call is fine for a 5 s worker interval. Path B stays as a documented fallback. Privy chose a 26456 gas limit for a 1-wei transfer, a thin margin over 21000, so recheck it with a real `repay` call in Part 2. Path A sets the nonce itself, so concurrent sends from one wallet are untested; the plan to send sequentially stands.

### 1.2 Policy enforcement (run 2026-10-08, PASS)

Two runs. Run 1 left two cases inconclusive (see "Run 1 caveat" below); run 2 fixed `gas_limit` so Privy skips gas estimation, and all six cases were decided by the policy engine. **Run 2 (policy `wudc3vujs3wri9uoeerv5ws0`, allow-only):**

| Case | Result |
|---|---|
| `approve(dead, 1000)` on the token | **allowed**, tx `0xb19e166e065827925daf87e712a5ca181d1794c1c011441e05336680b761c8f9` |
| `approve(dead, 1001)` (limit + 1) | `policy_violation` |
| `transfer(dead, 1)` on the allowed token (forbidden function) | `policy_violation` |
| `approve` at a different address | `policy_violation` |
| plain 1 wei send | `policy_violation` |
| `approve` carrying value 0x1 | `policy_violation` |

So `to`, `value`, function name and a numeric parameter limit are all enforced, and an unmatched request is denied. The original policy-rejection text (the demo clip) is `{"error":"RPC request denied due to policy violation","code":"policy_violation"}`.

**Run 1 caveat (kept for the record).** Without a fixed `gas_limit`, `transfer` and `approve`-with-value returned `transaction_broadcast_failure` ("execution reverted") instead of `policy_violation`: Privy estimates gas before the policy check, so a call that would revert is reported as a revert and the policy decision is hidden. Consequence for Part 2: **a forbidden call that also reverts shows up as a broadcast failure, not a policy rejection**, so the rejection script (2.8 item 5) must pass an explicit `gas_limit`, and the worker should treat both error codes as "not sent".

Run 1 details:

Test token: AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`, parameter limit 1000. Allow rule: `eth_sendTransaction`, `to == token`, `chain_id == 10143`, `value <= 0`, `function_name == approve`, `approve.amount <= 1000`. Policies created with `policies().create`, attached with `wallets().update(walletId, { policy_ids: [id], authorization_context })` (a new attach replaces the previous policy).

Policy-rejection body, identical every time: `HTTP 400 {"error":"RPC request denied due to policy violation","code":"policy_violation"}`.

| Case (P1: one ALLOW rule, no DENY) | Result | Conclusive? |
|---|---|---|
| `approve(dead, 1000)` on the token | sent, tx `0xdbd7b70bfba165edb50292062baed667694c9ad4e6f7c564dc64e42190e6caa2`, 1205 ms | yes |
| `approve(dead, 1001)` (limit + 1) | `policy_violation` | **yes: parameter limit works (N allowed, N+1 denied)** |
| `approve` at a different address | `policy_violation` | **yes** |
| plain 1 wei send to another address | `policy_violation` | **yes** |
| `transfer(dead, 1)` on the allowed token | `transaction_broadcast_failure`, "execution reverted" | no (settled in run 2) |
| `approve` carrying value 0x1 | `transaction_broadcast_failure`, "execution reverted" | no (settled in run 2) |

In run 1 the last two rows were not policy decisions (the script mislabelled them "rejected"); run 2 above settles them. `02-policy.ts` now sends a fixed `gas_limit` and labels each result `ALLOWED BY POLICY`, `POLICY DENIED` or `NOT A POLICY DECISION`.

**Default deny: confirmed.** P1 has no DENY rule, and the other-address and plain-send cases were still denied by policy. A request that matches no rule is rejected.

**A DENY-all rule defeats the ALLOW, in either order.** P2 (ALLOW then `method: "*"` DENY) and P3 (DENY first, then ALLOW) both denied the call that P1 allowed (`policy_violation`). So a DENY that matches wins over an ALLOW, and rule order made no difference. The explicit DENY-all that Privy's docs show is not just unnecessary here, it would block everything. **Do not add a DENY-all rule in Part 2 (2.4); the allow-only policy is the right shape.** (An earlier version of the script printed the P2 id as the one to attach when adding the signer; that would have denied every repay. Fixed.)

**Stateful limits (1.2 step 6): not exercised.** Docs only, see below.

Evidence: `Backend/.e2e/privy-spike.json` (`spike12`). Policy ids: P1 `zm752z8muhinton0m70dxydn`, P2 `lv6irwqcoagw6l5odlox6b6v`, P3 `c4zr3iy58hzfee31q1wu90pa` (run 2 created P1 again, `wudc3vujs3wri9uoeerv5ws0`, which is the one attached to the spike wallet now). **Policy id to use when adding the user signer: `wudc3vujs3wri9uoeerv5ws0`, never P2 or P3.** Spike policies are throwaway; Part 2 creates its own per rule.

### 1.3 User-wallet signer (PASS, run 2 on 2026-10-09)

**Run 2 (signer attached, then removed).** Same wallet, policy `wudc3vujs3wri9uoeerv5ws0`. Page log: `addSigners: OK` at 04:47:59, `removeSigners: OK` at 04:50:19.

| Step | Result |
|---|---|
| Script right after Add | `additional_signers: 1; ours present: true; its policy ids: ["wudc3vujs3wri9uoeerv5ws0"]` (wallet-level `policy_ids` stays `[]`: the policy lives on the signer) |
| `approve(dead, 1000)` from the user's wallet, signed only by the server key | **allowed**, tx `0x370e8a29a2c5a29fbdfc9a99db1b2b5b7b745e195ab81a1f64af367cb2f7cc8f` (receipt `success`, `from` = the user's wallet) |
| `approve(dead, 1001)` | `policy_violation` |
| `transfer(dead, 1)` on the token | `policy_violation` |
| `approve` at another address | `policy_violation` |
| Script after Remove (`--expect-removed`) | `additional_signers: 0`; the same allowed call now fails `HTTP 401 No valid authorization signatures were provided` |

So the server can act on a user's embedded wallet through a signer with a policy attached, the policy enforces the same rules as in 1.2, and **removing the signer stops further calls** (401, before any policy check). The user pressed the page's own buttons; no Privy popup appeared for `addSigners` on this setup, so the page's button was the only consent step. The server never held a user key.

How a policy id is attached from the React SDK (1.3 step 4): the policy must already exist (created server-side with `policies().create`), and its id is passed in the same call that adds the signer: `useSigners().addSigners({ address, signers: [{ signerId: <quorum id>, policyIds: [<policy id>] }] })`. The server then sees it on the wallet as `additional_signers[0].override_policy_ids`.

**Cost finding (matters for Part 2).** That one allowed call took 0.0204 MON from the user's wallet. The receipt shows `gasLimit 200000`, `gasUsed 200000`, `effectiveGasPrice 102 gwei`. **Monad charges the gas limit, not the gas the call needs.** The spike's fixed `gas_limit: 0x30d40` (200000) was far larger than an `approve` or `repay` needs, so it cost about 10x what a tight limit would. For Part 2: do not fix a generous limit on the real `repay`. Either let Privy estimate (it chose 26456 for a 1-wei send in 1.1) or estimate with our own RPC and add a small margin. The fixed limit stays only in the rejection-test scripts, where denied calls are never mined. The user's wallet also needs MON for gas, which the protection card should say.

**Run 1 (2026-10-08, inconclusive, kept for the record).** User: email login, embedded wallet `0xfc7d5c97ec539215fab84a732b74f5dce6833d21` (Privy wallet id `ut2hhpkqfbfl2q0637v89o8x`, `owner_id` = a Privy user id, `policy_ids` empty), balance 0.4796 MON. Page: `/dev/privy`.

What happened, from the page log and the script output:

| Time | Step | Result |
|---|---|---|
| 20:44:54 | `useSigners().addSigners({ address, signers: [{ signerId: <quorum id>, policyIds: [<policy id>] }] })` | **OK** (no Privy popup appeared) |
| 20:47:26 | `removeSigners({ address })` | FAILED `signal is aborted without reason` (first attempt; cause unknown, possibly a dismissed or timed-out request) |
| 20:50:23 | `removeSigners({ address })` retry | **OK** |
| after | `03-user-signer.ts` (twice, incl. `--expect-removed`) | wallet has `additional_signers: 0`; every call `HTTP 401 No valid authorization signatures were provided` |

**What this shows.** With no signer on the wallet, the server's key is refused outright with 401 (not a policy decision), and the wallet's `additional_signers` is empty after `removeSigners`. That is the expected end state of a removal.

**What it does not show.** Neither script run happened while the signer was attached (both report `ours present: false`), so we still have **no evidence that the server can act on a user's wallet through the signer**, and therefore none that "removal stops the calls" (that needs a before and after). `addSigners` reported OK, but we never saw the signer on the wallet. Possible causes, not yet distinguished: the script ran only after the removal; or `addSigners` returned OK without the signer persisting. The gate for 1.3 stays open.

Script change: `03-user-signer.ts` now exits (code 3) when the signer is missing instead of running calls that can only 401.

### Step 00 results (no signer needed)

- App credentials in `Backend/.env` are accepted by Privy (read-only `wallets().list` returned 1 wallet). I cannot tell from the API whether this is the Monad app or the Singapore app; the user should confirm in the dashboard.
- The auth-key normaliser accepts SEC1 PEM, PKCS8 PEM, single-line PEM with `\n`, base64 PKCS8 DER and the `wallet-auth:` prefix, and rejects a non-P-256 key.

## SDK calls (`@privy-io/node` 0.35.0 and `@privy-io/react-auth` 3.45.0; every row below was run on Monad except "Remove signer (server)")

| Purpose | Call |
|---|---|
| Client | `new PrivyClient({ appId, appSecret })` (already in `src/auth/privy.ts`) |
| Create server wallet | `privy.wallets().create({ chain_type: 'ethereum', owner_id: <quorum id> })` |
| Privy signs and broadcasts | `privy.wallets().ethereum().sendTransaction(walletId, { caip2: 'eip155:10143', params: { transaction: { to, data, value } }, authorization_context })` -> `{ hash }` |
| Privy signs only | `privy.wallets().ethereum().signTransaction(walletId, { params: { transaction }, authorization_context })` -> `{ signed_transaction }`, then viem `sendRawTransaction` |
| Create policy | `privy.policies().create({ name, version: '1.0', chain_type: 'ethereum', rules, owner_id })` |
| Attach policy to a wallet | `privy.wallets().update(walletId, { policy_ids: [id], authorization_context })` (owner must sign; one policy per wallet) |
| Look up a user wallet | `privy.wallets().getWalletByAddress({ address })`; the result has `additional_signers`, `owner_id`, `policy_ids` |
| Add signer (browser) | `useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })` from `@privy-io/react-auth` |
| Remove signer (browser) | `useSigners().removeSigners({ address })` |
| Remove signer (server) | `wallets().update(walletId, { additional_signers: [...] })`, signed by the wallet owner. For a user-owned wallet that is the user, so the server cannot do it alone. |

REST name differences: the React `signerId` / `policyIds` are `signer_id` / `override_policy_ids` on the wallet object.

## Facts established from the docs and typings

- **Private key format.** The SDK wants a base64 PKCS8 DER key with no PEM header (`wallet-auth:` prefix is stripped). The quickstart's `openssl ecparam -genkey` writes a SEC1 PEM, which is a different encoding. `scripts/privy/_lib.ts` `normalizeAuthKey` converts any of the common shapes. The backend code for Part 2 should reuse it.
- **Env naming.** Spec 05 uses `PRIVY_SIGNER_ID` in the dashboard section and `PRIVY_AUTH_KEY_ID` in 2.3. They are the same thing (the key quorum id). The scripts and `.env.example` use `PRIVY_SIGNER_ID` only.
- **Chain id.** `caip2` is `eip155:10143`. The frontend already passes `monadTestnet` as `defaultChain` and `supportedChains` (`App/src/app/providers.tsx`).
- **Policy per signer.** Policies attach to the signer (`policyIds`), and the typings say "up to one policy ID". So one policy per rule is the right shape, and a user can have at most one policy per signer.
- **Default deny.** The docs do not say what happens when no rule matches. Measured (1.2): no match is denied, and an explicit `method: "*"` DENY rule overrides the ALLOW regardless of order, so it must not be added.
- **Calldata conditions.** `field_source: 'ethereum_calldata'`, `abi` for just the function, `field: 'approve.amount'` (dotted path) or `field: 'function_name'`. Numeric values are hex strings in the docs' examples.
- **Stateful (cumulative) limits.** Documented as supported (aggregations with `sum`, rolling windows of 1 to 72 hours, up to 10 per app), but only for `eth_signTransaction` and `eth_signUserOperation`, not `eth_sendTransaction`. Values update after signing, so concurrent requests can pass together. Not usable for the send path, and the ERC-20 allowance already caps total spend, so Part 2 does not depend on it.
- **Embedded wallets for signers.** Privy's quickstart sets `createOnLogin: 'all-users'`; the app uses `'users-without-wallets'`. Per the spec nothing is changed until the signer flow shows it is needed.

## Part 2 build notes (Spec 05 Part 2 and 05b)

Part 3 (Privy server wallets for the faucet and liquidator) was cancelled by the owner on 2026-10-09; the gate table's "Part 3 only" row is therefore moot. Script 01 (a server wallet on Monad) stays as a proof, not a shipped feature.

Where the code differs from the specs, and why:
- **Rule name length.** Privy rejects a rule name of 50 or more characters. Found by running the real service (the first unit test had pinned a 51-character name); shortened to `repay up to the cap, on this pool only`.
- **One active rule per wallet.** A signer carries at most one policy ("up to one policy ID"), so a second active rule would replace the first's policy. The backend refuses it. Stricter than Spec 05.
- **Old policies on re-enable.** Spec 05b 6.2 says delete the old policy "if the API allows". It does (`policies().delete` with the owner's authorization), but it is done only when Privy confirms our signer is no longer on the wallet: a signer must never be left holding a policy that no longer exists. Verified against Privy by the QA harness (a fixture policy was created and deleted).
- **A server-computed `phase`** (`setup` | `on` | `off`) per rule, from the rule and its last event, and a `CREATED` event. The browser cannot tell "setup never finished" from "turned off, with a permission left" from leftovers alone.
- **Cancel setup** is `DELETE /protection/:id` on a rule that is not enabled: it records "Setup cancelled" once.
- **GET /protection** returns `maxSpendCap` and `walletNativeBalance` at the top level and `walletHasSigner` and `allowance` per rule.
- **Worker gas check:** before a repay, the wallet must hold the gas limit times the fee cap in MON; otherwise a SKIPPED event and the note "Add MON for gas", no Privy call.
- **No Privy popup.** `addSigners` showed no popup on this setup (Spec 05b 4.2b), so the consent text and its button are the only consent; the card says "Powered by Privy" but never shows or implies a Privy dialog.
- **Extra files:** `ProtectionParts.tsx` (shared pieces) and `lib/protectionEligibility.ts` / `lib/protectionMath.ts` (dependency-free, so a script can test them), besides the files Spec 05b names.
- **SDK (Spec 05b 1):** `@privy-io/react-auth` 3.45.0. `useSigners()` gives `addSigners({ address, signers: [{ signerId, policyIds }] }): Promise<{ user }>` and `removeSigners({ address }): Promise<{ user }>` (removes all signers). An embedded wallet is `ConnectedWallet.walletClientType === "privy"`.

## Frontend QA (Spec 05b 7.2)

Run 2026-10-09. **Status: not complete.** What can run without a signed-in browser was run. Everything that needs an email user in a browser, a loan, or a screenshot was **not run**: this session has no browser and cannot sign in, and neither test wallet has a loan (neither holds position tokens; `0xfc7d5c97…3d21` holds 10,000 AUSD and 0.459 MON, `0x85892112…8033` holds nothing). No external-wallet (MetaMask) user exists in the database. The table says exactly what each line rests on.

| # | Scenario | Result | What it rests on / what remains |
|---|---|---|---|
| 1 | External-wallet user sees the disabled "needs email sign-in" card | **PARTIAL** | The eligibility function returns `not-embedded` for a MetaMask wallet and for an embedded wallet that is not the Laxu wallet (`App/scripts/checkProtectionMath.mjs`). Not seen in a browser. The backend's `NOT_EMBEDDED_WALLET` answer is unexercised: no such user exists. |
| 2 | Email user, no debt: Off state, "Borrow first" | **PARTIAL** | Live: `POST /protection` for `0xfc7d…` on a real pool answers `400 NO_LOAN`. Eligibility returns `no-debt`. The card was not rendered. |
| 3 | Full setup (both steps), Protected only after the backend confirms | **NOT RUN** | Needs a loan and a session. Live, server side: `activate` is refused `409 SIGNER_MISSING` while the signer is absent and the rule stays disabled; GET reads the signer (Privy) and the allowance (chain). |
| 4 | Trigger above health fires at once; event with tx link | **NOT RUN** | No loan. The decision and every clamp are unit-tested; live, only the worker's no-debt branch ran (one SKIPPED event across two ticks, nothing sent). |
| 5 | Empty wallet: skipped event, banner, no error spam | **NOT RUN live** | Unit: the `balance` skip, and one note per cooldown window. |
| 6 | MON near zero: gas warning, worker skips "Add MON for gas" | **NOT RUN live** | Unit: `gasShortfall` (including the 0.0204 MON a 200,000-gas repay cost on testnet), the note text. Live: GET returns the wallet's MON (0.4592). |
| 7 | Close the prompt in step 1: neutral "Cancelled", Continue works | **NOT RUN** | Code: a closed prompt becomes a typed `UserCancelled`, shown as a neutral line. Note: per the spike no Privy popup appears for step 1 on this setup, so there may be nothing to close. |
| 8 | Reject the approval in step 2, reload: Finish setup resumes at step 2 | **NOT RUN** | The resume inputs (`walletHasSigner`, `allowance`, `phase`) are verified live in GET. |
| 9 | Turn off: backend first, then signer, then allowance 0; verify on chain | **NOT RUN** | Live: disabling stops the rule and records once (shown for a cancelled setup and for the rule-7 switch-off). |
| 10 | Turn off with a rejected approval lands in Cleanup, then clean it | **NOT RUN** | Live: phase `off` reads correctly; leftovers come from live `walletHasSigner` / `allowance`. |
| 11 | Turn on again after turning off (spent back to 0) | **NOT RUN live** | `ruleResetData` is unit-tested (spent 0, disabled, unverified, no inherited cooldown or banner). `POST /protection`'s re-enable path needs a loan. |
| 12 | Phone-width screenshot of the On state | **NOT RUN** | No browser. |

**What did run:** backend suite 117 passing; `qa-protection.ts` 22 of 22 (evidence `Backend/.e2e/privy-qa.json`); App repay-preview vectors 6 of 6 identical to the backend's `planRepay` and 9 eligibility cases (`node scripts/checkProtectionMath.mjs`); `tsc` and `next build` pass with `NEXT_PUBLIC_ENABLE_PROTECTION` on and off; eslint clean on the changed files (one pre-existing error in `trade/engine.ts`).

**To finish the QA (needs your browser and a loan):**
1. Backend: stop any other backend, set `ENABLE_PROTECTION=true` in `Backend/.env`, start one backend. App: set `NEXT_PUBLIC_ENABLE_PROTECTION=true` in `App/.env.local`, restart `npm run dev`.
2. Sign in with email (`0xfc7d…` is embedded and has 10,000 AUSD and 0.459 MON). Open a position, deposit its tokens and borrow near the cap, so there is real debt. Sign in once with an external wallet for item 1.
3. Walk items 1 to 12; screenshot each step into `docs/screenshots/`, and note the tx hashes. Then run `npx ts-node --transpile-only scripts/privy/demo-rejection.ts --full`.

## Still to do

1. ~~1.3 (user-wallet signer)~~ done, see above. How it was run: the page is built: `App/src/app/dev/privy` (404 unless `NEXT_PUBLIC_DEV_TOOLS=1`). Procedure:
   1. In `App/.env.local` set `NEXT_PUBLIC_DEV_TOOLS=1` and `NEXT_PUBLIC_PRIVY_SIGNER_ID=<the quorum id>`, then `npm run dev` in `App/`.
   2. Open `/dev/privy`, sign in **with email** (the card says "Privy embedded wallet" when it will work), paste the policy id `wudc3vujs3wri9uoeerv5ws0`, click **Add signer** (no Privy popup is expected).
   3. Send the embedded wallet ~0.01 MON for gas (done for `0xfc7d...3d21`). **Immediately after the add** (do not click Remove first) run `03-user-signer.ts --wallet 0x...`. It must print `ours present: true`.
   4. Only then click **Remove signer**, and run the same script with `--expect-removed`.
   Status: all four steps done in run 2.
3. User: confirm in the Privy dashboard that app id `cmuvf9...` is the Monad app (the API cannot tell us).
4. User: move `~/privy-signer-backup.txt` into a password manager and delete it.
