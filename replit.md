# Polymarket BTC + Soccer Bond Bot

## Overview
This project runs two concurrent trading bots on Polymarket:

1. **BTC Momentum Bot** — Trades 15-minute BTC Up/Down markets using momentum signals. Fixed take-profit at 70¢, trailing stop protection, 18¢ safety-net stop loss.

2. **Soccer Live Bond Bot** — Monitors live in-progress soccer/football games. When a YES token midpoint reaches 95¢ (near-certain outcome), automatically buys at that price and holds to $1.00 resolution. This strategy collects a near-risk-free 5¢ yield with auto-redemption via the existing redeemer.js infrastructure.

## User Preferences
- BTC only — deepest markets, highest volume
- Never deploy on Replit — VPS at port 4000 with pm2 only
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
- Dashboard must show everything the bot is doing
- Kraken WebSocket for real BTC price (no API key needed)
- All credentials in .env only, never in code

## System Architecture

### Core Strategy: Take Profit at 70¢ with Profit Protection
The bot's strategy targets a fixed take-profit exit:
- **Take Profit**: Sells immediately when token price reaches 70¢ (configurable via MOM_TAKE_PROFIT). This is the primary exit — no waiting for resolution.
- **Profit Protection**: A trailing stop activates when the token price is 10¢ or more above the entry price (MOM_TRAILING_ACTIVATE=0.10). The trailing stop trails 5¢ below the peak (MOM_TRAILING_STOP=0.05), but never drops below the initial entry price. With 10¢ activate and 5¢ trail, the stop floor starts at entry+5¢, giving real breathing room.
- **Stop Loss**: A wide 18¢ stop loss acts as a safety net.
- **Re-entry**: After a profitable exit, the bot attempts to re-enter based on a live BTC momentum signal (not a blind opposite-side trade).
- **Session Phases**: Each market window transitions through `waiting`, `entering`, `managing` (which includes `HOLDING` and `PROTECTING` states), `exiting`, `flipping`, `closing`, and `done` phases.
- **Signal Detection**: 15m markets use ±0.05% BTC 3-min change.
- **Markets**: 15-minute BTC markets only (5-minute disabled).
- **Order Size**: $5 fixed (MOM_ORDER_SIZE) or % of wallet balance (MOM_ORDER_PCT, clamped to MOM_ORDER_PCT_MIN/MAX).
- **Volatility Filter**: Entry skipped when BTC 1m and 3m momentum signals disagree (MOM_VOL_FILTER=true by default).
- **Fee Tracking**: Each trade estimates a 2% fee per side; cumulative fees and net P&L (gross minus fees) are tracked per session and displayed on the dashboard.

### Technical Implementation
- **Backend**: Node.js with an Express server, providing a dashboard on port 5000 (development) or 4000 (VPS).
- **Bot Loops**: A main loop runs every 10 seconds, and a fast loop runs every 5 seconds for critical tasks like trailing stop management and exit fill status.
- **State Management**: `MomentumSession` objects track the state for each market, including phases, signals, prices, fill statuses, and re-entry counts.
- **Market Discovery**: Uses the Polymarket Gamma API to discover BTC Up/Down markets based on slug patterns.
- **Order Placement**: Utilizes the Polymarket CLOB SDK (`@polymarket/clob-client`) for placing and managing orders.
- **Auto-Redemption**: Positions are automatically redeemed via Polygon smart contracts when markets resolve. For BTC markets (negRisk=true), uses NegRiskAdapter first, then falls back to CTF.
- **Safety Controls**: Includes daily loss limits, a maximum number of daily losing trades, a manual kill switch, and checks to prevent trading at extreme market prices.

### Dashboard
- The dashboard displays live BTC prices, a 15-minute market card showing signal, entry, peak, profit protection status, unrealized/cumulative gross P&L, estimated fees, net P&L (after fees), and re-entry counts. An activity log provides detailed bot actions. Includes Scan Wallet and Force Redeem buttons for manual position recovery.

### Persistent Trade Log
- `src/logger.js` saves all trades to `data/trades.json` on disk, surviving pm2 restarts.
- `getStats()` returns totalFees, netPnL, todayFees, todayNetPnL, and exitReasons breakdown.
- `MomentumSession` accumulates `cumulativeFees` and `cumulativeNetPnl` per session window.

### Soccer Live Bond Bot Strategy
The soccer bot monitors Polymarket soccer/football markets for in-progress games (using the Gamma API `tag_slug=soccer/football` filter and `endDate` proximity). When a YES token midpoint reaches **BOND_THRESHOLD** (default 95¢), it places a limit buy order and holds to $1.00 resolution, collecting the near-risk-free yield. All soccer positions are tracked through the existing redeemer.js infrastructure for on-chain collection.

**Soccer Bot Config (all in .env):**
- `SOCCER_ENABLED=true` — set to `false` to disable entirely
- `BOND_THRESHOLD=0.95` — buy when YES token reaches this price
- `BOND_ORDER_SIZE=5` — USD per trade
- `BOND_MAX_POSITIONS=5` — max concurrent positions
- `BOND_MIN_VOLUME=5000` — min 24hr market volume to consider
- `BOND_DAILY_MAX_SPEND=50` — daily cap in USD

**Soccer Bot Files:**
- `src/soccerScanner.js` — Gamma API query for live soccer markets (12h window, soccer+football tags)
- `src/bondStrategy.js` — BondSession class (watching → buying → holding → done/lost)
- `src/soccerLoop.js` — Scan loop (2 min) + fast loop (15s) separate from botLoop.js

### Dashboard Bug Fixes Applied
1. **Positions panel fix**: `/api/positions` previously wrapped result in `{scan: ...}`, now returns `positionScanner.getScanResult()` directly. The broken `updatePositions()` call (which targeted non-existent DOM elements) was removed from refreshAll() since `updateRedemptions()` already handles the redeemPanel correctly.
2. **Dead 5m card removed**: The permanently-idle 5-minute market card was replaced by the Soccer Bond panel.
3. **Trade table market column**: Now detects `strategy === 'soccer_bond'` trades and displays them with the match name instead of "BTC-undefined".

### Project Structure Highlights
- `server.js`: Express server and bot loop orchestration (now includes soccerLoop startup).
- `scanner.js`: Market discovery (15m BTC only).
- `momentumStrategy.js`: Core BTC trading strategy logic (MomentumSession class).
- `botLoop.js`: Main and fast BTC bot loop execution.
- `trader.js`: CLOB client interaction, order placement, and authentication.
- `redeemer.js`, `positionScanner.js`: Handle post-resolution tasks.
- `krakenFeed.js`: Real-time BTC price data.
- `soccerScanner.js`: Gamma API discovery for live soccer markets.
- `bondStrategy.js`: Soccer bond session state machine.
- `soccerLoop.js`: Independent soccer scan + fast loops.
- `public/`: Contains dashboard HTML, CSS, and JavaScript.

## External Dependencies
- **Polymarket Gamma API**: Used for market discovery.
- **Polymarket CLOB API (REST)**: Used for retrieving real-time midpoint prices (`https://clob.polymarket.com/midpoint?token_id={id}`).
- **Polymarket CLOB SDK (`@polymarket/clob-client`)**: Used for wallet interaction, order placement, and order status checks.
- **Kraken WebSocket Feed**: Provides real-time BTC price data for momentum signal generation.
- **Polygon Network**: For smart contract interactions and token redemption.
- **FlashProxy (optional)**: For residential proxy setup.
