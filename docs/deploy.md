# Deploying Laxu

How to run Laxu on Monad testnet: the backend on a Google Cloud VM behind Caddy (HTTPS), the database on Neon, the frontend on Vercel. The contracts are already deployed ([`Contracts/deployments/monadTestnet.json`](../Contracts/deployments/monadTestnet.json)); to deploy your own, see [`Contracts/README.md`](../Contracts/README.md).

Every value below is a placeholder. Never commit a real `.env`.

This guide has not yet been followed end to end on a fresh VM; report anything that does not match.

> **One backend with workers per database.** The indexer, reporter, reconciler, liquidator and protection worker assume they are the only writer. Do not run a second backend with any `ENABLE_*` flag on against the same database, and do not leave a local backend running against the production database.

## 1. Database (Neon)

1. Create a Neon project and database.
2. Copy the **direct** connection string (not the `-pooler` host): Prisma migrations need a direct connection, and the schema has no separate `directUrl`. Keep `?sslmode=require`.
3. From a machine with the repo checked out:

   ```bash
   cd Backend
   npm install                                  # also runs prisma generate
   DATABASE_URL='postgresql://…' npx prisma migrate deploy
   DATABASE_URL='postgresql://…' npm run db:seed   # syncs Perpl's markets into the database
   ```

   `migrate deploy` applies the four migrations in `Backend/prisma/migrations/` and never resets data.

## 2. Backend (GCP VM + Caddy)

### VM

- A small Ubuntu 22.04/24.04 VM (e2-small is enough), with a static external IP.
- Firewall: allow TCP 80 and 443 from anywhere. Do **not** open 4000; only Caddy talks to the API.
- Point a DNS A record (for example `api.<your-domain>`) at the static IP.

```bash
# Node 20 or newer (tested with 22)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

### Code and build

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin laxu
sudo -u laxu git clone <this repository> /home/laxu/laxu
cd /home/laxu/laxu/Backend
sudo -u laxu npm ci
sudo -u laxu npm run build                    # tsc -> dist/
sudo -u laxu cp .env.example .env             # then fill it in (section 4)
sudo chmod 600 .env
```

### systemd

`/etc/systemd/system/laxu-backend.service`:

```ini
[Unit]
Description=Laxu backend
After=network-online.target
Wants=network-online.target

[Service]
User=laxu
WorkingDirectory=/home/laxu/laxu/Backend
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now laxu-backend
journalctl -u laxu-backend -f                 # logs
```

The service reads `Backend/.env` (dotenv). `Restart=always` brings it back after a crash; interrupted opens, closes and settlements resume on boot.

### Caddy (HTTPS)

`/etc/caddy/Caddyfile`:

```
api.<your-domain> {
    reverse_proxy 127.0.0.1:4000
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate itself. With Caddy as the one proxy in front of the API, set `TRUST_PROXY=1` so the faucet's per-IP limit sees the real client address.

### Updating

```bash
cd /home/laxu/laxu && sudo -u laxu git pull
cd Backend && sudo -u laxu npm ci && sudo -u laxu npm run build
DATABASE_URL=… npx prisma migrate deploy      # only when a migration was added
sudo systemctl restart laxu-backend
```

## 3. Frontend (Vercel)

1. Import the repository in Vercel. **Root Directory: `App`.** Framework: Next.js (detected). Build command and output: defaults (`next build`).
2. Set the environment variables in section 4 (Production and Preview). They are all `NEXT_PUBLIC_*` and end up in the browser bundle: never put a secret there.
3. Deploy, and note the production URL (for example `https://laxu.<your-domain>` or `https://<project>.vercel.app`).

Market data: Perpl's REST and market-data WebSocket only accept browser requests from Perpl's own origin, so the app reads market data through the backend's cached proxy (`{NEXT_PUBLIC_API_URL}/market-data/v1/...`). Leave `NEXT_PUBLIC_MARKET_DATA_BASE` empty unless Perpl has allow-listed your origin.

## 4. Environment variables

### Backend (`Backend/.env` on the VM)

`Backend/.env.example` documents each one in place. Required in production unless marked otherwise.

