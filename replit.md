# Sports Bond Bot

## Overview
This project runs a single trading bot on Polymarket:

**Sports Live Bond Bot** — Monitors live in-progress sports events (soccer, NFL, NBA, MLB, NHL, tennis, golf, UFC, cricket, rugby, F1 and more). When a YES token midpoint reaches 95¢ (near-certain outcome), automatically buys at that price and holds to $1.00 resolution. Collects a near-risk-free 5¢ yield per trade with full auto-redemption on-chain.

## User Preferences
- Sports only — no crypto/BTC/elections
- Never deploy on Replit — VPS at port 4000 with pm2 only
- Deploy command: `cd ~/polymarket-bot && git stash && git pull && npm install && pm2 restart polymarket-bot && pm2 logs polymarket-bot`
- Dashboard must show everything the bot is doing
- All credentials in .env only, never in code

## Soccer Bond Strategy

The bot monitors Polymarket soccer/football markets for in-progress games (Gamma API `tag_slug=soccer` + `football` filter, `endDate` within 12h window, `startDate` <= now to exclude pre-kickoff). When a YES token midpoint reaches **BOND_THRESHOLD** (default 95¢), it places a limit buy and holds to $1.00 resolution, collecting the near-risk-free yield. All positions are redeemed on-chain automatically.

**BondSession state machine:** watching → buying → holding → done / lost

- Watches price every 15s (fast loop)
- On resolution, derives winner from Gamma `outcomePrices` (authoritative). Falls back to last mid >= 0.5 only if Gamma data unavailable. Logs `no_fill` if outcome truly cannot be determined.
- On win: session transitions to `phase='redeeming'` — fast loop calls `tryRedeem()` every 15s until confirmed on-chain
- Duplicate guard: once a market is entered (or attempted), it is added to `enteredMarkets` Set and never re-entered even if the session is cleaned up
- Early-game filter: `BOND_MIN_ELAPSED_MINUTES` (default 30) — skip markets where game started less than N minutes ago
- Overlap guard: `isScanRunning` / `isFastRunning` flags prevent concurrent loop executions
- Safety: `safety.canTrade()` checked before every entry; `BOND_MAX_POSITIONS` enforced atomically

**Bot Config (all in .env):**
- `SOCCER_ENABLED=true` — set to `false` to disable entirely
- `ALL_SPORTS_ENABLED=true` — when set, scans ALL sports (soccer, NFL, NBA, MLB, NHL, tennis, golf, UFC, cricket, rugby, F1, esports). When `false` or unset, soccer-only mode
- `BOND_THRESHOLD=0.95` — buy when YES token reaches this price
- `BOND_ORDER_SIZE=5` — USD per trade
- `BOND_MAX_POSITIONS=5` — max concurrent positions
- `BOND_MIN_VOLUME=5000` — min 24hr market volume to consider
- `BOND_DAILY_MAX_SPEND=50` — daily cap in USD
- `BOND_MIN_ELAPSED_MINUTES=30` — only enter games 30+ minutes old (avoids early lead false signals)
- `BOND_STOP_LOSS=0.07` — hard stop: exit if position loses >7% of entry cost (default was 0.20 — too loose)
- `BOND_TRAILING_STOP=0.03` — trailing stop: exit if bid drops 3¢ from peak (default was 0.05)
- `STALE_SESSION_MINUTES=8` — auto-clear liquidating sessions with zero on-chain balance after N minutes
- `RELAYER_API_KEY=<key>` — Polymarket Relayer API key (gasless redemption, primary path). Get from polymarket.com → Settings → API Keys → Relayer
- `RELAYER_API_KEY_ADDRESS=0xe82dEec5...` — EOA address matching the Relayer API key
- `PROXY_WALLET_ADDRESS=0x94eAb3d7...` — Gnosis Safe proxy wallet address (fallback if Relayer unavailable)

## Technical Implementation
- **Backend**: Node.js + Express server, port 5000 (dev) or 4000 (VPS)
- **Scan Loop**: Every 2 minutes — discovers live soccer/football markets via Gamma API
- **Fast Loop**: Every 15 seconds — polls YES token midpoints, checks fills, checks resolution
- **Order Placement**: Polymarket CLOB V2 SDK (`@polymarket/clob-client-v2` + `viem`). Migrated April 2026.
- **Auto-Redemption**: Primary path: Polymarket Relayer API (gasless, `POST https://relayer-v2.polymarket.com/submit`). Fallback: direct EOA on-chain, then Gnosis Safe on-chain. callStatic gates resolution check (payoutDenominator NOT used — always 0 for NegRisk/soccer markets).
- **Safety Controls**: Daily loss limit, kill switch, max positions cap, daily spend cap

