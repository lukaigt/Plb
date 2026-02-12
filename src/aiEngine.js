const logger = require('./logger');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'z-ai/glm-4.7-flash';

const SYSTEM_PROMPT = `You are an expert short-term crypto candle structure analyst. You trade BTC 15-minute prediction markets on Polymarket.

YOUR JOB:
You receive the minute-by-minute candle data for BTC's UP probability in a 15-minute window. Starting price is always around 0.50. You analyze the candle structure to predict where price goes in the remaining time.

HOW TO READ THE DATA:
Each "candle" is one minute. You see the price at each minute. From this you can calculate:
- Direction of each candle (up or down from previous)
- Size of each candle (how much it moved)
- Whether candles are getting BIGGER (momentum accelerating) or SMALLER (momentum exhausting)
- How far price has moved from the 0.50 starting point

KEY CONCEPTS YOU MUST USE:

1. OVERBOUGHT / OVERSOLD
   - Price moved from 0.50 to 0.62+ in a few minutes = OVERBOUGHT. Likely to pull back. Consider BUY_NO.
   - Price moved from 0.50 to 0.38- in a few minutes = OVERSOLD. Likely to bounce. Consider BUY_YES.
   - The faster the move, the more likely a reversal.

2. MOMENTUM EXHAUSTION
   - Candles getting SMALLER = the move is dying. Example: +0.05, +0.03, +0.01 = buyers are running out of steam.
   - Candles getting BIGGER = the move is accelerating. Don't fight it, ride it.
   - If the last 2-3 candles are tiny after a big move = the move is done, expect reversal.

3. SUPPORT / RESISTANCE
   - If price dropped to a level and bounced before, that's SUPPORT. Likely to bounce again.
   - If price rose to a level and got rejected before, that's RESISTANCE. Likely to get rejected again.
   - Round numbers (0.40, 0.45, 0.50, 0.55, 0.60) often act as support/resistance.

4. TREND STRENGTH
   - Consistent candles of similar size in one direction = healthy trend, ride it.
   - Example: +0.02, +0.02, +0.03, +0.02 = steady buying pressure, trend likely continues. BUY_YES.
   - Example: -0.03, -0.02, -0.03, -0.02 = steady selling, trend continues down. BUY_NO.

5. REVERSAL SIGNALS
   - Big move in one direction + stall (tiny candles) + one candle in opposite direction = REVERSAL starting.
   - V-shape: sharp drop then sharp recovery = strong reversal, buy the bounce.
   - Inverted V: sharp rise then sharp drop = failed rally, sell the top.

6. EARLY MARKET (only 1-2 candles available)
   - If price already moved from 0.50 to 0.53+ = early buyers are strong. Trend likely continues if the move is steady.
   - If price barely moved from 0.50 = no signal yet. SKIP.
   - One big candle from 0.50 to 0.56 = could be a spike that reverses. Be cautious, wait for confirmation or SKIP.

DECISION RULES:
- BUY_YES = you think price will be ABOVE the starting price at market end (BTC goes UP)
- BUY_NO = you think price will be BELOW the starting price at market end (BTC goes DOWN)
- SKIP = no clear signal, choppy, flat, or conflicting structure

- ONLY enter when price is between 0.40 and 0.60 (good risk/reward)
- If price is already past 0.65 or below 0.35 and the move looks exhausted = too late, SKIP
- SKIP is still your default for unclear structures
- You can decide with as few as 1-2 candles IF the structure is clear
- Don't follow the crowd. The buy/sell prices reflect what people THINK. The candles show what ACTUALLY happened. Trust the candles.

RESPOND IN THIS EXACT JSON FORMAT:
{"action": "BUY_YES" or "BUY_NO" or "SKIP", "confidence": "LOW" or "MEDIUM" or "HIGH", "pattern": "describe what you see (e.g. oversold bounce, momentum exhaustion, steady uptrend, etc.)", "reasoning": "2-3 sentences explaining the candle structure analysis"}`;

function buildCandleData(priceHistory) {
  if (!priceHistory || priceHistory.length === 0) {
    return { text: 'No candle data yet — market just opened.', candles: [], summary: null };
  }

  const prices = priceHistory.slice(-14).map(p => p.price);
  const candles = [];

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    if (i === 0) {
      candles.push({
        minute: i + 1,
        price,
        change: 0,
        direction: 'START',
        size: 0
      });
    } else {
      const change = price - prices[i - 1];
      candles.push({
        minute: i + 1,
        price,
        change,
        direction: change > 0.002 ? 'UP' : change < -0.002 ? 'DOWN' : 'FLAT',
        size: Math.abs(change)
      });
    }
  }

  const first = prices[0];
  const last = prices[prices.length - 1];
  const totalMove = last - first;
  const peak = Math.max(...prices);
  const low = Math.min(...prices);

  const recentCandles = candles.slice(-3);
  const recentSizes = recentCandles.map(c => c.size);
  const earlierCandles = candles.slice(Math.max(0, candles.length - 6), Math.max(0, candles.length - 3));
  const earlierSizes = earlierCandles.map(c => c.size);

  const recentAvgSize = recentSizes.length > 0 ? recentSizes.reduce((a, b) => a + b, 0) / recentSizes.length : 0;
  const earlierAvgSize = earlierSizes.length > 0 ? earlierSizes.reduce((a, b) => a + b, 0) / earlierSizes.length : 0;

  let momentumState = 'STEADY';
  if (earlierAvgSize > 0 && recentAvgSize < earlierAvgSize * 0.5) {
    momentumState = 'EXHAUSTING — candles getting smaller, move is dying';
  } else if (earlierAvgSize > 0 && recentAvgSize > earlierAvgSize * 1.5) {
    momentumState = 'ACCELERATING — candles getting bigger, move is strengthening';
  }

  let positionState = 'NEUTRAL';
  if (last >= 0.62) positionState = 'OVERBOUGHT — price far above 0.50';
  else if (last >= 0.56) positionState = 'SLIGHTLY OVERBOUGHT';
  else if (last <= 0.38) positionState = 'OVERSOLD — price far below 0.50';
  else if (last <= 0.44) positionState = 'SLIGHTLY OVERSOLD';

  let text = 'CANDLE-BY-CANDLE DATA:\n';
  candles.forEach(c => {
    const arrow = c.direction === 'UP' ? '^' : c.direction === 'DOWN' ? 'v' : '-';
    text += `  Min ${c.minute}: ${c.price.toFixed(4)} [${arrow} ${c.change >= 0 ? '+' : ''}${c.change.toFixed(4)}]\n`;
  });

  text += `\nSTRUCTURE SUMMARY:`;
  text += `\n  Start: ${first.toFixed(4)} → Current: ${last.toFixed(4)} | Total move: ${totalMove >= 0 ? '+' : ''}${totalMove.toFixed(4)}`;
  text += `\n  Peak: ${peak.toFixed(4)} | Low: ${low.toFixed(4)}`;
  text += `\n  Position: ${positionState}`;
  text += `\n  Momentum: ${momentumState}`;
  text += `\n  Candles: ${candles.length}`;

  return {
    text,
    candles,
    summary: {
      first, last, totalMove, peak, low,
      positionState, momentumState,
      candleCount: candles.length
    }
  };
}

