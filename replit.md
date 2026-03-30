# Polymarket BTC Hybrid Trader

## Overview
This project is a trading bot designed for Polymarket BTC Up/Down 15-minute markets only (5-minute trading disabled due to poor performance). Its core purpose is to capitalize on BTC momentum signals by taking positions with a fixed take-profit exit. It incorporates profit protection mechanisms and a safety net stop loss to manage risk and lock in gains. The bot focuses exclusively on BTC markets due to their liquidity on Polymarket.

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
- **Order Size**: $5 per trade (configurable via MOM_ORDER_SIZE).

### Technical Implementation
- **Backend**: Node.js with an Express server, providing a dashboard on port 5000 (development) or 4000 (VPS).
- **Bot Loops**: A main loop runs every 10 seconds, and a fast loop runs every 5 seconds for critical tasks like trailing stop management and exit fill status.
- **State Management**: `MomentumSession` objects track the state for each market, including phases, signals, prices, fill statuses, and re-entry counts.
- **Market Discovery**: Uses the Polymarket Gamma API to discover BTC Up/Down markets based on slug patterns.
- **Order Placement**: Utilizes the Polymarket CLOB SDK (`@polymarket/clob-client`) for placing and managing orders.
- **Auto-Redemption**: Positions are automatically redeemed via Polygon smart contracts when markets resolve. For BTC markets (negRisk=true), uses NegRiskAdapter first, then falls back to CTF.
- **Safety Controls**: Includes daily loss limits, a maximum number of daily losing trades, a manual kill switch, and checks to prevent trading at extreme market prices.

### Dashboard
- The dashboard displays live BTC prices, a 15-minute market card showing signal, entry, peak, profit protection status, P&L, and re-entry counts. An activity log provides detailed bot actions. Includes Scan Wallet and Force Redeem buttons for manual position recovery.

### Project Structure Highlights
- `server.js`: Express server and bot loop orchestration.
- `scanner.js`: Market discovery (15m only).
- `momentumStrategy.js`: Core trading strategy logic (MomentumSession class).
- `botLoop.js`: Main and fast bot loop execution.
- `trader.js`: CLOB client interaction, order placement, and authentication.
- `redeemer.js`, `positionScanner.js`: Handle post-resolution tasks.
- `krakenFeed.js`: Real-time BTC price data.
- `public/`: Contains dashboard HTML, CSS, and JavaScript.

## External Dependencies
- **Polymarket Gamma API**: Used for market discovery.
- **Polymarket CLOB API (REST)**: Used for retrieving real-time midpoint prices (`https://clob.polymarket.com/midpoint?token_id={id}`).
- **Polymarket CLOB SDK (`@polymarket/clob-client`)**: Used for wallet interaction, order placement, and order status checks.
- **Kraken WebSocket Feed**: Provides real-time BTC price data for momentum signal generation.
- **Polygon Network**: For smart contract interactions and token redemption.
- **FlashProxy (optional)**: For residential proxy setup.
