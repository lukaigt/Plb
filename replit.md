# Soccer Bond Bot

## Overview
This project runs a single trading bot on Polymarket:

**Soccer Live Bond Bot** — Monitors live in-progress soccer/football games. When a YES token midpoint reaches 95¢ (near-certain outcome), automatically buys at that price and holds to $1.00 resolution. Collects a near-risk-free 5¢ yield per trade with full auto-redemption on-chain.

## User Preferences
- Soccer only — no crypto/BTC
- Never deploy on Replit — VPS at port 4000 with pm2 only
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
- Dashboard must show everything the bot is doing
- All credentials in .env only, never in code

## Soccer Bond Strategy

The bot monitors Polymarket soccer/football markets for in-progress games (Gamma API `tag_slug=soccer` + `football` filter, `endDate` within 12h window, `startDate` <= now to exclude pre-kickoff). When a YES token midpoint reaches **BOND_THRESHOLD** (default 95¢), it places a limit buy and holds to $1.00 resolution, collecting the near-risk-free yield. All positions are redeemed on-chain automatically.

**BondSession state machine:** watching → buying → holding → done / lost

- Watches price every 15s (fast loop)
- On resolution, derives winner from Gamma `outcomePrices` (authoritative). Falls back to last mid >= 0.5 only if Gamma data unavailable. Logs `no_fill` if outcome truly cannot be determined.
- On win: session transitions to `phase='redeeming'` — fast loop calls `tryRedeem()` every 15s until confirmed on-chain
- Duplicate guard: once a market is entered (or attempted), it is added to `enteredMarkets` Set and never re-entered even if the session is cleaned up
- Early-game filter: `BOND_MIN_ELAPSED_MINUTES` (default 30) — skip markets where game started less than N minutes ago
- Overlap guard: `isScanRunning` / `isFastRunning` flags prevent concurrent loop executions
- Safety: `safety.canTrade()` checked before every entry; `BOND_MAX_POSITIONS` enforced atomically

**Soccer Bot Config (all in .env):**
- `SOCCER_ENABLED=true` — set to `false` to disable entirely
- `BOND_THRESHOLD=0.95` — buy when YES token reaches this price
- `BOND_ORDER_SIZE=5` — USD per trade
- `BOND_MAX_POSITIONS=5` — max concurrent positions
- `BOND_MIN_VOLUME=5000` — min 24hr market volume to consider
- `BOND_DAILY_MAX_SPEND=50` — daily cap in USD
- `BOND_MIN_ELAPSED_MINUTES=30` — only enter games 30+ minutes old (avoids early lead false signals)

## Technical Implementation
- **Backend**: Node.js + Express server, port 5000 (dev) or 4000 (VPS)
- **Scan Loop**: Every 2 minutes — discovers live soccer/football markets via Gamma API
- **Fast Loop**: Every 15 seconds — polls YES token midpoints, checks fills, checks resolution
- **Order Placement**: Polymarket CLOB V2 SDK (`@polymarket/clob-client-v2` + `viem`). Migrated April 2026.
- **Auto-Redemption**: On-chain via Polygon smart contracts. NegRisk markets use NegRiskAdapter, then fallback to CTF. Non-negRisk tries pUSD first, then USDC.e (legacy fallback for pre-V2 positions).
- **Safety Controls**: Daily loss limit, kill switch, max positions cap, daily spend cap

## CLOB V2 Migration (April 28, 2026)
Polymarket launched CLOB V2, replacing USDC.e with pUSD and deploying new exchange contracts.
- **Collateral**: pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (replaces USDC.e)
- **Exchange V2**: `0xE111180000d2663C0091e4f400237545B87B996B`
- **NegRisk Exchange V2**: `0xe2222d279d744050d28e00520010520000310F59`
- **CTF**: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (UNCHANGED — redemption unaffected)
- **NegRisk Adapter**: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` (UNCHANGED)
- SDK constructor now uses options object `{ host, chain: Chain.POLYGON, signer: viemWalletClient, creds }`
- `feeRateBps`, `expiration`, `taker`, `nonce` removed from order struct. `timestamp` (ms) added by SDK.
- User must wrap USDC.e → pUSD on polymarket.com before new bets can be placed.

## Dashboard
- Live soccer position panel — phase badges (WATCHING / ENTERED / HOLDING / DONE / LOST), mid price, entry price, unrealized P&L, time left
- Soccer Activity log — bond_*/soccer_* events
- Trade History — match name + green badge for every soccer trade
- Auto-Redeem panel — pending/collected/lost positions
- Kill Switch, Scan Wallet, Force Redeem buttons

## Persistent Trade Log
- `src/logger.js` saves all trades to `data/trades.json` on disk, surviving pm2 restarts.
- `getStats()` returns totalFees, netPnL, todayFees, todayNetPnL, exitReasons breakdown.

## Project Structure
- `server.js` — Express server, API routes, starts soccerLoop on boot
- `src/soccerScanner.js` — Gamma API discovery for live soccer/football markets
- `src/bondStrategy.js` — BondSession state machine + resolution + redemption queue
- `src/soccerLoop.js` — Scan loop (2 min) + fast loop (15s)
- `src/trader.js` — CLOB client, order placement, auth
- `src/redeemer.js` — On-chain redemption via Polygon
- `src/positionScanner.js` — Wallet position scanner (manual recovery)
- `src/safety.js` — Kill switch, daily loss limits, trade guards
- `src/logger.js` — Activity + trade log, persistent to disk
- `src/proxy.js` — Optional residential proxy setup
- `public/` — Dashboard HTML, CSS, JavaScript

## External Dependencies
- **Polymarket Gamma API**: Market discovery
- **Polymarket CLOB API (REST)**: Real-time midpoint prices
- **Polymarket CLOB SDK**: Order placement, wallet interaction, order status
- **Polygon Network**: Smart contract interactions and token redemption
- **FlashProxy (optional)**: Residential proxy setup
