# Polymarket Multi-Coin 5-Min Scalper Bot

## Overview
End-of-window scalping bot for Polymarket 5-minute price prediction markets across BTC, ETH, SOL, and XRP. Buys high-probability tokens ($0.85-$0.95) in the final 15-120 seconds before market resolution. Strategy: when either UP or DOWN token is priced $0.85-$0.95 with 15-120s left, auto-buy that token for $5, collect $1.00 payout at resolution. 4 coins = 4x more opportunities. Target: ~160 signals/day at 95% win rate.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000 (Replit) / port 4000 (VPS)
- **Bot loop** scans every 5 seconds for scalp opportunities
- **Web dashboard** shows 5-min countdown, UP/DOWN token prices, scalp signal status, trade history
- **Market discovery** via Polymarket Gamma API using slug pattern `btc-updown-5m-{timestamp}`
- **Data fetching** via Polymarket CLOB API (free, no auth needed for reads)
- **Trade execution** via CLOB API with wallet-derived API credentials
- **Proxy support** via FlashProxy Brazil residential proxy for Cloudflare bypass

## Strategy: 5-Min End-of-Window Scalper
- **Trigger**: 15-120 seconds remaining AND either UP or DOWN token priced $0.85-$0.95
- **Action**: Buy that token (it's the high-probability winner)
- **Entry price**: $0.85-$0.95 per token (configurable via MIN_ENTRY_PRICE/MAX_ENTRY_PRICE)
- **Payout**: $1.00 per token on win → profit of $0.05-$0.15 per token
- **Confidence**: HIGH when price >= $0.90, MEDIUM when $0.85-$0.89
- **Win rate target**: ~95% (token price reflects market probability)
- **Risk**: lose full $5 bet on loss (~5% of trades)
- **Max 1 trade per coin per 5-min window** — prevents doubling down, but can trade BTC AND ETH in same window
- **Why it works**: Token price IS the probability. $0.90 token = 90% chance of winning. Only buy high-probability outcomes late in window when less time for reversal.

## Safety Controls
- **Max 1 trade per coin per 5-minute window** — no doubling down on same coin, but can trade multiple coins per window
- **Min entry $0.85** — only high-probability tokens
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
- `MIN_ENTRY_PRICE` - Min entry price (default 0.85)
- `MAX_ENTRY_PRICE` - Max entry price (default 0.95)
- `SCALP_MIN_SECONDS` - Min seconds left to enter (default 15)
- `SCALP_MAX_SECONDS` - Max seconds left to enter (default 120)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 25)
- `MAX_DAILY_LOSSES` - Max losing trades per day (default 6)
- `PORT` - Dashboard port (default 5000 on Replit, 4000 on VPS)
- `SCAN_INTERVAL` - Seconds between scans (default 5)
- `PROXY_URL` - FlashProxy SOCKS5 proxy URL
- `POLYGON_RPC_URL` - Polygon RPC URL for contract calls

## CRITICAL RULE: Always Use CLOB API for Live Prices
- **NEVER use Gamma API outcomePrices for trading decisions** — they are cached/stale (~$0.50/$0.50)
- **ALWAYS fetch live prices from CLOB API** using `getMarketPrice(tokenId)` from `src/dataFetcher.js`
- The CLOB API endpoint is `https://clob.polymarket.com/price?token_id={id}&side=BUY`
- Pattern: scanner finds market via Gamma API → fetch LIVE prices from CLOB API → evaluate signal with live prices
- This was a critical bug that caused zero trades for hours — Gamma prices never update fast enough for scalping

## Key Technical Details
- Multi-coin: BTC, ETH, SOL, XRP — all use same slug pattern and strategy
- 5-min markets use slug pattern `{coin}-updown-5m-{unix_timestamp}` where timestamp is start of 5-min slot
- Token price from CLOB API reflects live win probability
- Window tracking via Kraken WebSocket for BTC price + 5-min slot timing
- Safety stops after 6 LOSSES not 6 trades — winning streaks continue
- Per-coin window dedup: bot can trade BTC AND ETH in same 5-min window (max 1 per coin per window)
- signatureType=0 for EOA/MetaMask wallets
- Dashboard shows 5-min countdown, token prices, scalp signal status

## Recent Changes (Feb 22, 2026)
- **CRITICAL FIX: Live CLOB prices** — Bot was using stale Gamma API prices (~$0.50/$0.50) instead of real-time CLOB API prices. Now fetches live orderbook prices for both UP and DOWN tokens every scan cycle. This was the reason zero trades were happening.
- **Entry range widened**: $0.85-$0.95 (was $0.88-$0.95) and window 15-120s (was 30-90s)
- **Confidence threshold**: HIGH at $0.90+ (was $0.92+), MEDIUM at $0.85-$0.89
- **Price logging**: Dashboard logs now show Gamma vs CLOB prices side-by-side for verification
- **COMPLETE STRATEGY REBUILD**: Replaced Cross-Open + Contrarian with 5-Min End-of-Window Scalper
  - New strategy: Simple scalper buying high-probability tokens ($0.85-$0.95) with 15-120s left → 95% win rate target
  - Switched from 15-min to 5-min markets for higher trade frequency
  - Scanner now uses 5-min slot timestamps
  - KrakenFeed tracks 5-min windows instead of 15-min
  - Dashboard redesigned with green theme, scalp-focused UI
  - Safety limits updated: $25 daily loss limit, $0.85-$0.95 entry range

## User Preferences
- BTC only for better quality decisions
- All keys in .env only, never in code
- Dashboard must show EVERYTHING the bot thinks and does
- Kraken WebSocket for real BTC price (no API key needed)
- Bot stops after 6 losses, keeps going if winning
- User deploys to VPS at port 4000 with pm2 ONLY — never deploy on Replit
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
