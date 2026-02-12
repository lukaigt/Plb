const logger = require('./logger');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'z-ai/glm-4.7-flash';

const SYSTEM_PROMPT = `You are an expert short-term price action trader. You analyze BTC 15-minute prediction markets on Polymarket by reading price structure patterns.

WHAT YOU'RE LOOKING AT:
You receive the minute-by-minute history of BTC's UP probability in a 15-minute window. This probability mirrors BTC's actual price movement — when BTC goes up, UP probability rises; when BTC drops, it falls. Your job is to read the SHAPE of this price movement and predict what happens in the remaining time.

BULLISH PATTERNS (price likely continues UP → BUY_YES):
- Steady staircase up: 0.50 → 0.52 → 0.54 → 0.56 → 0.58 (consistent small gains, healthy trend that tends to continue)
- Higher lows: 0.50 → 0.55 → 0.53 → 0.57 → 0.55 → 0.59 (pullbacks are shallow, each push goes higher — strong buyers)
- V-recovery: 0.50 → 0.44 → 0.42 → 0.46 → 0.50 → 0.53 (sharp drop fully recovered and pushed higher — buyers took control)
- Breakout from flat: 0.50 → 0.50 → 0.51 → 0.51 → 0.54 → 0.56 (consolidation then decisive move UP)

BEARISH PATTERNS (price likely continues DOWN → BUY_NO):
- Steady staircase down: 0.50 → 0.48 → 0.46 → 0.44 → 0.42 (consistent drops, sellers in control)
- Lower highs: 0.50 → 0.45 → 0.48 → 0.43 → 0.46 → 0.41 (bounces get weaker, each drop goes deeper)
- Inverted V: 0.50 → 0.58 → 0.62 → 0.58 → 0.54 → 0.50 (spike completely failed and reversed — sellers overwhelmed buyers)
- Breakdown from flat: 0.50 → 0.50 → 0.49 → 0.49 → 0.46 → 0.43 (consolidation then decisive move DOWN)

NO-TRADE PATTERNS (SKIP — this is your DEFAULT answer, use 60-70% of the time):
- Choppy/noise: 0.50 → 0.53 → 0.48 → 0.52 → 0.47 → 0.51 (random bouncing, no direction, pure noise)
- Flat/dead: 0.50 → 0.50 → 0.51 → 0.50 → 0.49 → 0.50 (nothing happening, no signal)
- Exhausted move: price already above 0.65 or below 0.35 and flattening (the big move already happened, too late to enter, bad value)
- Contradicting: first half went one way, second half going the other way (unclear who's winning)
- Too few data points: less than 4 price points means not enough structure to read

HOW TO DECIDE:
1. Look at the minute-by-minute prices — what SHAPE do they make?
2. Does it match one of the patterns above? Which one specifically?
3. Check the orderbook: does the bid/ask volume support your reading? (If you see bullish pattern but orderbook shows heavy selling, that's a conflict — SKIP)
4. Check your entry price: will you be buying between 0.40-0.60? (Outside this range = bad risk/reward = SKIP)
5. You need the pattern to be CLEAR. A vague resemblance is NOT enough to trade.

CRITICAL RULES:
- SKIP is your default. You should skip 60-70% of opportunities.
- Never trade a choppy or flat structure — there is no edge in randomness.
- Never enter when price already moved past 0.65 or below 0.35 — the move happened, you missed it.
- You MUST name which specific pattern you identified.
- If the pattern is unclear or could match multiple patterns — SKIP.
- If orderbook contradicts the pattern — SKIP.
- Quality over quantity. One good trade beats five bad ones.

You MUST respond in this EXACT JSON format and nothing else:
{"action": "BUY_YES" or "BUY_NO" or "SKIP", "confidence": "LOW" or "MEDIUM" or "HIGH", "pattern": "name the specific pattern", "reasoning": "2-3 sentences explaining what shape you see in the price data and why"}`;

