# Polymarket Cross-Open + Contrarian Trading Bot — BTC Only

## Overview
Dual-strategy trading bot for Polymarket BTC 15-minute price prediction markets. Uses CROSS-OPEN FADE (only fade spikes that cross the opening price) and LATE CONTRARIAN (buy cheap underdog when lead is small late in window). Both strategies exploit Polymarket's binary outcome structure for positive expected value.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000
- **Bot loop** runs dual strategy (Cross-Open + Contrarian) every 10 seconds
- **Web dashboard** shows window status, BTC vs opening price, cross-open detection, strategy signals, full activity log
- **Market discovery** via Polymarket Gamma API using slug pattern `btc-updown-15m-{timestamp}`
- **Data fetching** via Polymarket CLOB API (free, no auth needed for reads)
- **Trade execution** via CLOB API with wallet-derived API credentials
- **Proxy support** via FlashProxy Brazil residential proxy for Cloudflare bypass

## Dual Strategy System

### Strategy 1: CROSS-OPEN FADE (Primary)
- **Trigger**: BTC spikes $30+ AND the spike crosses the opening price line (BTC was on one side, spike pushed it to the other)
- **Action**: Buy the side BTC was on BEFORE the spike (bet on reversion back to original side)
- **Why it works**: BTC was naturally sitting on one side of opening. Spike artificially pushed it across. Mean reversion takes it back to original side = Polymarket win.
- **Key difference from old FADE**: Old FADE faded ALL spikes (failed because partial reversion doesn't flip Polymarket outcome). New version ONLY fades cross-open spikes where normal reversion actually wins.
- **Confidence**: HIGH when cross-open + decelerating, MEDIUM when cross-open + stable, LOW when accelerating (skip)
- **Win rate**: ~55-65% (reversion to pre-spike side)
- **Entry**: $0.25-0.40 range (token just flipped from favorite to underdog)

### Strategy 2: LATE CONTRARIAN (Secondary)
- **Trigger**: 2-5 minutes remaining AND BTC lead is SMALL ($20-60 from opening) AND losing side token is cheap ($0.10-$0.40)
- **Action**: Buy the LOSING side (the cheap underdog token)
- **Why it works**: Small lead + little time = BTC easily fluctuates $30-50 and crosses back. Losing token is cheap so risk/reward is 3-6x. Only need 25-30% win rate to profit.
- **Confidence**: HIGH when lead ≤$35 + 3min+ left + entry ≤$0.30, MEDIUM otherwise
- **Win rate**: ~30-40% but payout is 3-6x so still profitable

### Why This Strategy Is Different
- **Old momentum bot**: Bought after spike direction → 15-35% win rate → lost money
- **Old FADE bot**: Faded ALL spikes → partial reversion doesn't flip Polymarket outcome → lost money
- **New Cross-Open**: Only fades spikes that crossed opening price → reversion DOES flip outcome → positive EV
- **New Contrarian**: Buys cheap underdogs with small leads → high R/R compensates for lower win rate → positive EV

## Safety Controls
- **Max 2 trades per 15-minute window** — 1 original + 1 reversal (only if opposite direction AND stronger spike)
- **Min entry $0.10** — blocks garbage orders below 10 cents (bad data protection)
- **Max entry $0.40** — ensures minimum 2.5x payout
- **Max 6 LOSING trades per day** — bot stops after 6 losses (keeps going if winning)
- **Daily loss limit** — stops trading when cumulative losses hit $15 (configurable)
- **Kill switch** — manual stop via dashboard
- **LOW confidence = automatic SKIP** — only MEDIUM and HIGH confidence trade
- **Non-cross-open spikes = SKIP** — won't fade spikes that didn't cross opening price

## Project Structure
```
server.js           - Express server + starts bot loop
src/
  scanner.js        - Discovers BTC 15-min Up/Down market (1-14 min remaining)
  dataFetcher.js    - Pulls prices, orderbook, minute-level history from CLOB API
  spikeDetector.js  - Detects $30+ spikes AND checks if they crossed opening price
  krakenFeed.js     - Kraken WebSocket BTC price + window opening price + cross-open tracking
  botLoop.js        - Dual strategy: tryCrossOpenFade() + tryLateContrarian()
  trader.js         - Places orders on Polymarket via CLOB API with HMAC signing
  safety.js         - Loss-based stop (6 losses), money limit, window dedup, kill switch
  redeemer.js       - Auto-redeems winning positions from resolved markets via Safe wallet
  positionScanner.js - Scans wallet for existing unredeemed positions
  logger.js         - Logs everything for dashboard display
  proxy.js          - FlashProxy residential proxy setup
public/
  index.html        - Dashboard UI with window status bar + cross-open indicator
  style.css         - Dashboard styling
  app.js            - Dashboard frontend logic
```

## Configuration
All config via `.env` file:
- `WALLET_PRIVATE_KEY` - Metamask wallet private key for trading
- `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` - CLOB API credentials
- `MAX_TRADE_SIZE` - Max dollars per trade (default 5)
- `MAX_ENTRY_PRICE` - Max entry price (default 0.40)
- `MIN_ENTRY_PRICE` - Min entry price (default 0.10)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 15)
- `MAX_DAILY_LOSSES` - Max losing trades per day (default 6)
- `SPIKE_THRESHOLD` - Dollar move to trigger spike (default 30)
- `MIN_SPIKE_SPEED` - Min speed in $/min (default 15)
- `CONTRARIAN_MIN_LEAD` - Min BTC lead for contrarian (default 20)
- `CONTRARIAN_MAX_LEAD` - Max BTC lead for contrarian (default 60)
- `CONTRARIAN_MAX_MINUTES` - Max minutes left for contrarian (default 5)
- `CONTRARIAN_MIN_MINUTES` - Min minutes left for contrarian (default 2)
- `PORT` - Dashboard port (default 5000 on Replit)
- `SCAN_INTERVAL` - Seconds between scans (default 10)
- `PROXY_URL` - FlashProxy SOCKS5 proxy URL
- `POLYGON_RPC_URL` - Polygon RPC URL for contract calls

