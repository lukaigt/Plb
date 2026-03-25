# Polymarket BTC Momentum Trader

## Overview
Momentum trading bot for Polymarket BTC 15-minute Up/Down markets. Strategy: check BTC 3-minute price change from Kraken feed — if momentum exceeds ±0.05%, buy the corresponding UP or DOWN token at midpoint, post immediate SELL at +12¢ take profit, cut losses at -12¢ stop loss, hold to resolution if neither triggers. One trade per 15-minute window. BTC only — $74k/window (15-min) volume, deepest markets.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000 (Replit dev) / port 4000 (VPS)
- **Bot loop** runs every 10 seconds (configurable via MM_REFRESH_INTERVAL)
- **MomentumSession** tracks state per market: phase, signal, entry/TP/SL prices, fill status
- **Dashboard** shows BTC price (Kraken live), 15-min session card with signal/entry/P&L, activity log
- **Market discovery** via Polymarket Gamma API using slug pattern `btc-updown-15m-{timestamp}`
- **Prices** via CLOB API REST: `https://clob.polymarket.com/midpoint?token_id={id}`
- **Order placement** via CLOB SDK (`@polymarket/clob-client`) with wallet credentials
- **Auto-redeem** via Polygon smart contracts when positions resolve

## Strategy: Momentum Trading
- **Session phases** per 15-min window:
  1. `waiting` — first 3 minutes (entryAfterSeconds=180) — gathering BTC momentum data
  2. `entering` — buy posted, waiting to fill
  3. `managing` — fill confirmed, sell posted at TP, monitoring SL
  4. `closing` — final 30s before end — cancel sell if open, hold token to resolution
  5. `done` — TP hit, SL hit, or window ended
- **Signal**: BTC 3-minute % change via Kraken WebSocket — UP if +0.05%, DOWN if -0.05%
- **Mid range guard**: skip if token mid outside [0.35, 0.65] — token already priced-in
- **Take profit**: +12¢ above entry (SELL order posted immediately after fill confirmed)
- **Stop loss**: -12¢ below entry (checked every 10s, market sell posted if triggered)
- **One trade per window**: `entryAttempted` flag prevents multiple entries

## Safety Controls
- **Daily loss limit**: $50 (configurable via DAILY_LOSS_LIMIT)
- **Max daily losing trades**: 10 (configurable via MAX_DAILY_LOSSES)
- **Kill switch**: manual stop via dashboard
- **Mid range check**: won't trade if token already priced at extreme (< 0.35 or > 0.65)
- **Closing phase**: final 30 seconds — cancel sell orders, hold to resolution

## Project Structure
```
server.js              - Express server + auto-starts bot loop
src/
  scanner.js           - Discovers BTC 5-min and 15-min markets via Gamma API
  marketMaker.js       - MarketSession class: midpoint fetch, order placement, status
  botLoop.js           - Main loop: scan → cancel old → post fresh quotes → redeem
  safety.js            - Loss limit, kill switch, daily tracking
  trader.js            - CLOB client init, placeOrder utility
  dataFetcher.js       - getMidpoint, getOrderbook (REST helpers)
  redeemer.js          - Auto-redeems winning positions from resolved markets
  positionScanner.js   - Scans wallet for existing unredeemed positions
  krakenFeed.js        - Kraken WebSocket BTC price feed
  logger.js            - Activity log + trade history for dashboard
  proxy.js             - FlashProxy residential proxy setup
public/
  index.html           - Dashboard: BTC ticker, 5-min/15-min market cards, activity
  style.css            - Dark theme, market card styles
  app.js               - Dashboard frontend logic (polls /api/* every 3s)
```