function buildUserPrompt(marketData) {
  const { market, yesToken, noToken, priceTrend, priceHistory, spread } = marketData;

  const upPrice = yesToken.price?.mid?.toFixed(3) || 'N/A';
  const downPrice = noToken.price?.mid?.toFixed(3) || 'N/A';
  const upBuy = yesToken.price?.buy?.toFixed(3) || 'N/A';
  const upSell = yesToken.price?.sell?.toFixed(3) || 'N/A';
  const downBuy = noToken.price?.buy?.toFixed(3) || 'N/A';
  const downSell = noToken.price?.sell?.toFixed(3) || 'N/A';

  let minutesLeft = market.minutesLeft || 0;
  if (market.endTime) {
    const end = new Date(market.endTime);
    const now = new Date();
    const diffMin = Math.round((end - now) / (1000 * 60));
    if (diffMin > 0) minutesLeft = diffMin;
  }

  let priceStructureText = 'No price history available — SKIP (not enough data)';
  let structureSummary = '';
  if (priceHistory && priceHistory.length > 0) {
    const recent = priceHistory.slice(-12);
    const prices = recent.map(p => p.price);

    priceStructureText = 'MINUTE-BY-MINUTE UP PROBABILITY:\n';
    priceStructureText += prices.map((p, i) => `  Point ${i + 1}: ${p.toFixed(4)}`).join('\n');
    priceStructureText += '\n\n  Sequence: ' + prices.map(p => p.toFixed(3)).join(' → ');

    if (prices.length >= 3) {
      const first = prices[0];
      const last = prices[prices.length - 1];
      const mid = prices[Math.floor(prices.length / 2)];
      const peak = Math.max(...prices);
      const low = Math.min(...prices);
      const range = peak - low;

      let changes = [];
      let upCount = 0;
      let downCount = 0;
      for (let i = 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        changes.push(diff);
        if (diff > 0.005) upCount++;
        else if (diff < -0.005) downCount++;
      }

      const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
      const recentChanges = changes.slice(-3);
      const recentAvg = recentChanges.reduce((a, b) => a + b, 0) / recentChanges.length;

      structureSummary = `\n  STRUCTURE SUMMARY:`;
      structureSummary += `\n  Start: ${first.toFixed(4)} → Middle: ${mid.toFixed(4)} → Current: ${last.toFixed(4)}`;
      structureSummary += `\n  Peak: ${peak.toFixed(4)} | Low: ${low.toFixed(4)} | Range: ${range.toFixed(4)}`;
      structureSummary += `\n  Up moves: ${upCount} | Down moves: ${downCount} | Flat moves: ${changes.length - upCount - downCount}`;
      structureSummary += `\n  Overall direction: ${avgChange > 0.003 ? 'RISING' : avgChange < -0.003 ? 'FALLING' : 'SIDEWAYS'}`;
      structureSummary += `\n  Recent momentum: ${recentAvg > 0.003 ? 'PUSHING UP' : recentAvg < -0.003 ? 'PUSHING DOWN' : 'FLAT/MIXED'}`;

      if (last > first + 0.05 && last >= peak - 0.02) {
        structureSummary += `\n  Shape note: Steady climb to current high`;
      } else if (last < first - 0.05 && last <= low + 0.02) {
        structureSummary += `\n  Shape note: Steady decline to current low`;
      } else if (last > first && last < peak - 0.03) {
        structureSummary += `\n  Shape note: Rose then pulled back from peak`;
      } else if (last < first && last > low + 0.03) {
        structureSummary += `\n  Shape note: Dropped then bounced from low`;
      } else if (range < 0.05) {
        structureSummary += `\n  Shape note: Narrow range — mostly flat/choppy`;
      }

      priceStructureText += structureSummary;
    }
  }

  let orderbookText = 'No orderbook data available';
  let orderbookSignal = 'UNKNOWN';
  if (yesToken.orderbook && noToken.orderbook) {
    const upBids = parseFloat(yesToken.orderbook.totalBidVolume) || 0;
    const downBids = parseFloat(noToken.orderbook.totalBidVolume) || 0;
    const upAsks = parseFloat(yesToken.orderbook.totalAskVolume) || 0;
    const downAsks = parseFloat(noToken.orderbook.totalAskVolume) || 0;

    orderbookText = `UP TOKEN: Bids=${upBids.toFixed(0)} shares, Asks=${upAsks.toFixed(0)} shares, Bid/Ask=${yesToken.orderbook.bidAskRatio}, Best Bid=${yesToken.orderbook.bestBid || 'N/A'}, Best Ask=${yesToken.orderbook.bestAsk || 'N/A'}`;
    orderbookText += `\n  DOWN TOKEN: Bids=${downBids.toFixed(0)} shares, Asks=${downAsks.toFixed(0)} shares, Bid/Ask=${noToken.orderbook.bidAskRatio}, Best Bid=${noToken.orderbook.bestBid || 'N/A'}, Best Ask=${noToken.orderbook.bestAsk || 'N/A'}`;

    if (upBids > downBids * 1.5) {
      orderbookSignal = `FAVORS UP — UP token has ${(upBids / downBids).toFixed(1)}x more bid volume (${upBids.toFixed(0)} vs ${downBids.toFixed(0)})`;
    } else if (downBids > upBids * 1.5) {
      orderbookSignal = `FAVORS DOWN — DOWN token has ${(downBids / upBids).toFixed(1)}x more bid volume (${downBids.toFixed(0)} vs ${upBids.toFixed(0)})`;
    } else {
      orderbookSignal = `NEUTRAL — bid volumes roughly equal (UP: ${upBids.toFixed(0)}, DOWN: ${downBids.toFixed(0)})`;
    }
  }

  return `MARKET: "${market.question}"
TIME REMAINING: ${minutesLeft} minutes

CURRENT PRICES:
  UP: $${upPrice} (buy at $${upBuy}, sell at $${upSell})
  DOWN: $${downPrice} (buy at $${downBuy}, sell at $${downSell})

PRICE STRUCTURE (this is the key data — read the shape):
${priceStructureText}

ORDERBOOK:
  ${orderbookText}
  SIGNAL: ${orderbookSignal}

Read the price structure shape. Which pattern does it match? Does the orderbook confirm? Is the entry price reasonable (0.40-0.60)? If everything aligns, trade. Otherwise, SKIP.`;
}

