const logger = require('./logger');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'z-ai/glm-4.7-flash';

const SYSTEM_PROMPT = `You are an expert short-term prediction market analyst. You analyze Polymarket 15-minute crypto Up/Down markets. These markets ask: "Will this crypto's price be HIGHER or LOWER at the end of this 15-minute window compared to the start?"

YOUR STRATEGY: MEAN REVERSION + ORDERBOOK READING

HOW THESE MARKETS WORK:
- When a 15-minute window opens, UP and DOWN both start near $0.50 (50/50)
- As traders react to early price movements, they push the probability one direction
- The crowd frequently OVERREACTS — pushing probability to 65-75%+ based on small moves
- These overreactions often REVERSE before the window closes because:
  * Small crypto moves in the first 5 minutes don't predict the full 15 minutes
  * Panic buyers create artificial momentum that fades
  * Market makers step in to correct mispricings

YOUR ANALYSIS FRAMEWORK:

1. ORDERBOOK ANALYSIS (most important signal):
   - Compare bid volume vs ask volume on BOTH the UP and DOWN tokens
   - If one side has significantly more bid volume (1.5x+), that's where informed money is positioning
   - The orderbook shows where people are PLACING LIMIT ORDERS — this is smarter money than market orders
   - If the UP orderbook has way more bids than the DOWN orderbook, smart money expects UP
   - If the DOWN orderbook has way more bids than the UP orderbook, smart money expects DOWN
   - If bid volumes are roughly equal, there's no clear signal — SKIP

2. OVERREACTION DETECTION:
   - If UP price spiked above 0.65 rapidly (big jump in last 1-3 data points) AND momentum is now decelerating → the spike is fading, consider BUY_NO
   - If DOWN price spiked above 0.65 rapidly AND momentum is decelerating → consider BUY_YES
   - If prices moved gradually and steadily (not a spike), this is NOT an overreaction — be cautious

3. MOMENTUM QUALITY:
   - Accelerating momentum = the move is real, do NOT bet against it
   - Stable/steady momentum = the move might continue, be cautious
   - Decelerating momentum = the move is running out of steam, potential reversal
   - Only bet against moves with DECELERATING momentum

4. TIME REMAINING:
   - 10-12 minutes left: Very early, not enough data, prefer SKIP
   - 5-10 minutes left: Sweet spot — enough data to read patterns, enough time for reversal
   - 3-5 minutes left: Only trade if signal is very strong, less time for reversal
   - Less than 3 minutes left: ALWAYS SKIP — not enough time

DECISION RULES:

SKIP (your DEFAULT response — use this 60-70% of the time):
- No clear orderbook imbalance (bid volumes roughly equal)
- Prices near 50/50 (between 0.42-0.58) — no signal yet
- Momentum is accelerating — don't fight a strong move
- Less than 3 minutes or more than 12 minutes remaining
- Conflicting signals (orderbook says one thing, price says another)
- Price history data is insufficient (less than 3 data points)

BUY_YES (bet on UP):
- DOWN token is overpriced (UP price dropped below 0.40) with decelerating downward momentum
- UP orderbook shows significantly stronger bid volume than DOWN orderbook (1.5x+)
- Price trend was dropping but is now flattening or reversing upward
- Time remaining is 3-10 minutes (enough time for mean reversion)

BUY_NO (bet on DOWN):
- UP token is overpriced (UP price above 0.60) with decelerating upward momentum
- DOWN orderbook shows significantly stronger bid volume than UP orderbook (1.5x+)
- Price trend was rising but is now flattening or reversing downward
- Time remaining is 3-10 minutes

CRITICAL RULES:
- NEVER chase momentum. If price is trending strongly in one direction with accelerating momentum, SKIP
- NEVER trade when orderbook signals conflict with price action — SKIP instead
- You need AT LEAST 2 confirming signals to trade (orderbook + momentum fade, or orderbook + overreaction)
- When in doubt, ALWAYS SKIP. Missing a good trade costs nothing. Taking a bad trade costs money.
- Be honest about uncertainty. If you're less than 65% confident, SKIP.

You MUST respond in this EXACT JSON format and nothing else:
{"action": "BUY_YES" or "BUY_NO" or "SKIP", "confidence": "LOW" or "MEDIUM" or "HIGH", "reasoning": "your explanation here"}`;