## Configuration (.env)
- `WALLET_PRIVATE_KEY` - MetaMask wallet private key
- `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` - CLOB API credentials
- `MOM_ORDER_SIZE` - USDC per trade (default 10)
- `MOM_TAKE_PROFIT` - Take profit in dollars above entry (default 0.12 = 12¢)
- `MOM_STOP_LOSS` - Stop loss in dollars below entry (default 0.12 = 12¢)
- `MOM_THRESHOLD` - BTC 3-min % change needed for signal (default 0.05)
- `MOM_MID_MIN` - Skip if token mid below this (default 0.35)
- `MOM_MID_MAX` - Skip if token mid above this (default 0.65)
- `MOM_ENTRY_AFTER_SECONDS` - Wait this many seconds after window start before entering (default 180)
- `MOM_CLOSE_SECONDS` - Final seconds to hold to resolution (default 30)
- `MOM_MARKET_TYPE` - Market type to trade (default '15m')
- `MM_REFRESH_INTERVAL` - Seconds between bot loop iterations (default 10)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 50)
- `MAX_DAILY_LOSSES` - Max losing trades per day (default 10)
- `PORT` - Dashboard port (5000 on Replit, 4000 on VPS)
- `PROXY_URL` - FlashProxy SOCKS5 proxy URL (optional)
- `POLYGON_RPC_URL` - Polygon RPC URL for contract calls (optional)
- `PROXY_WALLET_ADDRESS` - Your Polymarket proxy/Safe wallet address if known (optional, auto-discovered if omitted)

## CRITICAL: Always Use CLOB API for Live Prices
- **NEVER use Gamma API outcomePrices for trading** — they are cached/stale (~$0.50/$0.50)
- **ALWAYS use CLOB midpoint endpoint**: `https://clob.polymarket.com/midpoint?token_id={id}`

## Key Technical Details
- BTC 5-min markets: slug `btc-updown-5m-{unix_timestamp}` where timestamp = slot start (every 300s)
- BTC 15-min markets: slug `btc-updown-15m-{unix_timestamp}` where timestamp = slot start (every 900s)
- Scanner tries timestamps from -1 to +2 slots relative to current time to find active market
- signatureType=0 for EOA/MetaMask wallets (set as 5th param to ClobClient)
- cancelMarketOrders called on both UP and DOWN tokenIds before each fresh quote cycle
- MarketSession tracks: phase (quoting/closing/waiting), lastMid, ordersPosted, totalSpent
- Sessions auto-removed when market no longer found (assumed resolved), redeemer queued

## User Preferences
- BTC only — deepest markets, highest volume
- Never deploy on Replit — VPS at port 4000 with pm2 only
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
- Dashboard must show everything the bot is doing
- Kraken WebSocket for real BTC price (no API key needed)
- All credentials in .env only, never in code

## Recent Changes (Mar 24, 2026) — Session 2
- **COMPLETE STRATEGY REBUILD**: Old $0.85-$0.95 scalp replaced with Market Making (session 1)
- **Redemption fix**: `trader.js` fetches proxy wallet from CLOB API `/auth/user` with HMAC-SHA256 auth headers. `redeemer.js` and `positionScanner.js` now use `getProxyWallet()` from trader.js instead of broken Safe factory auto-discovery.
- **Take-profit**: New `src/positionTracker.js` polls CLOB trades API for fills, tracks open positions, posts SELL orders when profit ratio ≥ `MM_TAKE_PROFIT_PCT` (default 50% of max gain = current fill from `mid - 0.01`)
- **Dashboard positions panel**: "Open Positions & Take-Profit" panel added between MM Activity and Auto-Redeem panels; shows per-position status (OPEN/FILLED/TP SENT), entry price, fill size, max gain, and recent exits with P&L
- **New file**: `src/positionTracker.js`
- **Updated**: `src/trader.js` (proxy wallet fetch via CLOB API), `src/redeemer.js` (proxy wallet from trader), `src/positionScanner.js` (proxy wallet from trader), `src/botLoop.js` (integrate positionTracker), `src/marketMaker.js` (postQuotes returns placed orders), `server.js` (/api/positions), `public/index.html`, `public/app.js`

## Configuration Added (Session 2)
- `MM_TAKE_PROFIT_PCT` - Take-profit at this fraction of max gain (default 0.5 = 50%); set to 0.8 to only sell if 80% of the way to $1.00
- `MM_MID_MIN` - Skip quoting if UP midpoint is below this (default 0.20); prevents buying heavily skewed markets
- `MM_MID_MAX` - Skip quoting if UP midpoint is above this (default 0.80); symmetric upper bound
