const { ClobClient, Side, OrderType, AssetType } = require('@polymarket/clob-client');
const { Wallet, ethers } = require('ethers');
const crypto = require('crypto');
const logger = require('./logger');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID  = 137;

const POLYGON_RPCS = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://matic-mainnet.chainstacklabs.com'
];
const USDC_CONTRACTS = [
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
];
const ERC20_ABI     = ['function balanceOf(address) view returns (uint256)'];
const USDC_DECIMALS = 6;

let _cachedBalance    = null;
let _balanceFetchedAt = 0;
const BALANCE_CACHE_MS = 5 * 60 * 1000;

let clobClient = null;
let proxyWalletAddress = null;
let eoaAddress = null;

function buildClobAuthHeaders(method, path) {
  const apiKey    = process.env.POLY_API_KEY;
  const apiSecret = process.env.POLY_API_SECRET;
  const passphrase = process.env.POLY_PASSPHRASE;
  if (!apiKey || !apiSecret || !passphrase) return null;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message   = `${timestamp}${method}${path}`;
  const sig       = crypto.createHmac('sha256', apiSecret).update(message).digest('base64');

  return {
    'POLY-API-KEY':    apiKey,
    'POLY-PASSPHRASE': passphrase,
    'POLY-TIMESTAMP':  timestamp,
    'POLY-SIGNATURE':  sig,
    'Content-Type':    'application/json'
  };
}

