# Polymarket AI Trading Bot — BTC Only

## Overview
AI-powered trading bot for Polymarket BTC 15-minute price prediction markets. Uses GLM-4.7-Flash via OpenRouter with a **price structure pattern recognition** strategy. Bot reads minute-by-minute UP probability like a chart, identifies specific patterns (staircases, V-recoveries, breakouts, breakdowns), and only trades when the pattern is clear + orderbook confirms + entry price has value. SKIP is the default answer (60-70% skip rate). Stops after 6 LOSING trades or $15 lost.

## Architecture
- **Node.js + Express** backend serving dashboard on port 5000
- **Bot loop** scans BTC market, evaluates with AI, trades only clear patterns
- **Web dashboard** shows full AI analysis: price structure, pattern identified, orderbook signal, reasoning
- **Market discovery** via Polymarket Gamma API using slug pattern `btc-updown-15m-{timestamp}`
- **Data fetching** via Polymarket CLOB API (free, no auth needed for reads) — minute-level price history
- **Trade execution** via CLOB API with wallet-derived API credentials
- **Proxy support** via FlashProxy Brazil residential proxy for Cloudflare bypass

## AI Strategy (Price Structure Pattern Recognition)
- **Pattern reading**: AI reads minute-by-minute price sequence as a chart shape
- **Bullish patterns**: steady staircase up, higher lows, V-recovery, breakout from flat
- **Bearish patterns**: steady staircase down, lower highs, inverted V, breakdown from flat
- **Skip patterns**: choppy/noise, flat/dead, exhausted move (>0.65 or <0.35), contradicting
- **Orderbook confirmation**: pattern must be supported by bid volume imbalance
- **Value entries only**: only trade when entry price is 0.40-0.60
- **SKIP is default**: AI instructed to skip 60-70% of opportunities
- **Temperature 0.2**: Low randomness for consistent pattern recognition

## Safety Controls
- **Max 1 trade per scan cycle** — BTC only
- **Max 1 trade per 15-minute window** — no duplicate bets on same market
- **Max 6 LOSING trades per day** — bot stops after 6 losses (keeps going if winning)
- **Daily loss limit** — stops trading when cumulative losses hit $15 (configurable)
- **Kill switch** — manual stop via dashboard
- **LOW confidence = automatic SKIP** — only MEDIUM and HIGH confidence trade

## Project Structure
```
server.js           - Express server + starts bot loop
src/
  scanner.js        - Discovers BTC 15-min Up/Down market (3-12 min remaining only)
  dataFetcher.js    - Pulls prices, orderbook, minute-level history from CLOB API
  aiEngine.js       - Price structure pattern analysis via GLM-4.7-Flash
  trader.js         - Places orders on Polymarket via CLOB API with HMAC signing
  safety.js         - Loss-based stop (6 losses), money limit, window dedup, kill switch
  botLoop.js        - Scans BTC market, gets AI decision, executes if clear pattern
  logger.js         - Logs everything for dashboard display
  proxy.js          - FlashProxy residential proxy setup
public/
  index.html        - Dashboard UI (BTC focused)
  style.css         - Dashboard styling
  app.js            - Dashboard frontend logic
```

## Configuration
All config via `.env` file:
- `OPENROUTER_API_KEY` - OpenRouter API key for GLM-4.7-Flash
- `WALLET_PRIVATE_KEY` - Metamask wallet private key for trading
- `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` - CLOB API credentials
- `MAX_TRADE_SIZE` - Max dollars per trade (default 5)
- `DAILY_LOSS_LIMIT` - Max daily loss in dollars (default 15)
- `MAX_DAILY_LOSSES` - Max losing trades per day (default 6)
- `PORT` - Dashboard port (default 5000 on Replit)
- `SCAN_INTERVAL` - Seconds between scans (default 120)
- `PROXY_URL` - FlashProxy SOCKS5 proxy URL

## Key Technical Details
- BTC ONLY — removed ETH, SOL, XRP for better focus
- Markets use slug pattern with Unix timestamps
- Scanner checks adjacent 15-min slots, filters to 3-12 minutes remaining
- Price history fetched at 1-minute intervals for pattern detection
- AI gets full price sequence + structure summary + orderbook comparison
- AI must name specific pattern (staircase, V-recovery, etc.) or SKIP
- Confidence: HIGH (full $5), MEDIUM (half $2.50), LOW (auto-SKIP)
- Safety stops after 6 LOSSES not 6 trades — winning streaks continue
- signatureType=0 for EOA/MetaMask wallets

## Recent Changes (Feb 12, 2026)
- Complete AI rewrite: from mean reversion to price structure pattern recognition
- BTC ONLY: removed ETH, SOL, XRP
- Safety fix: stops after 6 LOSING trades (was 6 total trades before)
- Dashboard redesign: shows price sequence, pattern identified, orderbook signal, full reasoning
- AI prompt teaches specific chart patterns with exact number examples
- Added structure summary (start/middle/current, peak/low, up/down move counts)

## User Preferences
- BTC only for better quality decisions
- All keys in .env only, never in code
- Dashboard must show EVERYTHING the AI thinks and does
- No external crypto data APIs — use Polymarket data only
- Bot stops after 6 losses, keeps going if winning
- Quality over quantity — skip most opportunities
