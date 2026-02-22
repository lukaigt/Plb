# Polymarket 5-Min BTC Scalper Bot

## Overview
End-of-window scalping bot for Polymarket BTC 5-minute price prediction markets. Buys high-probability tokens ($0.88-$0.95) in the final 30-90 seconds before market resolution. Strategy: when either UP or DOWN token is priced $0.88-$0.95 with 30-90s left, auto-buy that token for $5, collect $1.00 payout at resolution. Target: ~40 trades/day at 95% win rate = ~$11/day (~$330/month).

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000 (Replit) / port 4000 (VPS)
- **Bot loop** scans every 5 seconds for scalp opportunities
- **Web dashboard** shows 5-min countdown, UP/DOWN token prices, scalp signal status, trade history
- **Market discovery** via Polymarket Gamma API using slug pattern `btc-updown-5m-{timestamp}`
- **Data fetching** via Polymarket CLOB API (free, no auth needed for reads)
- **Trade execution** via CLOB API with wallet-derived API credentials
- **Proxy support** via FlashProxy Brazil residential proxy for Cloudflare bypass

## Strategy: 5-Min End-of-Window Scalper
- **Trigger**: 30-90 seconds remaining AND either UP or DOWN token priced $0.88-$0.95
- **Action**: Buy that token (it's the high-probability winner)
- **Entry price**: $0.88-$0.95 per token (configurable via MIN_ENTRY_PRICE/MAX_ENTRY_PRICE)
- **Payout**: $1.00 per token on win → profit of $0.05-$0.12 per token
- **Confidence**: HIGH when price >= $0.92, MEDIUM when $0.88-$0.91
- **Win rate target**: ~95% (token price reflects market probability)
- **Risk**: lose full $5 bet on loss (~5% of trades)
- **Max 1 trade per 5-min window** — prevents doubling down
- **Why it works**: Token price IS the probability. $0.92 token = 92% chance of winning. Only buy high-probability outcomes late in window when less time for reversal.

## Safety Controls
- **Max 1 trade per 5-minute window** — no doubling down
- **Min entry $0.88** — only high-probability tokens
- **Max entry $0.95** — ensures reasonable profit margin
- **Max 6 LOSING trades per day** — bot stops after 6 losses (keeps going if winning)
- **Daily loss limit** — stops trading when cumulative losses hit $25 (configurable)
- **Kill switch** — manual stop via dashboard
- **LOW confidence = automatic SKIP** — only MEDIUM and HIGH confidence trade

## Project Structure
```
server.js           - Express server + starts bot loop
src/
  scanner.js        - Discovers BTC 5-min Up/Down market via Gamma API
  scalpSignal.js    - Evaluates scalp opportunity: time + price check
  krakenFeed.js     - Kraken WebSocket BTC price + 5-min window tracking
  botLoop.js        - Scalp loop: scan → signal → trade
  dataFetcher.js    - Pulls prices, orderbook from CLOB API
  trader.js         - Places orders on Polymarket via CLOB API with HMAC signing
  safety.js         - Loss-based stop (6 losses), money limit, window dedup, kill switch
  redeemer.js       - Auto-redeems winning positions from resolved markets
  positionScanner.js - Scans wallet for existing unredeemed positions
  logger.js         - Logs everything for dashboard display
  proxy.js          - FlashProxy residential proxy setup
public/
  index.html        - Dashboard UI with 5-min countdown + scalp signals
  style.css         - Dashboard styling (green theme for scalper)
  app.js            - Dashboard frontend logic
```

## Configuration
All config via `.env` file:
- `WALLET_PRIVATE_KEY` - Metamask wallet private key for trading
- `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` - CLOB API credentials
- `MAX_TRADE_SIZE` - Max dollars per trade (default 5)
- `MIN_ENTRY_PRICE` - Min entry price (default 0.88)
- `MAX_ENTRY_PRICE` - Max entry price (default 0.95)
- `SCALP_MIN_SECONDS` - Min seconds left to enter (default 30)
- `SCALP_MAX_SECONDS` - Max seconds left to enter (default 90)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 25)
- `MAX_DAILY_LOSSES` - Max losing trades per day (default 6)
- `PORT` - Dashboard port (default 5000 on Replit, 4000 on VPS)
- `SCAN_INTERVAL` - Seconds between scans (default 5)
- `PROXY_URL` - FlashProxy SOCKS5 proxy URL
- `POLYGON_RPC_URL` - Polygon RPC URL for contract calls

## Key Technical Details
- BTC ONLY — focused on single asset for quality
- 5-min markets use slug pattern `btc-updown-5m-{unix_timestamp}` where timestamp is start of 5-min slot
- Token price from Gamma API outcomePrices field directly reflects win probability
- Window tracking via Kraken WebSocket for BTC price + 5-min slot timing
- Safety stops after 6 LOSSES not 6 trades — winning streaks continue
- signatureType=0 for EOA/MetaMask wallets
- Dashboard shows 5-min countdown, token prices, scalp signal status

## Recent Changes (Feb 22, 2026)
- **COMPLETE STRATEGY REBUILD**: Replaced Cross-Open + Contrarian with 5-Min End-of-Window Scalper
  - Old strategies: Cross-Open Fade + Late Contrarian on 15-min markets → complex, lower win rate
  - New strategy: Simple scalper buying high-probability tokens ($0.88-$0.95) with 30-90s left → 95% win rate target
  - Switched from 15-min to 5-min markets for higher trade frequency
  - Removed spikeDetector.js — no longer detecting spikes
  - Created scalpSignal.js — simple time + price check
  - Scanner now uses 5-min slot timestamps
  - KrakenFeed tracks 5-min windows instead of 15-min
  - Dashboard redesigned with green theme, scalp-focused UI
  - Safety limits updated: $25 daily loss limit, $0.88-$0.95 entry range

## User Preferences
- BTC only for better quality decisions
- All keys in .env only, never in code
- Dashboard must show EVERYTHING the bot thinks and does
- Kraken WebSocket for real BTC price (no API key needed)
- Bot stops after 6 losses, keeps going if winning
- User deploys to VPS at port 4000 with pm2 ONLY — never deploy on Replit
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
