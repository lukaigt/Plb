# Polymarket AI Trading Bot

## Overview
AI-powered trading bot that monitors Polymarket 15-minute crypto price prediction markets (BTC, ETH, SOL, XRP). Uses GLM-4.7-Flash via OpenRouter to analyze price trends, momentum, and orderbook data to decide whether to buy YES (Up) or NO (Down) shares. Markets use "Up/Down" outcomes resolved every 15 minutes.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000 (Replit) or configurable PORT
- **Bot loop** scans markets on interval, gathers data, gets AI predictions, executes trades
- **Web dashboard** shows live activity, AI reasoning, trades, portfolio stats, safety controls
- **Market discovery** via Polymarket Gamma API using slug pattern `{coin}-updown-15m-{timestamp}`
- **Data fetching** via Polymarket CLOB API (free, no auth needed for reads)
- **Trade execution** via CLOB API with wallet-derived API credentials

## Project Structure
```
server.js           - Express server + starts bot loop
src/
  scanner.js        - Discovers 15-min crypto Up/Down markets via Gamma API slug patterns
  dataFetcher.js    - Pulls prices, orderbook, history from CLOB API
  aiEngine.js       - Sends data to GLM-4.7-Flash via OpenRouter, parses decisions
  trader.js         - Places orders on Polymarket via CLOB API with HMAC signing
  safety.js         - Daily loss limits, trade sizing, kill switch
  botLoop.js        - Main loop orchestrating scan -> analyze -> trade
  logger.js         - Logs everything for dashboard display
public/
  index.html        - Dashboard UI
  style.css         - Dashboard styling
  app.js            - Dashboard frontend logic
.env.example        - Template for environment variables
```

## Configuration
All config via `.env` file (see `.env.example`):
- `OPENROUTER_API_KEY` - OpenRouter API key for GLM-4.7-Flash
- `WALLET_PRIVATE_KEY` - Metamask wallet private key for trading
- `MAX_TRADE_SIZE` - Max dollars per trade (default 5)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 15)
- `PORT` - Dashboard port (default 4000)
- `SCAN_INTERVAL` - Seconds between scans (default 120)

## Key Technical Details
- Markets use slug pattern: `{coin}-updown-15m-{YYYYMMDD}T{HHMM}` (e.g., `btc-updown-15m-20260211T1415`)
- Scanner checks adjacent 15-min slots to find active markets with 1-20 minutes remaining
- AI confidence levels: HIGH (full size), MEDIUM (half size), LOW (skip trade)
- Safety: daily loss limit resets at midnight UTC, kill switch stops all trading

## Deployment (VPS)
1. Push to GitHub
2. Pull on VPS
3. `npm install`
4. Create `.env` with your keys
5. `npm start`
6. Dashboard at `http://your-vps-ip:4000`

## User Preferences
- Port 3000 reserved for other bot, using port 4000 for VPS deployment
- VPS deployment via GitHub push/pull
- All keys in .env only, never in code
- Dashboard should show everything the bot and AI are doing
