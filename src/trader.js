const { ClobClient, Side } = require('@polymarket/clob-client');
const { Wallet } = require('ethers');
const logger = require('./logger');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

let clobClient = null;
let apiCreds = null;

async function initClient(privateKey) {
  if (clobClient) return clobClient;

  try {
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const signer = new Wallet(cleanKey);
    const address = signer.address;

    logger.addActivity('trader', { message: `Wallet address: ${address.substring(0, 8)}...${address.substring(address.length - 6)}` });

    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);

    try {
      apiCreds = await tempClient.deriveApiKey();
      logger.addActivity('trader', { message: 'Derived existing API credentials' });
    } catch (e) {
      logger.addActivity('trader', { message: 'No existing credentials, creating new ones...' });
      try {
        apiCreds = await tempClient.createApiKey();
        logger.addActivity('trader', { message: 'Created new API credentials' });
      } catch (e2) {
        logger.addActivity('trader_error', { message: `Failed to create API credentials: ${e2.message}` });
        return null;
      }
    }

    clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      signer,
      apiCreds,
      0
    );

    logger.addActivity('trader', { message: 'CLOB client initialized successfully' });
    return clobClient;
  } catch (err) {
    logger.addActivity('trader_error', { message: `Client init error: ${err.message}` });
    return null;
  }
}

async function placeOrder(tokenId, side, amount, price, privateKey) {
  const client = await initClient(privateKey);

  if (!client) {
    logger.addActivity('trade_error', { message: 'Cannot trade: CLOB client not initialized' });
    return { success: false, error: 'CLOB client not initialized' };
  }

  try {
    const size = parseFloat((amount / price).toFixed(2));

    const response = await client.createAndPostOrder({
      tokenID: tokenId,
      price: price,
      size: size,
      side: Side.BUY,
    });

    if (response && (response.orderID || response.success !== false)) {
      logger.addActivity('trade_executed', {
        message: `Order placed: BUY ${size} shares at $${price.toFixed(3)} for $${amount}`,
        orderId: response.orderID || response.id
      });
      return { success: true, data: response, orderId: response.orderID || response.id };
    } else {
      const errMsg = response?.errorMsg || response?.error || JSON.stringify(response);
      logger.addActivity('trade_error', {
        message: `Order failed: ${errMsg}`
      });
      return { success: false, error: errMsg };
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

module.exports = { executeTrade, initClient, placeOrder };
