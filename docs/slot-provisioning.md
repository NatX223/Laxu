# Slot provisioning

A **slot** is one wallet that owns one Perpl exchange account. Each Laxu position runs on its own slot while it is open; the slot is freed and reused after settlement. The backend signs every Perpl request and the trading-socket sign-in with the slot's API key.

With programmatic key enrollment (Spec 06 Part 4), adding a slot is a few commands and no clicks in Perpl's web UI. **Status: the enrollment script is ready but blocked.** Perpl must first whitelist the `Origin` we enroll from (see the last section).

## What you need

- A fresh EVM wallet for the slot, with about 0.5 MON for gas. The float wallet supplies the account's minimum deposit.
- `Backend/.env` with the usual chain and Perpl settings, plus `PERPL_ENROLL_ORIGIN`.

## Steps

1. **Wallet key.** Put the slot wallet's private key in `Backend/.env` as `SECRET_SLOT_<n>_EVM`. Send it about 0.5 MON.

2. **Account, approval, forwarding** (`npm run slots:provision`). This is idempotent. For every slot `n` it:
   - creates the Perpl account with the minimum open amount (topped up from the float wallet), which is the minimum deposit Perpl requires;
   - approves the Exchange for the collateral;
   - turns on order forwarding (`allowOrderForwarding(true)`), which Perpl requires before it accepts API orders;
   - stops at the API key step if `PERPL_API_KEY_<n>` / `SECRET_SLOT_<n>_API` are not set yet.

3. **Enroll the API key.**

   ```
   cd Backend
   npm run slots:enroll -- --slot <n> --dry-run     # payload only: prints what the wallet would sign
   npm run slots:enroll -- --slot <n> --verify      # enroll, then one signed read + one socket sign-in
   ```

   - Generates a fresh Ed25519 key pair, requests the EIP-712 payload, signs it with the slot wallet and the new key (proof of possession), and enrolls it with scope 3 (read and trade; Perpl never lets a key withdraw).
   - Writes the new token and secret to `Backend/secrets/slot-keys.json` (mode 0600, gitignored). **Nothing secret is printed**; the script prints the variable names to copy.
   - Use `--all` for every slot, `--label`, `--scope`, and `--builder-id N --max-fee N` for a builder-bound key (Part 5). `--verify-only` re-checks keys already in the file.

4. **Use the key.** Copy `PERPL_API_KEY_<n>` and `SECRET_SLOT_<n>_API` from `secrets/slot-keys.json` into `Backend/.env`. Then run `npm run slots:provision` again: it stores the new token on the slot's database row (the token lives on `subaccount_slots.api_key`; the secret stays in the env). Restart **the one** backend that runs workers, and check `/health` shows the slot healthy.

## Replacing a running slot's key

- Do not swap a key the running backend uses until the new key has passed `--verify`.
- Old keys stay valid after the switch. The API cannot list or revoke keys; revoke old ones in Perpl's web UI at `/apikeys` (testnet: https://testnet.perpl.xyz/apikeys).
- A wallet can hold at most **16 active keys**. Enrollment then fails with `423`, and the script says to revoke one in the UI.
- A revoked public key can never be enrolled again, so the script always generates a new pair. On a `409` it retries with another fresh pair.
- `--verify` opens one extra trading socket for the wallet. Perpl caps trading sockets per wallet (shared by every key of that wallet and any browser session), so do not run it for one wallet many times in parallel.

## Options deliberately not set

- `ip_cidrs`: the hosted backend's IP may change.
- `expires_at`: slot keys never expire.

## What Perpl has to do first

Both `/v1/api-key/payload` and `/v1/api-key/enroll` reject requests whose `Origin` Perpl has not whitelisted. Until Perpl confirms ours, even `--dry-run` is expected to fail with an origin error. Perpl also records the origin on the key (`ApiKeyInfo.origin`). Ask Perpl to whitelist:

- the hosted frontend origin (for example `https://<our-domain>`), which is also what `PERPL_ENROLL_ORIGIN` is set to for server-side runs. The docs say a server must set the `Origin` header explicitly, and it must be a whitelisted one.

For builder attribution (Part 5), Perpl also issues a builder id (1–255), and every slot key must then be **re-enrolled** with `--builder-id`. A builder id cannot be added to an existing key.