## Key Technical Details
- BTC ONLY — focused on single asset for quality
- Window opening price tracked per 15-min slot from Kraken WebSocket
- Cross-open detection: checks BTC position 60-90 seconds ago vs now relative to opening price
- Late contrarian only triggers with $20-60 lead (small enough to flip, big enough for cheap tokens)
- Safety stops after 6 LOSSES not 6 trades — winning streaks continue
- signatureType=0 for EOA/MetaMask wallets
- Dashboard shows window timer, opening price, cross-open status, active strategy

## Recent Changes (Feb 16, 2026)
- **STRATEGY REBUILD**: Replaced FADE + SNIPER with CROSS-OPEN FADE + LATE CONTRARIAN
  - Old FADE faded ALL spikes → lost because partial reversion doesn't flip Polymarket outcome
  - New CROSS-OPEN only fades spikes that cross opening price → reversion actually wins
  - Old SNIPER bought winning side with big lead → tokens too expensive
  - New CONTRARIAN buys LOSING side with small lead → cheap tokens, high R/R
- **Cross-open detection**: krakenFeed tracks BTC position relative to opening 60-90s ago
- **Contrarian lead range**: $20-60 (not $100+ like old sniper)
- **Dashboard**: Shows cross-open indicator, new strategy badges

## User Preferences
- BTC only for better quality decisions
- All keys in .env only, never in code
- Dashboard must show EVERYTHING the bot thinks and does
- Kraken WebSocket for real BTC price (no API key needed)
- Bot stops after 6 losses, keeps going if winning
- Quality over quantity — skip most opportunities
- User deploys to VPS at port 4000 with pm2 ONLY — never deploy on Replit
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