function buildUserPrompt(marketData) {
  const { market, yesToken, noToken, priceTrend, priceHistory, spread } = marketData;

  const upPrice = yesToken.price?.mid?.toFixed(3) || 'N/A';
  const downPrice = noToken.price?.mid?.toFixed(3) || 'N/A';
  const upBuy = yesToken.price?.buy?.toFixed(3) || 'N/A';
  const upSell = yesToken.price?.sell?.toFixed(3) || 'N/A';
  const downBuy = noToken.price?.buy?.toFixed(3) || 'N/A';
  const downSell = noToken.price?.sell?.toFixed(3) || 'N/A';

  let timeRemaining = 'Unknown';
  let minutesLeft = market.minutesLeft || 0;
  if (market.endTime) {
    const end = new Date(market.endTime);
    const now = new Date();
    const diffMin = Math.round((end - now) / (1000 * 60));
    if (diffMin > 0) {
      timeRemaining = `${diffMin} minutes`;
      minutesLeft = diffMin;
    } else {
      timeRemaining = 'Expired or very soon';
    }
  }

  let priceHistoryText = 'No price history available';
  if (priceHistory && priceHistory.length > 0) {
    const recent = priceHistory.slice(-10);
    priceHistoryText = recent.map((p, i) => {
      const idx = recent.length - 1 - i;
      return `  ${idx} points ago: UP probability = ${p.price.toFixed(4)}`;
    }).join('\n');

    if (recent.length >= 2) {
      const first = recent[0].price;
      const last = recent[recent.length - 1].price;
      const mid = recent[Math.floor(recent.length / 2)].price;
      const peakPrice = Math.max(...recent.map(p => p.price));
      const lowPrice = Math.min(...recent.map(p => p.price));
      priceHistoryText += `\n\n  PATTERN SUMMARY:`;
      priceHistoryText += `\n  Start: ${first.toFixed(4)} → Middle: ${mid.toFixed(4)} → Latest: ${last.toFixed(4)}`;
      priceHistoryText += `\n  Peak: ${peakPrice.toFixed(4)} | Low: ${lowPrice.toFixed(4)} | Range: ${(peakPrice - lowPrice).toFixed(4)}`;
      if (last > first && last < peakPrice) {
        priceHistoryText += `\n  Pattern: Rose then pulled back from peak (possible overreaction reverting)`;
      } else if (last < first && last > lowPrice) {
        priceHistoryText += `\n  Pattern: Dropped then bounced from low (possible overreaction reverting)`;
      } else if (last >= peakPrice) {
        priceHistoryText += `\n  Pattern: Steady climb to current high (momentum still active)`;
      } else if (last <= lowPrice) {
        priceHistoryText += `\n  Pattern: Steady decline to current low (momentum still active)`;
      }
    }
  }

  let upOrderbookText = 'No UP orderbook data';
  let downOrderbookText = 'No DOWN orderbook data';
  let orderbookComparison = 'Cannot compare — missing data';

  if (yesToken.orderbook) {
    const ob = yesToken.orderbook;
    upOrderbookText = `  Best Bid: ${ob.bestBid || 'N/A'} | Best Ask: ${ob.bestAsk || 'N/A'}
    Total Bid Volume: ${ob.totalBidVolume} shares | Total Ask Volume: ${ob.totalAskVolume} shares
    Bid/Ask Ratio: ${ob.bidAskRatio} (>1 means more buy pressure)
    Spread: ${ob.spread || 'N/A'} | Depth: ${ob.depth} levels`;
  }

  if (noToken.orderbook) {
    const ob = noToken.orderbook;
    downOrderbookText = `  Best Bid: ${ob.bestBid || 'N/A'} | Best Ask: ${ob.bestAsk || 'N/A'}
    Total Bid Volume: ${ob.totalBidVolume} shares | Total Ask Volume: ${ob.totalAskVolume} shares
    Bid/Ask Ratio: ${ob.bidAskRatio} (>1 means more buy pressure)
    Spread: ${ob.spread || 'N/A'}`;
  }

  if (yesToken.orderbook && noToken.orderbook) {
    const upBids = parseFloat(yesToken.orderbook.totalBidVolume) || 0;
    const downBids = parseFloat(noToken.orderbook.totalBidVolume) || 0;
    const ratio = downBids > 0 ? (upBids / downBids).toFixed(2) : 'N/A';

    if (upBids > downBids * 1.5) {
      orderbookComparison = `UP orderbook has ${ratio}x more bid volume than DOWN — smart money favoring UP (${upBids.toFixed(0)} vs ${downBids.toFixed(0)} shares)`;
    } else if (downBids > upBids * 1.5) {
      orderbookComparison = `DOWN orderbook has ${(downBids / upBids).toFixed(2)}x more bid volume than UP — smart money favoring DOWN (${downBids.toFixed(0)} vs ${upBids.toFixed(0)} shares)`;
    } else {
      orderbookComparison = `Bid volumes roughly equal (UP: ${upBids.toFixed(0)}, DOWN: ${downBids.toFixed(0)}) — no clear smart money signal`;
    }
  }

  return `MARKET: "${market.question}"
COIN: ${market.coin}
TIME REMAINING: ${timeRemaining} (${minutesLeft} minutes left)

CURRENT PRICES:
  UP price: $${upPrice} (market thinks ${upPrice !== 'N/A' ? (parseFloat(upPrice) * 100).toFixed(1) : '?'}% chance of going UP)
  DOWN price: $${downPrice} (market thinks ${downPrice !== 'N/A' ? (parseFloat(downPrice) * 100).toFixed(1) : '?'}% chance of going DOWN)
  UP buy/sell: $${upBuy} / $${upSell}
  DOWN buy/sell: $${downBuy} / $${downSell}

UP TOKEN PRICE HISTORY:
${priceHistoryText}

TREND ANALYSIS:
  Direction: ${priceTrend.direction}
  Momentum: ${priceTrend.momentum}
  Recent avg change: ${priceTrend.recentChange}
  Overall change: ${priceTrend.totalChange}%
  Summary: ${priceTrend.summary}

UP TOKEN ORDERBOOK:
${upOrderbookText}

DOWN TOKEN ORDERBOOK:
${downOrderbookText}

ORDERBOOK COMPARISON (key signal):
${orderbookComparison}

SPREAD: ${spread || 'N/A'}

Based on your analysis framework — check orderbook imbalance, detect overreactions, assess momentum quality, and verify time window — what is your decision? Remember: SKIP is the default. Only trade when you have at least 2 confirming signals.`;
}

