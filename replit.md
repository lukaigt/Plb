# Polymarket AI Trading Bot

## Overview
AI-powered trading bot that monitors Polymarket 15-minute crypto price prediction markets (BTC, ETH, SOL, XRP). Uses GLM-4.7-Flash via OpenRouter with a **mean reversion + orderbook analysis** strategy. Bot identifies overreactions in market odds and bets against them when orderbook data confirms. Strict frequency controls: max 1 trade per scan cycle, 1 per coin per 15-min window, max 6 trades per day.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000 (Replit) or configurable PORT
- **Bot loop** scans markets, evaluates all opportunities, picks ONLY the single best one per cycle
- **Web dashboard** shows live activity, AI reasoning, trades, portfolio stats, safety controls
- **Market discovery** via Polymarket Gamma API using slug pattern `{coin}-updown-15m-{timestamp}`
- **Data fetching** via Polymarket CLOB API (free, no auth needed for reads) — minute-level price history
- **Trade execution** via CLOB API with wallet-derived API credentials
- **Proxy support** via FlashProxy Brazil residential proxy for Cloudflare bypass

## AI Strategy (Mean Reversion + Orderbook)
- **Contrarian approach**: Bets AGAINST overreactions, not with momentum
- **Orderbook as primary signal**: Compares UP vs DOWN bid volumes to find smart money positioning
- **Overreaction detection**: When prices spike above 0.60 or below 0.40 with decelerating momentum, bets on reversal
- **SKIP is the default**: AI instructed to skip 60-70% of opportunities. Only trades with 2+ confirming signals
- **Time window**: Only trades when 3-12 minutes remain (enough data + enough time for reversal)
- **Temperature 0.2**: Low randomness for consistent decisions

## Safety Controls
- **Max 1 trade per scan cycle** — picks only the best opportunity from all coins
- **Max 1 trade per coin per 15-minute window** — no duplicate bets on same market
- **Max daily trades** — hard cap of 6 trades per day (configurable via MAX_DAILY_TRADES)
- **Daily loss limit** — stops trading when cumulative losses hit $15 (configurable)
- **Kill switch** — manual stop via dashboard
- **Opportunity scoring** — ranks opportunities by confidence, orderbook imbalance, momentum quality, price displacement

## Project Structure
```
server.js           - Express server + starts bot loop
src/
  scanner.js        - Discovers 15-min crypto Up/Down markets (3-12 min remaining only)
  dataFetcher.js    - Pulls prices, orderbook, minute-level history from CLOB API
  aiEngine.js       - Mean reversion + orderbook strategy via GLM-4.7-Flash
  trader.js         - Places orders on Polymarket via CLOB API with HMAC signing
  safety.js         - Daily trade cap, loss limits, window dedup, kill switch
  botLoop.js        - Scans all markets, scores opportunities, executes best one only
  logger.js         - Logs everything for dashboard display
  proxy.js          - FlashProxy residential proxy setup
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
- `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` - CLOB API credentials
- `MAX_TRADE_SIZE` - Max dollars per trade (default 5)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 15)
- `MAX_DAILY_TRADES` - Max trades per day (default 6)
- `PORT` - Dashboard port (default 4000)
- `SCAN_INTERVAL` - Seconds between scans (default 120)
- `PROXY_URL` - FlashProxy SOCKS5 proxy URL

## Key Technical Details
- Markets use slug pattern with Unix timestamps (not formatted dates)
- Scanner checks adjacent 15-min slots, filters to 3-12 minutes remaining
- Price history fetched at 1-minute intervals for granular pattern detection
- AI confidence levels: HIGH (full $5), MEDIUM (half $2.50), LOW (skip)
- Safety: daily counters reset at midnight, kill switch stops all trading
- Bot evaluates ALL coins then picks the single best opportunity per cycle
- signatureType=0 for EOA/MetaMask wallets

## Recent Changes (Feb 11, 2026)
- Rewrote AI from momentum-chasing to mean reversion + orderbook strategy
- Fixed safety system: added max daily trades cap (was only tracking loss count, never triggering)
- Added 1 trade per coin per 15-min window deduplication
- Changed bot loop from "trade every coin" to "score all, trade best one only"
- Changed price history from 1h to 1m intervals
- Narrowed scanner window from 1-20 min to 3-12 min remaining

## User Preferences
- Port 3000 reserved for other bot, using port 4000 for VPS deployment
- VPS deployment via GitHub push/pull
- All keys in .env only, never in code
- Dashboard should show everything the bot and AI are doing
- No external crypto data APIs — use Polymarket data only
- One trade per cycle maximum, pick the best opportunity
