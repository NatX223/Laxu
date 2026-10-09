# How Laxu uses Privy

Laxu uses Privy for sign-in and embedded wallets, and goes further for one feature: **loan protection**, where Laxu repays a user's loan *from the user's own wallet*, using a Privy signer limited by a Privy policy. This page says what is built, how it works, its limits, and what evidence exists. Where something has not been run, it says so.

## What Privy does in Laxu

| Capability | Where | Status |
|---|---|---|
| Login (email, wallet, Google) | `App/src/app/providers.tsx` | Built, in use |
| Embedded wallets (`createOnLogin: 'users-without-wallets'`) | same | Built, in use |
| Wallet signing in the browser (viem over the Privy provider) | `App/src/lib/walletClient.ts` | Built, in use |
| Server-verified identity: the backend verifies the access token and reads the user's wallet from Privy; an address in a request body is never trusted | `Backend/src/auth/privy.ts` | Built, in use |
| **Signers + policies (loan protection)** | `Backend/src/privy/`, `Backend/src/services/protection*.ts`, `App/src/components/position/ProtectionCard.tsx` | Built. Signer and policy behaviour measured on Monad testnet in the spike; the full loan-protection run is **not yet done** (see Evidence) |
| Export wallet, link email / wallet (account menu) | `App/src/components/auth/AccountMenu.tsx` | Built; not yet exercised in a browser |
| Server wallets for the faucet and liquidator (Part 3) | n/a | **Not built** |

## Loan protection

### Why it needs a signer
`LendingPool.repay(amount)` repays the **caller's** debt and pulls the asset from the **caller's** wallet. Laxu cannot repay on someone's behalf from its own wallet. The only way is to act *as the user*, which is what a Privy signer is for.

### What the user sets
A trigger health (default 1.15), a target health (default 1.30) and a maximum total spend. The card shows, before anything is asked of Privy:

> Laxu will be allowed to call `repay` on this loan's pool from your wallet, only when your health drops to **{trigger}**, for at most **{per call}** per call and **{total}** in total. It cannot send your funds anywhere else. You can turn this off at any time.

### Two safety layers
1. **Privy's policy limits *what* Laxu can call:** `repay` on that one pool, up to the per-call cap, no native value, on Monad testnet, nothing else.
2. **The ERC-20 allowance limits *how much* it can ever spend:** the user approves exactly their spend limit to the pool, in their own transaction.

### Sequence

```
 user (browser)              Laxu backend                 Privy               Monad
      | POST /protection  ------>|                          |                   |
      |                          |-- create policy -------->|                   |
      |<-- policyId, signer, allowance to approve ----------|                   |
      | 1. addSigners(signerId, [policyId]) ---------------->| (Privy prompt)    |
      | 2. approve(pool, maxSpend) ------------------------------------------->|
      | POST /protection/:id/activate ->|                    |                   |
      |                          |-- is our signer on the wallet, with this policy? ->|
      |                          |-- allowance >= maxSpend? ------------------------>|
      |<-- enabled ---------------|                          |                   |
      |        ... every 5 s: worker reads healthFactor ----------------------->|
      |                          | health <= trigger:        |                   |
      |                          |-- sendTransaction(repay(amount)) -->| policy ok?|
      |                          |                          |-- signs, broadcasts ->|
      |                          |<-- tx hash ---------------|   repay pulls AUSD from the user's wallet
      |<-- event + tx link on the card                                          |
```

The backend never takes the client's word for step 1 or 2: `activate` asks Privy for the wallet's signers and reads the allowance on chain.

### The exact policy

Built by `buildRepayPolicy` (`Backend/src/privy/policies.ts`) and pinned by a unit test. Example for a pool `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` and a 50 AUSD per-call cap:

```json
{
  "name": "laxu-repay-0xa9012a05",
  "version": "1.0",
  "chain_type": "ethereum",
  "owner_id": "<the server key quorum id>",
  "rules": [
    {
      "name": "allow repay(amount <= maxPerCall) on this pool only",
      "method": "eth_sendTransaction",
      "action": "ALLOW",
      "conditions": [
        { "field_source": "ethereum_transaction", "field": "to",       "operator": "eq",  "value": "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" },
        { "field_source": "ethereum_transaction", "field": "chain_id", "operator": "eq",  "value": "10143" },
        { "field_source": "ethereum_transaction", "field": "value",    "operator": "lte", "value": "0x0" },
        { "field_source": "ethereum_calldata", "field": "function_name", "operator": "eq",  "value": "repay", "abi": [ /* repay(uint256) only */ ] },
        { "field_source": "ethereum_calldata", "field": "repay.amount",  "operator": "lte", "value": "0x2faf080", "abi": [ /* repay(uint256) only */ ] }
      ]
    }
  ]
}
```