async function fetchProxyWallet() {
  try {
    const headers = buildClobAuthHeaders('GET', '/auth/user');
    if (headers) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${CLOB_HOST}/auth/user`, { headers, signal: controller.signal });
        clearTimeout(timer);

        if (res.ok) {
          const data = await res.json();
          const proxy = data.proxyWallet || data.proxy_wallet || data.address || null;
          if (proxy) {
            logger.addActivity('trader', { message: `Proxy wallet from CLOB API: ${proxy.substring(0, 10)}...` });
            return proxy;
          }
          logger.addActivity('trader', { message: `CLOB /auth/user response missing proxyWallet field: ${JSON.stringify(data).slice(0, 80)}` });
        } else {
          logger.addActivity('trader', { message: `CLOB /auth/user returned ${res.status} — trying env fallback` });
        }
      } catch (fetchErr) {
        clearTimeout(timer);
        logger.addActivity('trader', { message: `CLOB /auth/user fetch error: ${fetchErr.message.slice(0, 50)}` });
      }
    }

    const envOverride = process.env.PROXY_WALLET_ADDRESS;
    if (envOverride) {
      logger.addActivity('trader', { message: `Proxy wallet from PROXY_WALLET_ADDRESS env: ${envOverride.substring(0, 10)}...` });
      return envOverride;
    }

    logger.addActivity('trader', { message: 'No proxy wallet found. Set PROXY_WALLET_ADDRESS in .env if redemption fails.' });
    return null;
  } catch (err) {
    logger.addActivity('trader', { message: `Proxy wallet discovery error: ${err.message.slice(0, 60)}` });
    return null;
  }
}

async function initClient(privateKey) {
  if (clobClient) return clobClient;

  try {
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const signer = new Wallet(cleanKey);
    eoaAddress = signer.address;

    logger.addActivity('trader', { message: `Wallet address: ${eoaAddress.substring(0, 8)}...${eoaAddress.substring(eoaAddress.length - 6)}` });

    const apiKey = process.env.POLY_API_KEY;
    const apiSecret = process.env.POLY_API_SECRET;
    const passphrase = process.env.POLY_PASSPHRASE;

    if (!apiKey || !apiSecret || !passphrase) {
      logger.addActivity('trader_error', { message: 'Missing POLY_API_KEY, POLY_API_SECRET, or POLY_PASSPHRASE in .env' });
      return null;
    }

    const apiCreds = { key: apiKey, secret: apiSecret, passphrase };

    clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, apiCreds, 0);

    logger.addActivity('trader', { message: 'CLOB client initialized' });

    try {
      await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      logger.addActivity('trader', { message: 'COLLATERAL (USDC) allowance approved' });
    } catch (err) {
      logger.addActivity('trader', { message: `COLLATERAL allowance call failed (may already be set): ${err.message?.slice(0, 80)}` });
    }

    try {
      await clobClient.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
      logger.addActivity('trader', { message: 'CONDITIONAL (token) allowance approved — sells enabled' });
    } catch (err) {
      logger.addActivity('trader', { message: `CONDITIONAL allowance call failed (may already be set): ${err.message?.slice(0, 80)}` });
    }

    proxyWalletAddress = await fetchProxyWallet();
    if (!proxyWalletAddress) {
      logger.addActivity('trader', { message: `No proxy wallet found — will check EOA only for redemptions. Set PROXY_WALLET_ADDRESS in .env if redemption fails.` });
    } else {
      logger.addActivity('trader', { message: `Proxy wallet confirmed: ${proxyWalletAddress.substring(0, 10)}...` });
    }

    return clobClient;
  } catch (err) {
    logger.addActivity('trader_error', { message: `Client init error: ${err.message}` });
    return null;
  }
}

function getProxyWallet() { return proxyWalletAddress; }
function getEoaAddress()   { return eoaAddress; }

async function getUsdcBalance(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedBalance !== null && now - _balanceFetchedAt < BALANCE_CACHE_MS) {
    return _cachedBalance;
  }

  const wallet = proxyWalletAddress || eoaAddress;
  if (!wallet) return null;

  for (const rpcUrl of POLYGON_RPCS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      let total = 0;
      for (const contractAddr of USDC_CONTRACTS) {
        try {
          const token   = new ethers.Contract(contractAddr, ERC20_ABI, provider);
          const balance = await token.balanceOf(wallet);
          total += parseFloat(ethers.utils.formatUnits(balance, USDC_DECIMALS));
        } catch {}
      }
      _cachedBalance    = parseFloat(total.toFixed(2));
      _balanceFetchedAt = now;
      return _cachedBalance;
    } catch {}
  }
  return null;
}

function invalidateBalanceCache() {
  _cachedBalance    = null;
  _balanceFetchedAt = 0;
}

async function placeOrder(tokenId, side, amount, price, privateKey, negRisk = true, tickSize = '0.01') {
  const client = await initClient(privateKey);

  if (!client) {
    logger.addActivity('trade_error', { message: 'Cannot trade: CLOB client not initialized' });
    return { success: false, error: 'CLOB client not initialized' };
  }

  try {
    const roundedPrice = Math.round(price * 100) / 100;
    const size = parseFloat((amount / roundedPrice).toFixed(2));

    // Pre-populate the SDK's internal caches to avoid live API lookups
    // that can return responses missing `minimum_tick_size` / `neg_risk`.
    const resolvedTickSize = String(tickSize || '0.01');
    if (client.tickSizes) client.tickSizes[tokenId] = resolvedTickSize;
    if (client.negRisk)   client.negRisk[tokenId]   = !!negRisk;

    let response;
    let lastError = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: roundedPrice,
            size,
            side: Side.BUY,
            feeRateBps: 1000,
            expiration: 0,
            taker: '0x0000000000000000000000000000000000000000'
          },
          { tickSize: resolvedTickSize, negRisk: !!negRisk },
          OrderType.GTC
        );

        if (response && response.orderID) {
          logger.addActivity('trade_executed', {
            message: `Order CONFIRMED: BUY ${size} at $${roundedPrice.toFixed(3)} (orderID: ${response.orderID.substring(0, 12)}...)`,
            orderId: response.orderID
          });
          return { success: true, data: response, orderId: response.orderID };
        } else {
          let errMsg = response?.errorMsg || response?.error;
          if (!errMsg) { try { errMsg = JSON.stringify(response).substring(0, 200); } catch { errMsg = 'Unknown'; } }
          lastError = errMsg;
          logger.addActivity('trade_error', { message: `Order rejected (attempt ${attempt}/${maxRetries}): ${errMsg}` });
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      } catch (err) {
        const errStr = err.message || String(err);
        const isCloudflare = errStr.includes('403') || errStr.includes('Forbidden') || errStr.includes('blocked');
        lastError = isCloudflare ? 'Cloudflare rate-limited (403)' : errStr;
        logger.addActivity('trade_error', { message: `Trade attempt ${attempt}/${maxRetries} failed: ${lastError}` });
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 5000 * attempt));
      }
    }

    return { success: false, error: lastError };
  } catch (err) {
    logger.addActivity('trade_error', { message: `Trade execution error: ${err.message}` });
    return { success: false, error: err.message };
  }
}

async function placeSellOrder(tokenId, size, price, negRisk = true, tickSize = '0.01') {
  const client = clobClient;
  if (!client) return { success: false, error: 'No CLOB client' };

  try {
    const roundedPrice = Math.max(0.02, Math.min(0.97, Math.round(price * 100) / 100));
    const roundedSize  = parseFloat(size.toFixed(2));

    const resolvedTickSize = String(tickSize || '0.01');
    if (client.tickSizes) client.tickSizes[tokenId] = resolvedTickSize;
    if (client.negRisk)   client.negRisk[tokenId]   = !!negRisk;

    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size: roundedSize,
        side: Side.SELL,
        feeRateBps: 1000,
        expiration: 0,
        taker: '0x0000000000000000000000000000000000000000'
      },
      { tickSize: resolvedTickSize, negRisk: !!negRisk },
      OrderType.GTC
    );

    if (response && response.orderID) {
      return { success: true, orderId: response.orderID };
    }
    const errMsg = response?.errorMsg || response?.error || JSON.stringify(response)?.slice(0, 100);
    return { success: false, error: errMsg };
  } catch (err) {
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

  const negRisk  = marketData.market.negRisk !== undefined ? marketData.market.negRisk : true;
  const tickSize = marketData.market.tickSize || '0.01';

  const result = await placeOrder(token.token_id, 'BUY', tradeSize, price, privateKey, negRisk, tickSize);

  const trade = {
    coin: 'BTC', question: marketData.market.question,
    action: decision.action, confidence: decision.confidence,
    pattern: decision.pattern || 'unknown', reasoning: decision.reasoning,
    tokenId: token.token_id, side: isYes ? 'YES' : 'NO',
    size: tradeSize, price, orderId: result.orderId || null,
    success: result.success, error: result.error || null,
    result: result.success ? 'pending' : 'failed', pnl: 0,
    marketEndTime: marketData.market.endTime
  };

  const logged = logger.addTrade(trade);
  trade.tradeId = logged.id;
  return trade;
}

module.exports = { executeTrade, initClient, placeOrder, placeSellOrder, getProxyWallet, getEoaAddress, buildClobAuthHeaders, getUsdcBalance, invalidateBalanceCache };
