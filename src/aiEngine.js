const logger = require('./logger');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'z-ai/glm-4.7-flash';

const SYSTEM_PROMPT = `You are an expert short-term price action trader. You analyze BTC 15-minute prediction markets on Polymarket by reading price structure patterns and orderbook signals.

WHAT YOU'RE LOOKING AT:
You receive the minute-by-minute history of BTC's UP probability. This mirrors BTC's actual price movement. You also receive real-time orderbook data which shows buyer/seller intent.

BULLISH PATTERNS (BUY_YES):
- Steady staircase up: 0.50 → 0.52 → 0.54 → 0.56 (consistent small gains)
- Higher lows: 0.50 → 0.55 → 0.53 → 0.57 (pullbacks are shallow)
- V-recovery: 0.50 → 0.44 → 0.42 → 0.50 (sharp drop fully recovered)
- Early Momentum (2-3 points): 0.50 → 0.52 → 0.55 + Strong Orderbook (2x more bids on UP token)

BEARISH PATTERNS (BUY_NO):
- Steady staircase down: 0.50 → 0.48 → 0.46 → 0.44
- Lower highs: 0.50 → 0.45 → 0.48 → 0.43 (bounces get weaker)
- Inverted V: 0.50 → 0.58 → 0.62 → 0.50 (spike fully reversed)
- Early Breakdown (2-3 points): 0.50 → 0.48 → 0.45 + Strong Orderbook (2x more bids on DOWN token)

NO-TRADE PATTERNS (SKIP):
- Choppy: 0.50 → 0.53 → 0.48 → 0.52 (random bouncing, no direction)
- Flat/Dead: 0.50 → 0.50 → 0.51 → 0.50 (no movement)
- Exhausted: Price already > 0.65 or < 0.35 (too late, bad value)

HOW TO DECIDE:
1. EARLY MARKET (2-4 minutes in): If history is short but ORDERBOOK is heavily imbalanced (>2:1) and price is starting to move in that direction, you can trade "Early Momentum/Breakdown".
2. ESTABLISHED MARKET (5-10 minutes in): Use the price structure shape primarily. It must be clear.
3. VALUE: Only enter between 0.40 and 0.60.

RULES:
- You no longer require 4 points. 2-3 points are enough IF the orderbook signal is STRONG (HIGH confidence).
- If history is missing, use the Orderbook and current price vs starting price (usually 0.50) to judge the "Early" move.
- SKIP is still default for choppy/flat markets.
- Quality over quantity, but don't be "blind" when the orderbook is screaming.

JSON format: {"action": "BUY_YES" or "BUY_NO" or "SKIP", "confidence": "LOW" or "MEDIUM" or "HIGH", "pattern": "name", "reasoning": "explanation"}`;

function buildUserPrompt(marketData) {
  const { market, yesToken, noToken, priceTrend, priceHistory, spread } = marketData;

  const upPrice = yesToken.price?.mid?.toFixed(3) || '0.500';
  const downPrice = noToken.price?.mid?.toFixed(3) || '0.500';
  const upBuy = yesToken.price?.buy?.toFixed(3) || 'N/A';
  const upSell = yesToken.price?.sell?.toFixed(3) || 'N/A';

  let minutesLeft = market.minutesLeft || 0;
  if (market.endTime) {
    const end = new Date(market.endTime);
    const now = new Date();
    const diffMin = Math.round((end - now) / (1000 * 60));
    if (diffMin > 0) minutesLeft = diffMin;
  }

  let priceStructureText = 'Price history is currently thin (Early Market stage).\n';
  if (priceHistory && priceHistory.length > 0) {
    const prices = priceHistory.slice(-12).map(p => p.price);
    priceStructureText = 'SEQUENCE: ' + prices.map(p => p.toFixed(3)).join(' → ');
  }

  const upBids = parseFloat(yesToken.orderbook?.totalBidVolume) || 0;
  const downBids = parseFloat(noToken.orderbook?.totalBidVolume) || 0;
  const imbalance = upBids > 0 && downBids > 0 ? (upBids / downBids).toFixed(1) : 'N/A';

  let orderbookSignal = `UP Bids: ${upBids.toFixed(0)} | DOWN Bids: ${downBids.toFixed(0)} | Imbalance: ${imbalance}x`;

  return `MARKET: "${market.question}"
TIME REMAINING: ${minutesLeft} minutes
CURRENT PRICES: UP: $${upPrice} | DOWN: $${downPrice}

PRICE HISTORY:
${priceStructureText}

ORDERBOOK INTENT:
${orderbookSignal}

Analyze the early momentum. If the orderbook is strong and price is starting to move, enter the trade. Don't wait for 10 minutes to pass.`;
}

async function getAiPrediction(marketData) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'API key not configured' };

  const userPrompt = buildUserPrompt(marketData);

  try {
    const response = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://polymarket-bot.local',
        'X-Title': 'Polymarket AI Bot'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 1000
      })
    });

    const data = await response.json();
    const aiText = data.choices?.[0]?.message?.content || '';
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'Invalid response' };
    
    const decision = JSON.parse(jsonMatch[0]);
    if (decision.confidence === 'LOW') decision.action = 'SKIP';

    const fullDecision = {
      ...decision,
      coin: 'BTC',
      question: marketData.market.question,
      yesPrice: marketData.yesToken.price?.mid,
      noPrice: marketData.noToken.price?.mid,
      priceSequence: marketData.priceHistory?.slice(-12).map(p => p.price.toFixed(3)).join(' → ') || 'N/A',
      orderbookSignal: `UP Bids: ${parseFloat(marketData.yesToken.orderbook?.totalBidVolume || 0).toFixed(0)} vs DOWN Bids: ${parseFloat(marketData.noToken.orderbook?.totalBidVolume || 0).toFixed(0)}`,
      minutesLeft: marketData.market.minutesLeft,
      timestamp: new Date().toISOString()
    };

    logger.addAiDecision(fullDecision);
    return fullDecision;
  } catch (err) {
    return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: err.message };
  }
}

module.exports = { getAiPrediction, buildUserPrompt };