## CLOB V2 Migration (April 28, 2026)
Polymarket launched CLOB V2, replacing USDC.e with pUSD and deploying new exchange contracts.
- **Collateral**: pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (replaces USDC.e)
- **Exchange V2**: `0xE111180000d2663C0091e4f400237545B87B996B`
- **NegRisk Exchange V2**: `0xe2222d279d744050d28e00520010520000310F59`
- **CTF**: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (UNCHANGED — redemption unaffected)
- **NegRisk Adapter**: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` (UNCHANGED)
- SDK constructor now uses options object `{ host, chain: Chain.POLYGON, signer: viemWalletClient, creds }`
- `feeRateBps`, `expiration`, `taker`, `nonce` removed from order struct. `timestamp` (ms) added by SDK.
- User must wrap USDC.e → pUSD on polymarket.com before new bets can be placed.

## Dashboard
- Live soccer position panel — phase badges (WATCHING / ENTERED / HOLDING / DONE / LOST), mid price, entry price, unrealized P&L, time left
- Soccer Activity log — bond_*/soccer_* events
- Trade History — match name + green badge for every soccer trade
- Auto-Redeem panel — pending/collected/lost positions
- Kill Switch, Scan Wallet, Force Redeem buttons

## Persistent Trade Log
- `src/logger.js` saves all trades to `data/trades.json` on disk, surviving pm2 restarts.
- `getStats()` returns totalFees, netPnL, todayFees, todayNetPnL, exitReasons breakdown.

## Project Structure
- `server.js` — Express server, API routes, starts soccerLoop on boot
- `src/soccerScanner.js` — Gamma API discovery for live soccer/football markets only
- `src/sportsScanner.js` — Gamma API discovery for ALL live sports markets (19 tag slugs, deduped)
- `src/bondStrategy.js` — BondSession state machine + resolution + redemption queue
- `src/soccerLoop.js` — Scan loop (2 min) + fast loop (15s)
- `src/trader.js` — CLOB client, order placement, auth
- `src/redeemer.js` — On-chain redemption via Polygon
- `src/positionScanner.js` — Wallet position scanner (manual recovery)
- `src/safety.js` — Kill switch, daily loss limits, trade guards
- `src/logger.js` — Activity + trade log, persistent to disk
- `src/proxy.js` — Optional residential proxy setup
- `public/` — Dashboard HTML, CSS, JavaScript

## External Dependencies
- **Polymarket Gamma API**: Market discovery
- **Polymarket CLOB API (REST)**: Real-time midpoint prices
- **Polymarket CLOB SDK**: Order placement, wallet interaction, order status
- **Polygon Network**: Smart contract interactions and token redemption
- **FlashProxy (optional)**: Residential proxy setup

## CRITICAL: How Redemption Works (Hard-Won Knowledge — Do Not Forget)

### Why redemptions were broken for 3 days (fixed commit 3316518)
`findResolvedCollateral()` used to call `CTF.callStatic.redeemPositions()` to detect
which collateral a market used. This is WRONG. Once `payoutDenominator > 0` (market
resolved), callStatic passes for ALL collaterals (pUSD, USDC.e, wcol) because it only
checks resolution, not whether the wallet actually holds tokens. The old code always
picked pUSD (first in list). But winning position tokens are USDC.e-based CTF ERC-1155
tokens held on the EOA. Calling CTF with pUSD found 0 balance → no Transfer event →
`verifyRedemptionReceipt` returned false → "success: false" → stuck "waiting" forever.
The Relayer also failed because it calls `Safe.execTransaction` but tokens are on the
EOA not the Safe.

### The correct redemption logic (src/redeemer.js as of May 2026)
`findResolvedCollateral(provider, conditionId, eoaAddr, safAddr)`:
1. `payoutDenominator(conditionId) > 0` — gate: market must be resolved on-chain
2. `getCollectionId(HashZero, conditionId, 1)` → compute position tokenId per collateral
3. `balanceOf(EOA, posId)` and `balanceOf(Safe, posId)` for pUSD, USDC.e, wcol
4. Return `{ addr, label, holderWallet }` for the first collateral with actual balance > 0
5. If no balance found → return null (don't waste gas, may already be redeemed)

`attemptRedeem()` routes by `col.holderWallet`:
- Tokens on EOA  → **EOA direct only**: `CTF.redeemPositions(USDC.e, HashZero, conditionId, [1,2])`
- Tokens on Safe → **Relayer first** (gasless), then Safe.execTransaction fallback

### Key facts that must never be forgotten
- Winning position tokens land on the **EOA**, not the Safe
- All current positions are **USDC.e-based** (not pUSD) — even trades placed after V2 launch (April 28 2026), because those markets were created under V1
- USDC.e payout arrives in the EOA wallet — user must wrap to pUSD on polymarket.com to place new bets
- EOA has ~35 MATIC — plenty for gas (each redemption costs ~0.001 MATIC)
- **NEVER use callStatic alone to pick the collateral** — it always passes for all collaterals on resolved markets. Always use `balanceOf` to find the real one.

### Redemption debugging commands (run from ~/polymarket-bot)
```bash
# See pending queue with conditionId + retryCount
curl -s http://localhost:4000/api/redemptions | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const r=JSON.parse(d.join(''));r.pending.forEach(p=>console.log(p.status,p.retryCount,p.conditionId,p.question?.slice(0,40)));});"

# Trigger immediate redemption attempt
curl -s -X POST http://localhost:4000/api/force-redeem

# Watch live redeemer logs (do this RIGHT AFTER force-redeem — buffer fills fast)
curl -s "http://localhost:4000/api/activities?limit=200" | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{JSON.parse(d.join('')).filter(a=>a.type.includes('redeem')).forEach(a=>console.log(a.type,a.message));});"
```

### Activity log warning
Redeemer logs go to `logger.addActivity()` (dashboard), NOT pm2/stdout. The buffer
holds 500 entries. The fast loop (every 15s) fills it in ~1 hour, pushing out old
redeemer logs. Always check logs immediately after triggering a redemption.
