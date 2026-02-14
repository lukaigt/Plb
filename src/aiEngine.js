const logger = require('./logger');
const krakenFeed = require('./krakenFeed');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'z-ai/glm-4.7-flash';

const SYSTEM_PROMPT = `You are an expert short-term crypto value analyst. You trade BTC 15-minute prediction markets on Polymarket.

YOUR JOB:
You receive TWO data sources:
1. REAL BTC PRICE from Kraken — the actual BTC/USD price, direction, and momentum right now
2. POLYMARKET PROBABILITY CANDLES — minute-by-minute UP probability in this 15-min prediction window

Your job is to find UNDERPRICED outcomes. The market probability often lags behind real BTC movement. When BTC is clearly moving UP but the UP probability is still cheap (0.10-0.40), that's a value buy. Same for DOWN.

HOW TO ANALYZE:

1. CHECK REAL BTC DIRECTION (most important)
   - Is BTC rising, falling, or flat in the last 1-5 minutes?
   - How strong is the move? $10 move = noise. $50+ move = real direction.
   - Is momentum accelerating or fading?

2. COMPARE WITH MARKET PROBABILITY
   - If BTC is clearly RISING but UP price is below 0.40 = UNDERPRICED, consider BUY_YES
   - If BTC is clearly FALLING but DOWN price is below 0.40 = UNDERPRICED, consider BUY_NO
   - If market probability MATCHES BTC direction and is already expensive (>0.60) = NO VALUE, SKIP
   - If BTC is flat/choppy = no edge, SKIP

3. VALUE ASSESSMENT
   - Entry at 0.10-0.20 = incredible value (5-10x payout). Only need slight edge.
   - Entry at 0.20-0.35 = good value (3-5x payout). Need moderate confidence.
   - Entry at 0.35-0.45 = fair value (2-3x payout). Need high confidence.
   - Entry above 0.45 = TOO EXPENSIVE. Always SKIP. The bot will block this anyway.

4. TIME REMAINING CONTEXT
   - More time left = more chance for trend to play out
   - Less time left = current BTC direction more likely to be final result
   - Under 3 minutes: only trade if BTC direction is STRONG and clear

5. PROBABILITY CANDLE CONFIRMATION
   - If probability candles are moving in SAME direction as BTC = market is catching up, still value if entry is cheap
   - If probability candles are moving OPPOSITE to BTC = market disagrees, could be extra value OR a warning
   - If probability is flat while BTC moves = market hasn't noticed yet, best value opportunity

CRITICAL RULES:
- BUY_YES = you think BTC will be ABOVE its starting price at market end (UP wins)
- BUY_NO = you think BTC will be BELOW its starting price at market end (DOWN wins)
- SKIP = no clear value, BTC is flat, or entry price is too high
- SKIP is your DEFAULT. Only trade when real BTC movement creates clear value.
- The cheaper the entry, the better. A 0.15 entry that wins pays 6.7x.
- Without Kraken data, you can still analyze probability candles but be MORE cautious.
- Never chase expensive outcomes. If the market already prices it correctly, there's no edge.

RESPOND IN THIS EXACT JSON FORMAT:
{"action": "BUY_YES" or "BUY_NO" or "SKIP", "confidence": "LOW" or "MEDIUM" or "HIGH", "pattern": "describe what you see (e.g. BTC rising + UP underpriced, momentum divergence, etc.)", "reasoning": "2-3 sentences explaining why this outcome is underpriced or why you're skipping"}`;

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

  let text = 'PROBABILITY CANDLE DATA (Polymarket UP probability):\n';
  candles.forEach(c => {
    const arrow = c.direction === 'UP' ? '^' : c.direction === 'DOWN' ? 'v' : '-';
    text += `  Min ${c.minute}: ${c.price.toFixed(4)} [${arrow} ${c.change >= 0 ? '+' : ''}${c.change.toFixed(4)}]\n`;
  });

  text += `\nPROBABILITY STRUCTURE:`;
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
  const { market, yesToken, noToken, priceHistory } = marketData;

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

  const btcPriceText = krakenFeed.buildPriceText();

  return `MARKET: "${market.question}"
TIME REMAINING: ${minutesLeft} minutes
ENTRY PRICES: UP=$${upPrice} | DOWN=$${downPrice}

${btcPriceText}

${candleData.text}

Compare the real BTC price movement with the market probability. Is one side UNDERPRICED given what BTC is actually doing? Only recommend a trade if the entry price offers real value (under $0.45). SKIP if BTC is flat, direction is unclear, or the market already prices it correctly.`;
}

async function getAiPrediction(marketData) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.addActivity('ai_error', { message: 'OpenRouter API key not configured' });
    return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'API key not configured' };
  }

  const userPrompt = buildUserPrompt(marketData);

  const btcCtx = krakenFeed.getPriceContext();
  const btcStatus = btcCtx.available ? `BTC $${btcCtx.currentPrice?.toLocaleString()} ${btcCtx.direction}` : 'No BTC data';

  logger.addActivity('ai_thinking', {
    message: `AI analyzing value opportunity... ${btcStatus}`,
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
      btcPrice: btcCtx.available ? btcCtx.currentPrice : null,
      btcDirection: btcCtx.available ? btcCtx.direction : 'unknown',
      btcMomentum: btcCtx.available ? btcCtx.momentum : 'unknown',
      rawPrompt: userPrompt,
      rawResponse: content
    };

    logger.addAiDecision(fullDecision);

    logger.addActivity('ai_decision', {
      message: `AI: ${decision.action} (${decision.confidence}) | ${decision.pattern} | BTC: ${btcStatus} | ${decision.reasoning}`,
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
