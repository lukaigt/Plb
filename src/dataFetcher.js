const logger = require('./logger');

const CLOB_API = 'https://clob.polymarket.com';

async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function getMarketPrice(tokenId) {
  try {
    const [buyRes, sellRes] = await Promise.all([
      fetchWithTimeout(`${CLOB_API}/price?token_id=${tokenId}&side=BUY`),
      fetchWithTimeout(`${CLOB_API}/price?token_id=${tokenId}&side=SELL`)
    ]);

    const buyData = buyRes.ok ? await buyRes.json() : { price: null };
    const sellData = sellRes.ok ? await sellRes.json() : { price: null };

    return {
      buy: buyData.price ? parseFloat(buyData.price) : null,
      sell: sellData.price ? parseFloat(sellData.price) : null,
      mid: buyData.price && sellData.price
        ? (parseFloat(buyData.price) + parseFloat(sellData.price)) / 2
        : null
    };
  } catch (err) {
    logger.addActivity('data_error', { message: `Price fetch failed for ${tokenId}: ${err.message}` });
    return { buy: null, sell: null, mid: null };
  }
}

async function getMidpoint(tokenId) {
  try {
    const res = await fetchWithTimeout(`${CLOB_API}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.mid ? parseFloat(data.mid) : null;
  } catch (err) {
    return null;
  }
}

async function getOrderbook(tokenId) {
  try {
    const res = await fetchWithTimeout(`${CLOB_API}/book?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data = await res.json();

    const bids = (data.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
    const asks = (data.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));

    const totalBidVolume = bids.reduce((sum, b) => sum + b.size, 0);
    const totalAskVolume = asks.reduce((sum, a) => sum + a.size, 0);
    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;

    return {
      bids: bids.slice(0, 10),
      asks: asks.slice(0, 10),
      totalBidVolume: totalBidVolume.toFixed(2),
      totalAskVolume: totalAskVolume.toFixed(2),
      bidAskRatio: totalAskVolume > 0 ? (totalBidVolume / totalAskVolume).toFixed(2) : 'N/A',
      bestBid,
      bestAsk,
      spread: spread ? spread.toFixed(4) : null,
      depth: bids.length + asks.length
    };
  } catch (err) {
    logger.addActivity('data_error', { message: `Orderbook fetch failed for ${tokenId}: ${err.message}` });
    return null;
  }
}

async function getPriceHistory(tokenId) {
  try {
    const res = await fetchWithTimeout(
      `${CLOB_API}/prices-history?market=${tokenId}&interval=1h&fidelity=1`
    );
    if (!res.ok) {
      const res2 = await fetchWithTimeout(
        `${CLOB_API}/prices-history?token_id=${tokenId}&interval=1h&fidelity=1`
      );
      if (!res2.ok) return [];
      const data2 = await res2.json();
      return (data2.history || data2 || []).map(p => ({
        time: p.t,
        price: parseFloat(p.p)
      }));
    }
    const data = await res.json();
    return (data.history || data || []).map(p => ({
      time: p.t,
      price: parseFloat(p.p)
    }));
  } catch (err) {
    return [];
  }
}

async function getSpread(tokenId) {
  try {
    const res = await fetchWithTimeout(`${CLOB_API}/spread?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.spread ? parseFloat(data.spread) : null;
  } catch (err) {
    return null;
  }
}

function analyzePriceTrend(history) {
  if (!history || history.length < 3) {
    return {
      direction: 'unknown',
      momentum: 'unknown',
      recentChange: 0,
      avgChange: 0,
      summary: 'Not enough price history data'
    };
  }

  const recent = history.slice(-10);
  const prices = recent.map(p => p.price);

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
  const recentChanges = changes.slice(-3);
  const recentAvg = recentChanges.reduce((a, b) => a + b, 0) / recentChanges.length;

  let direction = 'sideways';
  if (avgChange > 0.005) direction = 'upward';
  else if (avgChange < -0.005) direction = 'downward';

  let momentum = 'stable';
  if (Math.abs(recentAvg) > Math.abs(avgChange) * 1.5) {
    momentum = 'accelerating';
  } else if (Math.abs(recentAvg) < Math.abs(avgChange) * 0.5) {
    momentum = 'decelerating';
  }

  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const totalChange = ((lastPrice - firstPrice) / firstPrice * 100).toFixed(2);

  return {
    direction,
    momentum,
    recentChange: recentAvg.toFixed(4),
    avgChange: avgChange.toFixed(4),
    totalChange,
    pricePoints: recent,
    summary: `Price trending ${direction} with ${momentum} momentum. Change: ${totalChange}%`
  };
}

async function fetchFullMarketData(market) {
  logger.addActivity('data_fetch', {
    message: `Fetching data for ${market.coin} market: ${market.question}`
  });

  const yesToken = market.tokens.find(t => {
    const o = (t.outcome || '').toLowerCase();
    return o === 'yes' || o === 'true' || o === 'up';
  }) || market.tokens[0];

  const noToken = market.tokens.find(t => {
    const o = (t.outcome || '').toLowerCase();
    return o === 'no' || o === 'false' || o === 'down';
  }) || market.tokens[1];

  const [yesPrice, noPrice, yesBook, noBook, yesHistory, spread] = await Promise.all([
    getMarketPrice(yesToken.token_id),
    getMarketPrice(noToken.token_id),
    getOrderbook(yesToken.token_id),
    getOrderbook(noToken.token_id),
    getPriceHistory(yesToken.token_id),
    getSpread(yesToken.token_id)
  ]);

  const priceTrend = analyzePriceTrend(yesHistory);

  const marketData = {
    market,
    yesToken: {
      ...yesToken,
      price: yesPrice,
      orderbook: yesBook
    },
    noToken: {
      ...noToken,
      price: noPrice,
      orderbook: noBook
    },
    priceHistory: yesHistory,
    priceTrend,
    spread,
    fetchedAt: new Date().toISOString()
  };

  logger.addActivity('data_ready', {
    message: `Data ready for ${market.coin}: YES=${yesPrice.mid?.toFixed(3) || 'N/A'}, NO=${noPrice.mid?.toFixed(3) || 'N/A'}, Trend=${priceTrend.direction}`,
    coin: market.coin
  });

  return marketData;
}

module.exports = { fetchFullMarketData, getMarketPrice, getOrderbook, getPriceHistory, analyzePriceTrend };