function buildUserPrompt(marketData) {
  const { market, yesToken, noToken, priceTrend, priceHistory } = marketData;

  let minutesLeft = market.minutesLeft || 0;
  if (market.endTime) {
    const end = new Date(market.endTime);
    const now = new Date();
    const diffMin = Math.round((end - now) / (1000 * 60));
    if (diffMin > 0) minutesLeft = diffMin;
  }

  const candleData = buildCandleData(priceHistory);

  const upPrice = yesToken.price?.mid?.toFixed(3) || '0.500';
  const downPrice = noToken.price?.mid?.toFixed(3) || '0.500';

  return `MARKET: "${market.question}"
TIME REMAINING: ${minutesLeft} minutes
CURRENT PRICES: UP=$${upPrice} | DOWN=$${downPrice}

${candleData.text}

Analyze the candle structure. Is it overbought/oversold? Is momentum exhausting or accelerating? Any support/resistance levels? What does the structure tell you about where price goes next?`;
}

async function getAiPrediction(marketData) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.addActivity('ai_error', { message: 'OpenRouter API key not configured' });
    return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'API key not configured' };
  }

  const userPrompt = buildUserPrompt(marketData);

  logger.addActivity('ai_thinking', {
    message: `AI analyzing BTC candle structure...`,
    coin: 'BTC'
  });

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
        max_tokens: 1500,
        reasoning: { enabled: false }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.addActivity('ai_error', { message: `API error: ${response.status} - ${errText.substring(0, 200)}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `API error: ${response.status}` };
    }

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      logger.addActivity('ai_error', { message: `Bad API response: ${rawText.substring(0, 300)}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'Invalid API response' };
    }

    if (data.error) {
      logger.addActivity('ai_error', { message: `API error: ${JSON.stringify(data.error).substring(0, 200)}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `API error` };
    }

    const content = data.choices?.[0]?.message?.content || '';
    if (!content) {
      logger.addActivity('ai_error', { message: 'Empty AI response' });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'Empty response' };
    }

    let decision;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON');
      decision = JSON.parse(jsonMatch[0]);
    } catch (e) {
      logger.addActivity('ai_error', { message: `Parse error: ${content.substring(0, 200)}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `Parse error` };
    }

    if (decision.action === 'BUY_UP') decision.action = 'BUY_YES';
    if (decision.action === 'BUY_DOWN') decision.action = 'BUY_NO';
    if (!['BUY_YES', 'BUY_NO', 'SKIP'].includes(decision.action)) decision.action = 'SKIP';
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(decision.confidence)) decision.confidence = 'LOW';
    if (decision.confidence === 'LOW') decision.action = 'SKIP';
    if (!decision.pattern) decision.pattern = 'not identified';

    const priceHistory = marketData.priceHistory || [];
    const priceSequence = priceHistory.slice(-14).map(p => p.price.toFixed(3)).join(' → ') || 'N/A';

    const candleData = buildCandleData(priceHistory);

    const fullDecision = {
      ...decision,
      coin: 'BTC',
      question: marketData.market.question,
      yesPrice: marketData.yesToken.price?.mid,
      noPrice: marketData.noToken.price?.mid,
      priceSequence,
      orderbookSignal: candleData.summary ? `${candleData.summary.positionState} | ${candleData.summary.momentumState}` : 'N/A',
      minutesLeft: marketData.market.minutesLeft,
      candleCount: candleData.summary?.candleCount || 0,
      totalMove: candleData.summary?.totalMove?.toFixed(4) || '0',
      positionState: candleData.summary?.positionState || 'unknown',
      momentumState: candleData.summary?.momentumState || 'unknown',
      rawPrompt: userPrompt,
      rawResponse: content
    };

    logger.addAiDecision(fullDecision);

    logger.addActivity('ai_decision', {
      message: `AI: ${decision.action} (${decision.confidence}) | ${decision.pattern} | ${decision.reasoning}`,
      coin: 'BTC',
      action: decision.action,
      confidence: decision.confidence,
      pattern: decision.pattern
    });

    return fullDecision;
  } catch (err) {
    logger.addActivity('ai_error', { message: `AI failed: ${err.message}` });
    return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `Error: ${err.message}` };
  }
}

module.exports = { getAiPrediction, buildUserPrompt };
