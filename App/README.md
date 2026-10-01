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
| `src/lib/arcus.ts` | Public Arcus market data (candles, marks) |
| `src/lib/api.ts` | Backend client |

## Known limits

- The main chart and mark price are live Arcus data. The order book, tape and market-menu sparklines are simulated.
- The positions dock's PnL ignores funding.
- The community page shows sample data, labelled as a preview.