There is deliberately **no DENY rule**. Measured in the spike: a request that matches no rule is denied, and a DENY-all rule overrides the ALLOW whatever the order, which would block every repay.

### The worker (`ENABLE_PROTECTION=true`)
Every `PROTECTION_INTERVAL_MS` (5 s) it reads `healthFactor` and `currentDebt` for each enabled rule. At or below the trigger, and out of cooldown, it computes the repay (debt minus the debt that sits on the target, plus 1%, clamped by the per-call cap, the remaining spend, the wallet balance and the allowance; below 0.01 AUSD it does nothing) and sends `repay` through Privy with a gas limit from our own estimate plus a buffer. It records what the pool actually took (the `Repaid` event), not what it asked for. A `PENDING` event marks a repay in flight and is settled from the chain after a restart. It never acts on a rule whose signer the backend has not verified, or whose wallet no longer matches the user's.

### Honest limits
- **It needs AUSD in the wallet, and a little MON for gas.** With an empty wallet it cannot act and says so (a "could not act" note on the card).
- **A very fast market move can still liquidate you** between checks. It is a safety net, not a guarantee.
- **One rule per wallet and pool, and one *active* rule per wallet.** A signer carries at most one policy, so adding it for a second loan would replace the first loan's policy. The backend refuses a second active rule.
- **Embedded (email sign-in) wallets only.** Signers attach to Privy wallets, not to MetaMask and the like. Others see "Loan protection needs a Laxu wallet created with email sign-in."
- **The allowance is shared.** The user's own manual repays draw on it too. If the user approves more than their spend limit elsewhere, the on-chain cap is larger than the limit they set (Laxu still stops at the limit itself).
- **Monad bills the gas limit, not the gas used,** so each repay costs its estimated limit plus a buffer, not a bit more than needed.
- **Privy has to be up** for Laxu to act (about 1 s per call). Turning protection off never depends on it: the worker stops the moment the rule is disabled.
- **One backend process runs the worker.** Do not start a second with workers enabled against the same database.
- Policies are not deleted when a rule is turned off: a signer must never outlive its policy. They are inert once the signer is removed.

## Evidence

**Measured on Monad testnet (the spike, `docs/privy-findings.md`):**
- Privy signs and broadcasts: `sendTransaction`, 5 of 5, median 1172 ms.
- Policy enforcement: an allowed `approve` went through; an over-limit amount, a different function (`transfer`), a different target address, a plain value send and `approve` carrying value were each refused with `{"error":"RPC request denied due to policy violation","code":"policy_violation"}`.
- A user's embedded wallet `0xfc7d5c97ec539215fab84a732b74f5dce6833d21` added the server as a signer with a policy attached (through Privy's prompt). The server, using only its own key, then sent an allowed `approve` from that wallet (tx `0x370e8a29a2c5a29fbdfc9a99db1b2b5b7b745e195ab81a1f64af367cb2f7cc8f`) and was refused the forbidden calls. After the user removed the signer, the same call failed with HTTP 401.

**Not yet run (do not read this page as claiming them):**
- An end-to-end loan-protection run on testnet: a real loan near the cap, protection firing, a `REPAID` event with a tx hash, health moving to the target.
- The rejection script against a live protection rule: `npx ts-node --transpile-only scripts/privy/demo-rejection.ts --full` (saves `Backend/.e2e/privy-rejections.json`).
- Screenshots of the card.

## Running it

```
# 1. Apply the migration (adds protection_rules / protection_events)
cd Backend && npx prisma migrate deploy && npx prisma generate

# 2. Backend/.env: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_SIGNER_ID, PRIVY_AUTH_PRIVATE_KEY, ENABLE_PROTECTION=true
#    (PROTECTION_INTERVAL_MS, PROTECTION_COOLDOWN_S, PROTECTION_MAX_SPEND_CAP are optional; see .env.example)
# 3. One backend with workers per database, then sign in with email and open a position page with a loan.
```

The demo path does not need the market to move: set the trigger **above** the loan's current health (for example 1.6 against a health of 1.3) and protection acts at once.
