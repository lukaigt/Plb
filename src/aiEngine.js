const logger = require('./logger');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'glm-4-flash';

const SYSTEM_PROMPT = `You are an expert crypto price analyst and short-term trader. Your ONLY job is to predict whether a cryptocurrency's price will go UP or DOWN in the next 15 minutes based on the data provided to you.

You analyze:
1. Price trend direction - Is the YES price (probability) rising or falling?
2. Momentum - Is the movement accelerating, steady, or slowing down?
3. Orderbook imbalance - Which side has more volume? More bids = bullish sentiment, more asks = bearish
4. Distance to resolution - How much time is left and how far is the current probability from certainty?
5. Market sentiment - What does the current YES/NO price split tell you about crowd expectations?

RULES:
- If you believe the crypto price WILL GO UP (hit target / go above current level) → respond BUY_YES (or BUY_UP)
- If you believe the crypto price WILL GO DOWN (miss target / drop below current level) → respond BUY_NO (or BUY_DOWN)
- If you are NOT confident enough or data is unclear or sideways → respond SKIP
- NEVER guess blindly. If data is insufficient or contradictory, ALWAYS SKIP.
- Be conservative. Only trade when you see a clear signal.
- You must give a confidence level: LOW, MEDIUM, or HIGH
- LOW confidence = ALWAYS SKIP, do not trade
- You must explain your reasoning in 2-4 sentences
- These are 15-minute markets that resolve quickly, so focus on short-term momentum

You MUST respond in this EXACT JSON format and nothing else:
{"action": "BUY_YES" or "BUY_NO" or "SKIP", "confidence": "LOW" or "MEDIUM" or "HIGH", "reasoning": "your explanation here"}`;

function buildUserPrompt(marketData) {
  const { market, yesToken, noToken, priceTrend, priceHistory, spread } = marketData;

  const upPrice = yesToken.price?.mid?.toFixed(3) || 'N/A';
  const downPrice = noToken.price?.mid?.toFixed(3) || 'N/A';
  const upBuy = yesToken.price?.buy?.toFixed(3) || 'N/A';
  const upSell = yesToken.price?.sell?.toFixed(3) || 'N/A';

  let timeRemaining = 'Unknown';
  if (market.endTime) {
    const end = new Date(market.endTime);
    const now = new Date();
    const diffMin = Math.round((end - now) / (1000 * 60));
    if (diffMin > 0) timeRemaining = `${diffMin} minutes`;
    else timeRemaining = 'Expired or very soon';
  }

  const outcomePricesInfo = market.outcomePrices
    ? `Initial Up: ${market.outcomePrices[0]}, Initial Down: ${market.outcomePrices[1]}`
    : 'N/A';

  let priceHistoryText = 'No price history available';
  if (priceHistory && priceHistory.length > 0) {
    const recent = priceHistory.slice(-8);
    priceHistoryText = recent.map((p, i) => {
      const ago = (recent.length - 1 - i) * 1;
      return `  ${ago} min ago: UP probability was ${p.price.toFixed(4)}`;
    }).join('\n');
  }

  let orderbookText = 'No orderbook data available';
  if (yesToken.orderbook) {
    const ob = yesToken.orderbook;
    orderbookText = `  UP Token Orderbook:
    Best Bid: ${ob.bestBid || 'N/A'} | Best Ask: ${ob.bestAsk || 'N/A'}
    Total Bid Volume: ${ob.totalBidVolume} | Total Ask Volume: ${ob.totalAskVolume}
    Bid/Ask Ratio: ${ob.bidAskRatio} (>1 = more people wanting to buy UP)
    Spread: ${ob.spread || 'N/A'}
    Depth: ${ob.depth} levels`;
  }

  if (noToken.orderbook) {
    const ob = noToken.orderbook;
    orderbookText += `\n  DOWN Token Orderbook:
    Best Bid: ${ob.bestBid || 'N/A'} | Best Ask: ${ob.bestAsk || 'N/A'}
    Total Bid Volume: ${ob.totalBidVolume} | Total Ask Volume: ${ob.totalAskVolume}
    Bid/Ask Ratio: ${ob.bidAskRatio}
    Spread: ${ob.spread || 'N/A'}`;
  }

  return `MARKET: "${market.question}"
COIN: ${market.coin}
TYPE: 15-minute Up or Down prediction
DESCRIPTION: This market resolves to "Up" if ${market.coin} price is higher at the end of the 15-minute window than at the start. Otherwise "Down".
TIME REMAINING: ${timeRemaining}
MINUTES LEFT: ${market.minutesLeft || 'Unknown'}

CURRENT MARKET ODDS:
  UP price: ${upPrice} (crowd thinks ${upPrice !== 'N/A' ? (parseFloat(upPrice) * 100).toFixed(1) : '?'}% chance price goes UP)
  DOWN price: ${downPrice} (crowd thinks ${downPrice !== 'N/A' ? (parseFloat(downPrice) * 100).toFixed(1) : '?'}% chance price goes DOWN)
  UP buy at: ${upBuy} | UP sell at: ${upSell}

UP TOKEN PROBABILITY OVER TIME:
${priceHistoryText}

TREND ANALYSIS OF UP PROBABILITY:
  Direction: ${priceTrend.direction}
  Momentum: ${priceTrend.momentum}
  Recent avg change: ${priceTrend.recentChange}
  Overall change: ${priceTrend.totalChange}%
  Summary: ${priceTrend.summary}

ORDERBOOK DATA:
${orderbookText}

SPREAD: ${spread || 'N/A'}

Based on ALL the above data - the probability trend, momentum shifts, orderbook pressure, and time remaining - predict whether ${market.coin} will go UP or DOWN in this 15-minute window. If UP probability is rising with strong momentum and heavy buying, that signals UP. If declining, that signals DOWN.`;
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
        temperature: 0.3,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.addActivity('ai_error', { message: `OpenRouter API error: ${response.status} - ${errText}` });
      return { action: 'SKIP', confidence: 'LOW', reasoning: `API error: ${response.status}` };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.addActivity('ai_error', { message: 'Empty response from AI' });
      return { action: 'SKIP', confidence: 'LOW', reasoning: 'Empty AI response' };
    }

    let decision;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        decision = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseErr) {
      logger.addActivity('ai_error', { message: `Failed to parse AI response: ${content}` });
      return { action: 'SKIP', confidence: 'LOW', reasoning: `Parse error: ${content.substring(0, 200)}` };
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
        orderbookRatio: marketData.yesToken.orderbook?.bidAskRatio
      },
      rawPrompt: userPrompt,
      rawResponse: content
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
