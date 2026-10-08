# Privy findings (Spec 05)

## Gate decision

**PENDING.** The spike scripts are written and typecheck, but the steps that act on a wallet need `PRIVY_SIGNER_ID` and `PRIVY_AUTH_PRIVATE_KEY`. Nothing below under "Measured" has been run yet.

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
npx ts-node --transpile-only scripts/privy/01-server-wallet.ts --fund   # 1.1  needs PRIVY_SIGNER_ID + PRIVY_AUTH_PRIVATE_KEY
npx ts-node --transpile-only scripts/privy/02-policy.ts --order-test    # 1.2
npx ts-node --transpile-only scripts/privy/03-user-signer.ts --wallet 0x...  # 1.3, after "Add signer" in the browser
```

State (wallet ids, addresses, results) goes to `Backend/.e2e/privy-spike.json`, which is gitignored. No script prints a key or secret.

## Measured

Nothing yet. Step 00 results (no signer needed):

- App credentials in `Backend/.env` are accepted by Privy (read-only `wallets().list` returned 1 wallet). I cannot tell from the API whether this is the Monad app or the Singapore app; the user should confirm in the dashboard.
- The auth-key normaliser accepts SEC1 PEM, PKCS8 PEM, single-line PEM with `\n`, base64 PKCS8 DER and the `wallet-auth:` prefix, and rejects a non-P-256 key.

## SDK calls (from `@privy-io/node` 0.35.0 typings and Privy's docs; none run on Monad yet)

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
- **Default deny.** The docs do not say what happens when no rule matches (their deny-by-default pattern adds an explicit `method: "*"` DENY rule). `02-policy.ts` tests this empirically with an ALLOW-only policy. Docs also warn that later rules can override earlier ones; `--order-test` checks it.
- **Calldata conditions.** `field_source: 'ethereum_calldata'`, `abi` for just the function, `field: 'approve.amount'` (dotted path) or `field: 'function_name'`. Numeric values are hex strings in the docs' examples.
- **Stateful (cumulative) limits.** Documented as supported (aggregations with `sum`, rolling windows of 1 to 72 hours, up to 10 per app), but only for `eth_signTransaction` and `eth_signUserOperation`, not `eth_sendTransaction`. Values update after signing, so concurrent requests can pass together. Not usable for the send path, and the ERC-20 allowance already caps total spend, so Part 2 does not depend on it.
- **Embedded wallets for signers.** Privy's quickstart sets `createOnLogin: 'all-users'`; the app uses `'users-without-wallets'`. Per the spec nothing is changed until the signer flow shows it is needed.

## Still to do (needs the user)

1. Register the key quorum and set `PRIVY_SIGNER_ID` and `PRIVY_AUTH_PRIVATE_KEY` in `Backend/.env`.
2. Run 01 and 02, then fill in the gate table above.
3. 1.3 also needs the `/dev/privy` page (not built yet) and a logged-in email user.
