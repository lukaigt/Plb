const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const { Wallet } = require('ethers');
const logger = require('./logger');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

let clobClient = null;

async function initClient(privateKey) {
  if (clobClient) return clobClient;

  try {
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const signer = new Wallet(cleanKey);
    const address = signer.address;

    logger.addActivity('trader', { message: `Wallet address: ${address.substring(0, 8)}...${address.substring(address.length - 6)}` });

    const apiKey = process.env.POLY_API_KEY;
    const apiSecret = process.env.POLY_API_SECRET;
    const passphrase = process.env.POLY_PASSPHRASE;

    if (!apiKey || !apiSecret || !passphrase) {
      logger.addActivity('trader_error', { message: 'Missing POLY_API_KEY, POLY_API_SECRET, or POLY_PASSPHRASE in .env' });
      return null;
    }

    const apiCreds = {
      key: apiKey,
      secret: apiSecret,
      passphrase: passphrase
    };

    clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      signer,
      apiCreds,
      0
    );

    logger.addActivity('trader', { message: 'CLOB client initialized with manual API credentials' });
    return clobClient;
  } catch (err) {
    logger.addActivity('trader_error', { message: `Client init error: ${err.message}` });
    return null;
  }
}

async function placeOrder(tokenId, side, amount, price, privateKey) {
  const client = await initClient(privateKey);

  if (!client) {
    logger.addActivity('trade_error', { message: 'Cannot trade: CLOB client not initialized. Check your POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE in .env' });
    return { success: false, error: 'CLOB client not initialized' };
  }

  try {
    const tickSize = "0.01";
    const roundedPrice = Math.round(price * 100) / 100;
    const size = parseFloat((amount / roundedPrice).toFixed(2));

    logger.addActivity('trader', { 
      message: `Order params: tokenID=${tokenId.substring(0, 15)}..., price=${roundedPrice}, size=${size}` 
    });

    let response;
    let lastError = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: roundedPrice,
            size: size,
            side: Side.BUY,
            feeRateBps: 1000,
            expiration: 0,
            taker: "0x0000000000000000000000000000000000000000"
          },
          {
            tickSize: tickSize,
            negRisk: true
          },
          OrderType.GTC
        );

        if (response && response.orderID) {
          logger.addActivity('trade_executed', {
            message: `Order CONFIRMED: BUY ${size} shares at $${roundedPrice.toFixed(3)} for $${amount} (orderID: ${response.orderID.substring(0, 12)}...)`,
            orderId: response.orderID
          });
          return { success: true, data: response, orderId: response.orderID };
        } else if (response && typeof response === 'object' && !response.orderID) {
          let errMsg = response.errorMsg || response.error;
          if (!errMsg) { try { errMsg = JSON.stringify(response).substring(0, 200); } catch(e) { errMsg = 'Unknown error (response not serializable)'; } }
          logger.addActivity('trade_error', {
            message: `Order rejected (attempt ${attempt}/${maxRetries}): ${errMsg}`
          });
          lastError = errMsg;
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 3000 * attempt));
          }
        }
      } catch (err) {
        const errStr = err.message || String(err);
        const isCloudflare = errStr.includes('403') || errStr.includes('Forbidden') || errStr.includes('blocked');
        lastError = isCloudflare ? 'Cloudflare rate-limited (403)' : errStr;
        logger.addActivity('trade_error', { 
          message: `Trade attempt ${attempt}/${maxRetries} failed: ${lastError}` 
        });
        if (attempt < maxRetries) {
          const delay = 5000 * attempt;
          logger.addActivity('trader', { message: `Waiting ${delay/1000}s before retry...` });
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    logger.addActivity('trade_failed', { 
      message: `Order FAILED after ${maxRetries} attempts: ${lastError}` 
    });
    return { success: false, error: lastError };
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

module.exports = { executeTrade, initClient, placeOrder };