async function getAiPrediction(marketData) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.addActivity('ai_error', { message: 'OpenRouter API key not configured' });
    return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'API key not configured' };
  }

  const userPrompt = buildUserPrompt(marketData);

  logger.addActivity('ai_thinking', {
    message: `AI analyzing BTC market: ${marketData.market.question}`,
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
        max_tokens: 2000,
        reasoning: { enabled: false }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.addActivity('ai_error', { message: `OpenRouter API error: ${response.status} - ${errText}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `API error: ${response.status}` };
    }

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      logger.addActivity('ai_error', { message: `Failed to parse API response: ${rawText.substring(0, 500)}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'Invalid API response format' };
    }

    if (data.error) {
      logger.addActivity('ai_error', { message: `OpenRouter error: ${JSON.stringify(data.error).substring(0, 300)}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `API error: ${data.error.message || 'Unknown'}` };
    }

    const content = data.choices?.[0]?.message?.content;
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning;

    if (!content && !reasoningContent) {
      logger.addActivity('ai_error', { message: `Empty AI response` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: 'Empty AI response' };
    }

    const aiText = content || reasoningContent || '';

    let decision;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        decision = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseErr) {
      logger.addActivity('ai_error', { message: `Failed to parse AI decision: ${aiText.substring(0, 300)}` });
      return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `Parse error: ${aiText.substring(0, 200)}` };
    }

    if (decision.action === 'BUY_UP') decision.action = 'BUY_YES';
    if (decision.action === 'BUY_DOWN') decision.action = 'BUY_NO';
    if (!['BUY_YES', 'BUY_NO', 'SKIP'].includes(decision.action)) decision.action = 'SKIP';
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(decision.confidence)) decision.confidence = 'LOW';
    if (decision.confidence === 'LOW') decision.action = 'SKIP';
    if (!decision.pattern) decision.pattern = 'not identified';

    const priceHistory = marketData.priceHistory || [];
    const priceSequence = priceHistory.slice(-12).map(p => p.price.toFixed(3)).join(' → ');

    const upBids = parseFloat(marketData.yesToken.orderbook?.totalBidVolume) || 0;
    const downBids = parseFloat(marketData.noToken.orderbook?.totalBidVolume) || 0;
    let orderbookSignal = 'neutral';
    if (upBids > downBids * 1.5) orderbookSignal = 'favors UP';
    else if (downBids > upBids * 1.5) orderbookSignal = 'favors DOWN';

    const fullDecision = {
      ...decision,
      coin: 'BTC',
      question: marketData.market.question,
      yesPrice: marketData.yesToken.price?.mid,
      noPrice: marketData.noToken.price?.mid,
      priceSequence,
      orderbookSignal,
      upBidVolume: upBids,
      downBidVolume: downBids,
      minutesLeft: marketData.market.minutesLeft,
      trendDirection: marketData.priceTrend.direction,
      momentum: marketData.priceTrend.momentum,
      rawPrompt: userPrompt,
      rawResponse: aiText
    };

    logger.addAiDecision(fullDecision);

    logger.addActivity('ai_decision', {
      message: `AI decision: ${decision.action} (${decision.confidence}) | Pattern: ${decision.pattern} | ${decision.reasoning}`,
      coin: 'BTC',
      action: decision.action,
      confidence: decision.confidence,
      pattern: decision.pattern
    });

    return fullDecision;
  } catch (err) {
    logger.addActivity('ai_error', { message: `AI prediction failed: ${err.message}` });
    return { action: 'SKIP', confidence: 'LOW', pattern: 'none', reasoning: `Error: ${err.message}` };
  }
}

module.exports = { getAiPrediction, buildUserPrompt };