| Variable | Production value / notes |
|---|---|
| `PORT` | `4000` (Caddy proxies to it) |
| `LOG_LEVEL` | `info` |
| `DATABASE_URL` | Neon direct connection string |
| `RPC_URL` | Monad testnet HTTPS RPC (`https://testnet-rpc.monad.xyz` or a provider) |
| `CHAIN_ID` | `10143` |
| `RPC_LOGS_MAX_RANGE` | `100` for the public RPC (optional) |
| `RPC_MAX_RPS` | `12` for the public RPC's 25/s limit (optional; raise for a paid RPC) |
| `GAS_BUFFER_BPS` | `3000` (optional) |
| `ASSET_ADDRESS` | AUSD, `asset` in `monadTestnet.json` |
| `PERPL_READER_ADDRESS`, `POSITION_TOKEN_FACTORY_ADDRESS`, `LENDING_POOL_FACTORY_ADDRESS` | From `monadTestnet.json` |
| `POSITION_TOKEN_FACTORY_DEPLOY_BLOCK`, `LENDING_POOL_FACTORY_DEPLOY_BLOCK` | The `block` of each factory in `monadTestnet.json` |
| `INDEXER_BACKFILL_FROM_BLOCK` | Optional, one-off re-index |
| `OPERATOR_PRIVATE_KEY` | The operator wallet; its address must be the factory's `deployer` |
| `LIQUIDATOR_PRIVATE_KEY` | Separate wallet with no roles; only if `ENABLE_LIQUIDATOR=true` |
| `FLOAT_PRIVATE_KEY` | Optional; defaults to the operator. Must hold AUSD |
| `ASSET_MINTABLE` | `false` (AUSD has no open mint) |
| `PERPL_API_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`, `PERPL_EXCHANGE` | Defaults in `.env.example` are testnet |
| `PERPL_ORIGIN`, `PERPL_ENROLL_ORIGIN` | Only once Perpl has whitelisted your frontend origin (key enrollment) |
| `PERPL_SLIPPAGE_BPS`, `PERPL_ORDER_TIMEOUT_MS`, `PERPL_REQUEST_TIMEOUT_MS`, `PERPL_SLOT_RESERVE`, `PERPL_HEARTBEAT_GAP_RECONNECT`, `PERPL_WS_PING_MS` | Optional tuning; defaults are what was tested |
| `PERPL_RECORD_DIR` | Leave empty in production |
| `PERPL_BUILDER_ENABLED`, `PERPL_BUILDER_ID`, `PERPL_MAX_BUILDER_FEE_PER_100K`, `PERPL_BUILDER_FEE_PER_100K` | `false` / empty / `0` / `0` until Perpl issues a builder id |
| `FUNDING_HEARTBEAT_SECONDS`, `FUNDING_PUSH_MIN`, `FUNDING_PUSH_BPS` | `1800`, `100000`, `10` (optional) |
| `RESERVATION_TIMEOUT_MS`, `DEPOSIT_POLL_INTERVAL_MS`, `RECONCILE_INTERVAL_MS`, `RECONCILE_DRIFT_TOLERANCE`, `INDEXER_CHECKPOINT_INTERVAL_MS`, `REPORTER_INTERVAL_MS`, `MARKET_SYNC_INTERVAL_MS`, `LIQUIDATOR_INTERVAL_MS`, `SETTLEMENT_INTERVAL_MS` | Optional; defaults in `.env.example` |
| `ENABLE_INDEXER`, `ENABLE_RECONCILER`, `ENABLE_REPORTER` | `true` on this one backend |
| `ENABLE_LIQUIDATOR` | `false` unless the liquidator wallet is funded |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | From the Privy dashboard |
| `PRIVY_JWT_VERIFICATION_KEY` | Optional; fetched over JWKS when unset |
| `PRIVY_SIGNER_ID`, `PRIVY_AUTH_PRIVATE_KEY` | Loan protection: the key quorum id and its P-256 private key |
| `PRIVY_TEST_CONTRACT` | Spike scripts only; leave empty |
| `ENABLE_PROTECTION` | `true` to run the protection worker (needs the two signer values above) |
| `PROTECTION_INTERVAL_MS`, `PROTECTION_COOLDOWN_S`, `PROTECTION_MAX_SPEND_CAP` | `5000`, `60`, `500000000` (optional) |
| `TRUST_PROXY` | `1` behind Caddy |
| `ADMIN_TOKEN` | Optional long random string; unset disables `/admin` |
| `FAUCET_ENABLED` | `true` for a public testnet demo |
| `FAUCET_PRIVATE_KEY` | Its own wallet, funded with MON; never an operator, slot or float key |
| `FAUCET_ASSET_MODE`, `FAUCET_EXTERNAL_ADDRESS`, `FAUCET_EXTERNAL_AMOUNT`, `FAUCET_ASSET_AMOUNT`, `FAUCET_NATIVE_TARGET_WEI`, `FAUCET_COOLDOWN_HOURS`, `FAUCET_NATIVE_MIN_RESERVE_WEI` | Defaults in `.env.example` (Perpl's AUSD faucet, MON top-up to 0.5) |
| `SLOT_COUNT`, `SLOT_MIN_GAS_WEI` | Number of slots to provision; MON each slot wallet needs |
| `SECRET_SLOT_<n>_EVM`, `PERPL_API_KEY_<n>`, `SECRET_SLOT_<n>_API` | Per slot (section 6) |
| `EXPLORER_URL` | Optional, for script output |

### Frontend (Vercel project settings)

| Variable | Production value / notes |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Same Privy app as the backend |
| `NEXT_PUBLIC_CHAIN_ID` | `10143` |
| `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_RPC_WS_URL` | Monad testnet HTTPS and WSS RPC |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://testnet.monadvision.com` |
| `NEXT_PUBLIC_ASSET_ADDRESS` | AUSD; must equal the backend's `ASSET_ADDRESS` |
| `NEXT_PUBLIC_API_URL` | `https://api.<your-domain>` |
| `NEXT_PUBLIC_MARKET_DATA_BASE` | Empty (use the backend proxy) |
| `NEXT_PUBLIC_PERPL_API_URL`, `NEXT_PUBLIC_PERPL_WS_URL`, `NEXT_PUBLIC_PERPL_APP_URL` | Testnet defaults from `App/.env.example` |
| `NEXT_PUBLIC_MON_FAUCET_URL` | `https://faucet.testnet.monad.xyz` (optional) |
| `NEXT_PUBLIC_ENABLE_PROTECTION` | `true` to show the Protect this loan card (backend needs `ENABLE_PROTECTION=true`) |
| `NEXT_PUBLIC_PRIVY_SIGNER_ID` | Only for the dev signer page; it is an id, not a key |
| `NEXT_PUBLIC_DEV_TOOLS` | Leave unset in production |

## 5. Privy origins and backend CORS

- **Privy:** in the Privy dashboard, under the app's allowed origins (domains), add the Vercel production URL (and `http://localhost:3000` for local work). Once allowed origins are set, Privy refuses sign-in from any other origin. Enable email login (loan protection needs an embedded wallet) and embedded wallets for users without one.
- **Loan protection:** register the server's authorization key as a key quorum (threshold 1) in the dashboard; its id is `PRIVY_SIGNER_ID`. `Backend/scripts/privy/00-create-signer.ts` can generate the key pair and writes its backup outside the repository.
- **Backend CORS:** the API currently answers every origin (`app.use(cors())` in `Backend/src/index.ts`). It uses no cookies: every authenticated call carries the user's Privy access token, which the backend verifies, so another origin cannot act as a user without that token. There is no origin allowlist setting yet; restricting CORS to the Vercel URL needs a small code change.

## 6. Provisioning slots

Each open position runs on its own slot: a wallet that owns one Perpl account. Full detail: [`docs/slot-provisioning.md`](slot-provisioning.md).

1. Create one EVM wallet per slot. Put its key in `SECRET_SLOT_<n>_EVM`, send it about 0.5 MON, and set `SLOT_COUNT`.
2. Make sure the float wallet (the operator, unless `FLOAT_PRIVATE_KEY` is set) holds 100 AUSD per new slot: Perpl's minimum account open, which stays in the slot as its reserve.
3. Run `npm run slots:provision` (idempotent). For each slot it creates the Perpl account, approves the exchange and turns on order forwarding.
4. API keys, one per slot (trade scope):
   - **Today:** import the slot wallet into a browser wallet, create a key at <https://testnet.perpl.xyz/apikeys>, and set `PERPL_API_KEY_<n>` and `SECRET_SLOT_<n>_API`.
   - **Once Perpl whitelists the origin:** `npm run slots:enroll -- --all --verify` writes the keys to `Backend/secrets/slot-keys.json` (mode 0600, gitignored) and prints only variable names. Copy them into `.env`.
5. Run `npm run slots:provision` again to store each key on its slot row, then `sudo systemctl restart laxu-backend`.

## 7. Post-deploy check

```bash
curl -s https://api.<your-domain>/health
# {"status":"ok","slots":{...,"free":N},"laxuFeePct":0}

curl -s https://api.<your-domain>/health/ready
# 200 with checks.database "ok", slots, slotProblems [], float balance,
# faucet balances, tradingSockets, fundingAgeSeconds per open position

curl -s https://api.<your-domain>/markets | head -c 300
# the eight Perpl markets, status ONLINE
```

Then, in the browser on the Vercel URL:

1. Sign in with email.
2. **Get test funds** sends AUSD and MON.
3. The trade screen shows live prices and no "all slots busy" banner.
4. Open a small position (at least 10 AUSD) and confirm it reaches the position page with its pool ready.
5. Watch `journalctl -u laxu-backend` for `funding applied` within 30 minutes of the open, and check `fundingAgeSeconds` in `/health/ready` stays under 7200.

If `/health/ready` answers 503, the database is unreachable: check `DATABASE_URL` and Neon's status. If `slots.free` is 0, provision more slots or wait for positions to close.
