# Polymarket AI Trading Bot

## Overview
AI-powered trading bot that monitors Polymarket 15-minute crypto price prediction markets (BTC, ETH, SOL, XRP). Uses GLM-4.7-Flash via OpenRouter to analyze price trends, momentum, and orderbook data to decide whether to buy YES or NO shares.

## Architecture
- **Node.js + Express** backend serving dashboard on configurable port (default 4000)
- **Bot loop** scans markets on interval, gathers data, gets AI predictions, executes trades
- **Web dashboard** shows live activity, AI reasoning, trades, portfolio stats, safety controls

## Project Structure
```
server.js           - Express server + starts bot loop
src/
  scanner.js        - Discovers 15-min crypto markets via Gamma API
  dataFetcher.js    - Pulls prices, orderbook, history from CLOB API
  aiEngine.js       - Sends data to GLM-4.7-Flash, parses decisions
  trader.js         - Places orders on Polymarket via CLOB API
  safety.js         - Daily loss limits, trade sizing, kill switch
  botLoop.js        - Main loop orchestrating scan -> analyze -> trade
  logger.js         - Logs everything for dashboard display
public/
  index.html        - Dashboard UI
  style.css         - Dashboard styling
  app.js            - Dashboard frontend logic
```

## Configuration
All config via `.env` file (see `.env.example`):
- `OPENROUTER_API_KEY` - OpenRouter API key
- `WALLET_PRIVATE_KEY` - Metamask wallet private key
- `MAX_TRADE_SIZE` - Max dollars per trade (default 5)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 15)
- `PORT` - Dashboard port (default 4000)
- `SCAN_INTERVAL` - Seconds between scans (default 120)

## Deployment (VPS)
1. Push to GitHub
2. Pull on VPS
3. `npm install`
4. Create `.env` with your keys
5. `npm start`
6. Dashboard at `http://your-vps-ip:4000`

## User Preferences
- Port 3000 reserved for other bot, using port 4000
- VPS deployment via GitHub push/pull
- All keys in .env only, never in code
