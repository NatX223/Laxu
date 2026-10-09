# Laxu App

The Laxu frontend: Next.js 16, React 19, Privy (auth and embedded wallets), viem, and TradingView Lightweight Charts.

For what Laxu is and how it works, see the [root README](../README.md) and the [litepaper](../docs/LITEPAPER.md).

## Run it

```bash
npm install
cp .env.example .env.local   # variables are listed in the root README, "Run it locally → Frontend"
npm run dev                  # http://localhost:3000
```

The app expects the Laxu backend at `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`).

## Layout

| Path | What it is |
|---|---|
| `src/app/` | Routes: landing (`page.tsx`), `trade`, `position`, `community` |
| `src/components/trade/` | Trade screen: chart, order ticket, book, positions dock |
| `src/components/position/` | Position page: borrow/repay, buy-in/redeem, stop-loss/take-profit panel |
| `src/components/faucet/` | "Get test funds" |
| `src/lib/actions.ts` | Contract writes; checks `LendingPool` reverts (e.g. "exceeds LTV", stale prices) before the wallet prompt |
| `src/lib/perplMarketData.ts` | Perpl public market data (candles, book, ticker), read through the backend's proxy |
| `src/lib/api.ts` | Backend client |

## Known limits

- The **Protect this loan** card is hidden unless `NEXT_PUBLIC_ENABLE_PROTECTION=true`, and has not yet been walked through in a browser.
- Perpl allows browser reads only from its own origin, so market data goes through the backend's proxy (`GET {API_URL}/market-data/v1/...`) unless `NEXT_PUBLIC_MARKET_DATA_BASE` is set.
