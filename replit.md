# Polymarket BTC Swing Trader

## Overview
Swing trading bot for Polymarket BTC 15-minute Up/Down markets. Strategy: wait 3 minutes into the window to read BTC momentum via Kraken feed, buy UP or DOWN token based on direction, ride the move using a **trailing stop** (sells when price drops 5¢ below peak), then **flip** to the opposite side within the same window. One position at a time, max 3 flips per window. BTC only — deepest Polymarket markets.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000 (Replit dev) / port 4000 (VPS)
- **Main bot loop** runs every 10 seconds (configurable via MM_REFRESH_INTERVAL)
- **Fast loop** runs every 5 seconds — checks trailing stop (managing phase) and exit fill status (exiting phase)
- **MomentumSession** tracks state per market: phase, signal, entry/trailing stop/SL prices, fill status, flip count
- **Dashboard** shows BTC price (Kraken live), 15-min session card with signal/entry/peak/trailing stop/P&L/flips, activity log
- **Market discovery** via Polymarket Gamma API using slug pattern `btc-updown-15m-{timestamp}`
- **Prices** via CLOB API REST: `https://clob.polymarket.com/midpoint?token_id={id}`
- **Order placement** via CLOB SDK (`@polymarket/clob-client`) with wallet credentials
- **Auto-redeem** via Polygon smart contracts when positions resolve (EOA path)

## Strategy: Swing Trading with Trailing Stop + Flip

### Session Phases per 15-min window:
1. `waiting` — first 3 minutes (entryAfterSeconds=180) — gathering BTC momentum data
2. `entering` — BUY order posted, waiting to fill
3. `managing` — fill confirmed, trailing stop monitoring every 5s
4. `exiting` — SELL order posted (trailing stop or stop loss triggered), waiting for fill confirmation
5. `flipping` — exit fully confirmed, attempting opposite-side entry
6. `closing` — final 30s before end — cancel pending orders, hold remaining tokens to resolution
7. `done` — max flips reached, or window ended

### Signal
- BTC 3-minute % change via Kraken WebSocket
- UP if change >= +0.05%, DOWN if change <= -0.05%

### Trailing Stop
- **Activation**: trailing stop activates when token mid >= entry price + trailingActivate (default 2¢)
- **Peak tracking**: once active, tracks highest midpoint seen (`peakMid`)
- **Exit trigger**: when mid drops trailingStop (default 5¢) below peak, posts SELL order
- Example: entry $0.47, peak rises to $0.80, trailing stop at $0.75. If mid drops to $0.75, exit sell posted.
- **No trailing exits in closing window**: `checkTrailingStop()` returns early if `isClosing()` is true

### Stop Loss
- Hard floor at entry - stopLossCents (default 12¢)
- If mid <= stop loss price, posts SELL immediately

### Exit Fill Tracking
- `holdingToken` stays TRUE during entire `exiting` phase — we physically own tokens until fill confirmed
- `checkExitFill()` tracks `exitFilledSoFar` vs `exitSize`
- Only transitions to `flipping` when remaining <= 0.01 tokens (fully filled)
- Partial fills are logged and polling continues — bot stays in `exiting`
- If exit order cancelled externally, returns to `managing` to retry

### Flip Mechanic
- After confirmed full exit fill → phase becomes `flipping`
- `attemptFlip()` enters opposite side if:
  - `flipCount < maxFlips` (default 3)
  - `secondsLeft > flipMinSeconds` (default 90s)
  - Other-side token mid is in range [midMin, midMax]
- `flipCount` only incremented after successful BUY order post (not on attempt)
- `_resetTradeLeg()` clears all prior leg state before each new entry
- One position at a time enforced via `holdingToken` flag

### Closing Phase
- Final 30 seconds (configurable via MOM_CLOSE_SECONDS)
- If exit order pending: cancels it, checks partial fill status
  - If remaining <= 0.01 (dust): `holdingToken = false` (nothing to redeem)
  - If remaining > 0.01: `holdingToken = true` (remaining tokens held to resolution)
- If entry unfilled: cancels entry order
- If holding token: queued for auto-redemption

## Safety Controls
- **Daily loss limit**: $50 (configurable via DAILY_LOSS_LIMIT)
- **Max daily losing trades**: 10 (configurable via MAX_DAILY_LOSSES)
- **Kill switch**: manual stop via dashboard
- **Mid range check**: won't trade if token already priced at extreme (< 0.35 or > 0.65)
- **Closing phase**: final 30 seconds — cancel orders, hold to resolution