async function getAiPrediction(marketData) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.addActivity('ai_error', { message: 'OpenRouter API key not configured' });
    return { action: 'SKIP', confidence: 'LOW', reasoning: 'API key not configured' };
  }

  const userPrompt = buildUserPrompt(marketData);

  logger.addActivity('ai_thinking', {
    message: `AI analyzing ${marketData.market.coin} market: ${marketData.market.question}`,
    coin: marketData.market.coin
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
      return { action: 'SKIP', confidence: 'LOW', reasoning: `API error: ${response.status}` };
    }

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      logger.addActivity('ai_error', { message: `Failed to parse API response: ${rawText.substring(0, 500)}` });
      return { action: 'SKIP', confidence: 'LOW', reasoning: 'Invalid API response format' };
    }

    if (data.error) {
      logger.addActivity('ai_error', { message: `OpenRouter error: ${JSON.stringify(data.error).substring(0, 300)}` });
      return { action: 'SKIP', confidence: 'LOW', reasoning: `API error: ${data.error.message || 'Unknown'}` };
    }

    const content = data.choices?.[0]?.message?.content;
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning;
    const finishReason = data.choices?.[0]?.finish_reason;

    if (finishReason === 'length') {
      logger.addActivity('ai_error', { message: `AI response cut off (token limit reached)` });
    }

    if (!content && !reasoningContent) {
      logger.addActivity('ai_error', { message: `Empty AI response. Full response: ${JSON.stringify(data).substring(0, 500)}` });
      return { action: 'SKIP', confidence: 'LOW', reasoning: 'Empty AI response' };
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
      logger.addActivity('ai_error', { message: `Failed to parse AI response: ${aiText.substring(0, 300)}` });
      return { action: 'SKIP', confidence: 'LOW', reasoning: `Parse error: ${aiText.substring(0, 200)}` };
    }

    if (decision.action === 'BUY_UP') decision.action = 'BUY_YES';
    if (decision.action === 'BUY_DOWN') decision.action = 'BUY_NO';
    if (!['BUY_YES', 'BUY_NO', 'SKIP'].includes(decision.action)) {
      decision.action = 'SKIP';
    }
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(decision.confidence)) {
      decision.confidence = 'LOW';
    }
    if (decision.confidence === 'LOW') {
      decision.action = 'SKIP';
    }

    const fullDecision = {
      ...decision,
      coin: marketData.market.coin,
      question: marketData.market.question,
      targetPrice: marketData.market.targetPrice,
      yesPrice: marketData.yesToken.price?.mid,
      noPrice: marketData.noToken.price?.mid,
      trendDirection: marketData.priceTrend.direction,
      momentum: marketData.priceTrend.momentum,
      dataSnapshot: {
        yesPrice: marketData.yesToken.price,
        noPrice: marketData.noToken.price,
        trend: marketData.priceTrend,
        upOrderbookBids: marketData.yesToken.orderbook?.totalBidVolume,
        downOrderbookBids: marketData.noToken.orderbook?.totalBidVolume,
        orderbookRatio: marketData.yesToken.orderbook?.bidAskRatio
      },
      rawPrompt: userPrompt,
      rawResponse: aiText
    };

    logger.addAiDecision(fullDecision);

    logger.addActivity('ai_decision', {
      message: `AI decision for ${marketData.market.coin}: ${decision.action} (${decision.confidence}) - ${decision.reasoning}`,
      coin: marketData.market.coin,
      action: decision.action,
      confidence: decision.confidence
    });

    return fullDecision;
  } catch (err) {
    logger.addActivity('ai_error', { message: `AI prediction failed: ${err.message}` });
    return { action: 'SKIP', confidence: 'LOW', reasoning: `Error: ${err.message}` };
  }
}

module.exports = { getAiPrediction, buildUserPrompt };
