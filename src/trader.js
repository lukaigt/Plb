const { ethers } = require('ethers');
const logger = require('./logger');

const CLOB_API = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

let apiCredentials = null;

async function deriveApiCredentials(privateKey) {
  if (apiCredentials) return apiCredentials;

  try {
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    logger.addActivity('trader', { message: `Wallet address: ${address.substring(0, 8)}...${address.substring(address.length - 6)}` });

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 0;
    const message = `This message attests that I control the given wallet and I want to authorize trading on Polymarket CLOB.\nAddress: ${address.toLowerCase()}\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

    const signature = await wallet.signMessage(message);

    try {
      const res = await fetch(`${CLOB_API}/auth/derive-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          signature,
          timestamp,
          nonce
        })
      });

      if (res.ok) {
        const data = await res.json();
        apiCredentials = {
          apiKey: data.apiKey,
          secret: data.secret,
          passphrase: data.passphrase
        };
        logger.addActivity('trader', { message: 'API credentials derived successfully' });
        return apiCredentials;
      } else {
        const errText = await res.text();
        logger.addActivity('trader_error', { message: `Failed to derive API credentials: ${errText}` });
      }
    } catch (err) {
      logger.addActivity('trader_error', { message: `API credential derivation error: ${err.message}` });
    }

    return null;
  } catch (err) {
    logger.addActivity('trader_error', { message: `Wallet error: ${err.message}` });
    return null;
  }
}

function buildHmacSignature(secret, timestamp, method, path, body = '') {
  const crypto = require('crypto');
  const message = timestamp + method + path + body;
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(message)
    .digest('base64');
}

async function placeOrder(tokenId, side, amount, price, privateKey) {
  const creds = await deriveApiCredentials(privateKey);

  if (!creds) {
    logger.addActivity('trade_error', { message: 'Cannot trade: No API credentials' });
    return { success: false, error: 'No API credentials' };
  }

  try {
    const wallet = new ethers.Wallet(privateKey);
    const size = (amount / price).toFixed(2);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const orderPayload = {
      tokenID: tokenId,
      price: price.toString(),
      size: size,
      side: side,
      feeRateBps: "0",
      nonce: Date.now().toString(),
      expiration: "0",
      taker: "0x0000000000000000000000000000000000000000"
    };

    const path = '/order';
    const body = JSON.stringify(orderPayload);
    const signature = buildHmacSignature(creds.secret, timestamp, 'POST', path, body);

    const res = await fetch(`${CLOB_API}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'POLY_API_KEY': creds.apiKey,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': creds.passphrase
      },
      body
    });

    const responseText = await res.text();
    let responseData;
    try { responseData = JSON.parse(responseText); } catch { responseData = { raw: responseText }; }

    if (res.ok) {
      logger.addActivity('trade_executed', {
        message: `Order placed: ${side} ${size} shares at $${price} for $${amount}`,
        orderId: responseData.orderID || responseData.id
      });
      return { success: true, data: responseData, orderId: responseData.orderID || responseData.id };
    } else {
      logger.addActivity('trade_error', {
        message: `Order failed: ${res.status} - ${responseText}`
      });
      return { success: false, error: responseText };
    }
  } catch (err) {
    logger.addActivity('trade_error', { message: `Trade execution error: ${err.message}` });
    return { success: false, error: err.message };
  }
}

async function executeTrade(decision, marketData, tradeSize) {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    logger.addActivity('trade_error', { message: 'Wallet private key not configured' });
    return null;
  }

  const isYes = decision.action === 'BUY_YES' || decision.action === 'BUY_UP';
  const token = isYes ? marketData.yesToken : marketData.noToken;
  const price = token.price?.buy || token.price?.mid || 0.5;

  if (!token.token_id) {
    logger.addActivity('trade_error', { message: 'No token ID available for trade' });
    return null;
  }

  logger.addActivity('trade_attempt', {
    message: `Attempting to ${decision.action} on ${marketData.market.coin} | Size: $${tradeSize} | Price: $${price.toFixed(3)}`,
    coin: marketData.market.coin,
    action: decision.action,
    size: tradeSize,
    price
  });

  const result = await placeOrder(token.token_id, 'BUY', tradeSize, price, privateKey);

  const trade = {
    coin: marketData.market.coin,
    question: marketData.market.question,
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    tokenId: token.token_id,
    side: isYes ? 'YES' : 'NO',
    size: tradeSize,
    price,
    orderId: result.orderId || null,
    success: result.success,
    error: result.error || null,
    result: result.success ? 'pending' : 'failed',
    pnl: 0,
    marketEndTime: marketData.market.endTime
  };

  logger.addTrade(trade);
  return trade;
}

module.exports = { executeTrade, deriveApiCredentials, placeOrder };