## Project Structure
```
server.js              - Express server + auto-starts bot loop
src/
  scanner.js           - Discovers BTC 5-min and 15-min markets via Gamma API
  momentumStrategy.js  - MomentumSession class: trailing stop, flip mechanic, exit fill tracking
  botLoop.js           - Main loop (10s) + fast loop (5s): scan → manage → flip → redeem
  safety.js            - Loss limit, kill switch, daily tracking
  trader.js            - CLOB client init, placeOrder, placeSellOrder, buildClobAuthHeaders
  dataFetcher.js       - getMidpoint, getOrderbook (REST helpers)
  redeemer.js          - Auto-redeems winning positions from resolved markets (EOA path)
  positionScanner.js   - Scans wallet for existing unredeemed positions
  krakenFeed.js        - Kraken WebSocket BTC price feed (no API key needed)
  logger.js            - Activity log + trade history for dashboard
  proxy.js             - FlashProxy residential proxy setup
public/
  index.html           - Dashboard: BTC ticker, 15-min market card, activity log
  style.css            - Dark theme, market card styles
  app.js               - Dashboard frontend logic (polls /api/* every 3s)
```

## Configuration (.env)
- `WALLET_PRIVATE_KEY` - MetaMask wallet private key
- `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` - CLOB API credentials
- `MOM_ORDER_SIZE` - USDC per trade (default 10)
- `MOM_TRAILING_STOP` - Trailing stop distance in dollars (default 0.05 = 5¢ below peak)
- `MOM_TRAILING_ACTIVATE` - Trailing stop activation threshold above entry (default 0.02 = 2¢)
- `MOM_STOP_LOSS` - Stop loss in dollars below entry (default 0.12 = 12¢)
- `MOM_THRESHOLD` - BTC 3-min % change needed for signal (default 0.05)
- `MOM_MID_MIN` - Skip if token mid below this (default 0.35)
- `MOM_MID_MAX` - Skip if token mid above this (default 0.65)
- `MOM_ENTRY_AFTER_SECONDS` - Wait this many seconds after window start before entering (default 180)
- `MOM_CLOSE_SECONDS` - Final seconds to hold to resolution (default 30)
- `MOM_MARKET_TYPE` - Market type to trade (default '15m')
- `MOM_MAX_FLIPS` - Max flips per window (default 3)
- `MOM_FLIP_MIN_SECONDS` - Minimum seconds remaining to attempt a flip (default 90)
- `MM_REFRESH_INTERVAL` - Seconds between main bot loop iterations (default 10)
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
- BTC 15-min markets: slug `btc-updown-15m-{unix_timestamp}` where timestamp = slot start (every 900s)
- BTC 5-min markets: slug `btc-updown-5m-{unix_timestamp}` where timestamp = slot start (every 300s)
- Scanner tries timestamps from -1 to +2 slots relative to current time to find active market
- signatureType=0 for EOA/MetaMask wallets (set as 5th param to ClobClient)
- Tokens land on EOA (MetaMask wallet), not proxy wallet — redemption uses EOA path
- `trader.js` fetches proxy wallet from CLOB API `/auth/user` with HMAC-SHA256 auth headers
- negRisk=true for all BTC markets
- Sessions auto-removed when market no longer found (assumed resolved), redeemer queued if holdingToken=true

## User Preferences
- BTC only — deepest markets, highest volume
- Never deploy on Replit — VPS at port 4000 with pm2 only
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
- Dashboard must show everything the bot is doing
- Kraken WebSocket for real BTC price (no API key needed)
- All credentials in .env only, never in code

## Change History

### Session 3 (Mar 26, 2026) — Swing Trader Rebuild
- **COMPLETE STRATEGY REBUILD**: Old momentum/market-making strategy replaced with Swing Trader
- **Trailing stop**: replaces fixed +12¢ take profit — rides price moves to peak, exits 5¢ below peak
- **Flip mechanic**: after confirmed exit fill, attempts opposite side re-entry within same window
- **Exit fill tracking**: `exitFilledSoFar` vs `exitSize` — only flips on full fill (remaining <= 0.01), partial fills stay in 'exiting'
- **Fast loop (5s)**: `checkTrailingStop()` for managing phase, `checkExitFill()` for exiting phase
- **Closing-window guard**: `checkTrailingStop()` returns early if `isClosing()` — no exits in final 30s
- **Flip count safety**: `flipCount` only incremented after successful BUY order post
- **Dashboard config binding**: trailing activation and max flips read from `window._botConfig` (not hardcoded)
- **File**: `src/momentumStrategy.js` (MomentumSession with trailing stop + flip)
- **File**: `src/botLoop.js` (main loop + fast loop, redemption only when holdingToken=true)
- **File**: `public/app.js` (dashboard with peak/trail/flips/P&L, config-driven display)
- **File**: `public/index.html` (15m card: signal, entry, peak, trail, SL, flips, unrealized/cumulative P&L)

### Session 2 (Mar 24, 2026)
- Redemption fix: `trader.js` fetches proxy wallet from CLOB API with HMAC-SHA256 auth
- `redeemer.js` and `positionScanner.js` use `getProxyWallet()` from trader.js

### Session 1 (Mar 24, 2026)
- Initial build: momentum bot, scanner, krakenFeed, dashboard, auto-redeem
