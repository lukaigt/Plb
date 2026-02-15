# Polymarket Fade + Sniper Trading Bot — BTC Only

## Overview
Dual-strategy trading bot for Polymarket BTC 15-minute price prediction markets. Uses FADE (mean reversion) and SNIPER (late-game positioning) strategies instead of momentum-following. Bot trades AGAINST BTC spikes (because spikes reverse 60-85% of the time) and takes cheap positions when BTC has a clear lead late in the window.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000
- **Bot loop** runs dual strategy (Fade + Sniper) every 10 seconds
- **Web dashboard** shows window status, BTC vs opening price, strategy signals, full activity log
- **Market discovery** via Polymarket Gamma API using slug pattern `btc-updown-15m-{timestamp}`
- **Data fetching** via Polymarket CLOB API (free, no auth needed for reads)
- **Trade execution** via CLOB API with wallet-derived API credentials
- **Proxy support** via FlashProxy Brazil residential proxy for Cloudflare bypass

## Dual Strategy System

### Strategy 1: FADE THE SPIKE (Primary — Mean Reversion)
- **Trigger**: BTC moves $30+ in 60s (same spike detection as before)
- **Action**: Trade OPPOSITE direction (spike UP → buy DOWN, spike DOWN → buy UP)
- **Why it works**: BTC spikes reverse 60-85% of the time on 15-min timeframes
- **Deceleration filter**: Only fade when momentum is DECELERATING or STABLE (skip ACCELERATING)
- **Confidence**: HIGH when spike is large ($40+) AND decelerating, MEDIUM otherwise, LOW if accelerating (skip)
- **Edge**: The opposite side is CHEAP after a spike — exactly where we want to buy

### Strategy 2: LATE-GAME SNIPER (Secondary)
- **Trigger**: 1.5-5 minutes remaining in window AND BTC is $100+ above/below the window opening price
- **Action**: Buy the side BTC is currently leading (UP if above opening, DOWN if below)
- **Why it works**: With a $100+ lead and only minutes left, probability of staying ahead is high
- **Entry requirement**: Leading side must still be < $0.40 (massive value when it exists)
- **Confidence**: HIGH when lead is $200+, MEDIUM when $100-200

### Why This Beats The Old Strategy
- **Old strategy (momentum)**: BTC spikes UP → buy UP → loses 60-85% of the time (buying after the move is priced in)
- **New strategy (fade)**: BTC spikes UP → buy DOWN → wins 60-85% of the time (buying cheap, riding reversion)
- **Math**: At $0.35 entry with 62% win rate: EV = +$3.22/trade. Over 50 trades: +$161

## Safety Controls
- **Max 2 trades per 15-minute window** — 1 original + 1 reversal (only if opposite direction AND stronger spike)
- **Min entry $0.10** — blocks garbage orders below 10 cents (bad data protection)
- **Max entry $0.40** — ensures minimum 2.5x payout (lowered from $0.45 for better math)
- **Max 6 LOSING trades per day** — bot stops after 6 losses (keeps going if winning)
- **Daily loss limit** — stops trading when cumulative losses hit $15 (configurable)
- **Kill switch** — manual stop via dashboard
- **LOW confidence = automatic SKIP** — only MEDIUM and HIGH confidence trade
- **Accelerating momentum = SKIP** — don't fade a spike that's still accelerating

## Project Structure
```
server.js           - Express server + starts bot loop
src/
  scanner.js        - Discovers BTC 15-min Up/Down market (1-14 min remaining)
  dataFetcher.js    - Pulls prices, orderbook, minute-level history from CLOB API
  spikeDetector.js  - Detects BTC $30+ moves, outputs FADE signal (opposite direction)
  krakenFeed.js     - Kraken WebSocket BTC price + window opening price tracking
  botLoop.js        - Dual strategy: tryFadeStrategy() + trySniperStrategy()
  trader.js         - Places orders on Polymarket via CLOB API with HMAC signing
  safety.js         - Loss-based stop (6 losses), money limit, window dedup, kill switch
  redeemer.js       - Auto-redeems winning positions from resolved markets via Safe wallet
  positionScanner.js - Scans wallet for existing unredeemed positions
  logger.js         - Logs everything for dashboard display
  proxy.js          - FlashProxy residential proxy setup
public/
  index.html        - Dashboard UI with window status bar
  style.css         - Dashboard styling
  app.js            - Dashboard frontend logic
```

## Configuration
All config via `.env` file:
- `OPENROUTER_API_KEY` - OpenRouter API key (no longer used for decisions)
- `WALLET_PRIVATE_KEY` - Metamask wallet private key for trading
- `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` - CLOB API credentials
- `MAX_TRADE_SIZE` - Max dollars per trade (default 5)
- `MAX_ENTRY_PRICE` - Max entry price (default 0.40)
- `MIN_ENTRY_PRICE` - Min entry price (default 0.10)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 15)
- `MAX_DAILY_LOSSES` - Max losing trades per day (default 6)
- `SPIKE_THRESHOLD` - Dollar move to trigger spike (default 30)
- `MIN_SPIKE_SPEED` - Min speed in $/min (default 15)
- `SNIPER_MIN_LEAD` - Min BTC lead for sniper strategy (default 100)
- `SNIPER_MAX_MINUTES` - Max minutes left for sniper (default 5)
- `SNIPER_MIN_MINUTES` - Min minutes left for sniper (default 1.5)
- `PORT` - Dashboard port (default 5000 on Replit)
- `SCAN_INTERVAL` - Seconds between scans (default 10)
- `PROXY_URL` - FlashProxy SOCKS5 proxy URL
- `POLYGON_RPC_URL` - Polygon RPC URL for contract calls

## Key Technical Details
- BTC ONLY — focused on single asset for quality
- Window opening price tracked per 15-min slot from Kraken WebSocket
- Spike detector outputs fadeAction (opposite direction) instead of followAction
- Deceleration filter prevents fading accelerating spikes (dangerous)
- Late-game sniper requires $100+ BTC lead AND entry < $0.40
- Safety stops after 6 LOSSES not 6 trades — winning streaks continue
- signatureType=0 for EOA/MetaMask wallets
- Dashboard shows window timer, BTC vs opening price, active strategy

## Recent Changes (Feb 15, 2026)
- **COMPLETE STRATEGY OVERHAUL**: Replaced momentum-following with FADE + SNIPER
  - Old: Buy in spike direction (loses because spikes revert)
  - New: Buy AGAINST spike direction (wins because mean reversion)
- **Window opening price tracking**: krakenFeed.js now tracks BTC at start of each 15-min window
- **Late-game sniper**: Second strategy that buys when BTC has $100+ lead late in window
- **Max entry lowered**: $0.45 → $0.40 for better payout ratio (2.5x minimum)
- **Deceleration filter**: Only fade spikes that are running out of steam
- **Dashboard upgraded**: Shows 15-min window timer, opening price, BTC vs open, active strategy

## User Preferences
- BTC only for better quality decisions
- All keys in .env only, never in code
- Dashboard must show EVERYTHING the bot thinks and does
- Kraken WebSocket for real BTC price (no API key needed)
- Bot stops after 6 losses, keeps going if winning
- Quality over quantity — skip most opportunities
- User deploys to VPS at port 4000 with pm2
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
