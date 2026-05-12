const { ClobClient, Side, OrderType, AssetType, Chain } = require('@polymarket/clob-client-v2');
const { createWalletClient, createPublicClient, http, fallback, maxUint256 } = require('viem');
const { polygon } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const { ethers } = require('ethers');
const crypto = require('crypto');
const logger = require('./logger');

const CLOB_HOST = 'https://clob.polymarket.com';

const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com'
];

const USDC_CONTRACTS = [
  '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', // pUSD (V2, primary)
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e (V1, legacy)
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'  // native USDC
];
const ERC20_ABI     = ['function balanceOf(address) view returns (uint256)'];
const USDC_DECIMALS = 6;

// pUSD token and V2 exchange contracts on Polygon
const PUSD_ADDRESS    = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF_ADDRESS     = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // unchanged
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'; // unchanged
const V2_EXCHANGES    = [
  { address: '0xE111180000d2663C0091e4f400237545B87B996B', name: 'Exchange V2' },
  { address: '0xe2222d279d744050d28e00520010520000310F59', name: 'NegRisk Exchange V2' }
];
const ERC20_FULL_ABI = [
  { name: 'balanceOf',  type: 'function', stateMutability: 'view',       inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance',  type: 'function', stateMutability: 'view',       inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve',    type: 'function', stateMutability: 'nonpayable',  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }
];
// ERC-1155 operator approval — required so NegRiskAdapter can pull CTF tokens from the EOA
const ERC1155_ABI = [
  { name: 'isApprovedForAll', type: 'function', stateMutability: 'view',      inputs: [{ name: 'account', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'setApprovalForAll', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],    outputs: [] }
];

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

    // V2: use viem to create the wallet client
    const account = privateKeyToAccount(cleanKey);
    eoaAddress = account.address;

    const rpcTransport = fallback(POLYGON_RPCS.map(rpc => http(rpc)));

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: rpcTransport
    });

    const publicClient = createPublicClient({
      chain: polygon,
      transport: rpcTransport
    });

    logger.addActivity('trader', { message: `Wallet address: ${eoaAddress.substring(0, 8)}...${eoaAddress.substring(eoaAddress.length - 6)}` });

    const apiKey = process.env.POLY_API_KEY;
    const apiSecret = process.env.POLY_API_SECRET;
    const passphrase = process.env.POLY_PASSPHRASE;

    if (!apiKey || !apiSecret || !passphrase) {
      logger.addActivity('trader_error', { message: 'Missing POLY_API_KEY, POLY_API_SECRET, or POLY_PASSPHRASE in .env' });
      return null;
    }

    const creds = { key: apiKey, secret: apiSecret, passphrase };

    // V2 constructor uses options object with chain enum instead of positional args
    clobClient = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      signer: walletClient,
      creds
    });

    logger.addActivity('trader', { message: 'CLOB V2 client initialized' });

    // Check on-chain pUSD balance
    let pusdBalance = 0n;
    try {
      pusdBalance = await publicClient.readContract({
        address: PUSD_ADDRESS,
        abi: ERC20_FULL_ABI,
        functionName: 'balanceOf',
        args: [eoaAddress]
      });
      const balUsd = Number(pusdBalance) / 1e6;
      if (balUsd > 0) {
        logger.addActivity('trader', { message: `pUSD wallet balance: $${balUsd.toFixed(2)}` });
      } else {
        logger.addActivity('trader_error', { message: `WARNING: pUSD wallet balance is $0 — orders will fail. Convert your USDC.e to pUSD on polymarket.com first.` });
      }
    } catch (err) {
      logger.addActivity('trader', { message: `pUSD balance check failed: ${err.message?.slice(0, 60)}` });
    }

    // Ensure pUSD is approved for both V2 exchange contracts on Polygon (on-chain approve)
    for (const exchange of V2_EXCHANGES) {
      try {
        const allowance = await publicClient.readContract({
          address: PUSD_ADDRESS,
          abi: ERC20_FULL_ABI,
          functionName: 'allowance',
          args: [eoaAddress, exchange.address]
        });

        if (allowance > 0n) {
          logger.addActivity('trader', { message: `pUSD already approved for ${exchange.name}` });
        } else {
          logger.addActivity('trader', { message: `Sending pUSD approve for ${exchange.name}...` });
          const txHash = await walletClient.writeContract({
            address: PUSD_ADDRESS,
            abi: ERC20_FULL_ABI,
            functionName: 'approve',
            args: [exchange.address, maxUint256]
          });
          logger.addActivity('trader', { message: `pUSD approved for ${exchange.name} — tx: ${txHash.slice(0, 18)}...` });
        }
      } catch (err) {
        logger.addActivity('trader_error', { message: `Approve failed for ${exchange.name}: ${err.message?.slice(0, 100)}` });
      }
    }

    // Ensure CTF ERC-1155 tokens are approved for NegRiskAdapter.
    // Without this, NegRiskAdapter.redeemPositions() reverts because it cannot
    // pull conditional tokens from the EOA via safeTransferFrom.
    try {
      const isApproved = await publicClient.readContract({
        address: CTF_ADDRESS,
        abi: ERC1155_ABI,
        functionName: 'isApprovedForAll',
        args: [eoaAddress, NEG_RISK_ADAPTER]
      });
      if (isApproved) {
        logger.addActivity('trader', { message: 'CTF already approved for NegRiskAdapter' });
      } else {
        logger.addActivity('trader', { message: 'Approving CTF for NegRiskAdapter (needed for soccer redemptions)...' });
        const txHash = await walletClient.writeContract({
          address: CTF_ADDRESS,
          abi: ERC1155_ABI,
          functionName: 'setApprovalForAll',
          args: [NEG_RISK_ADAPTER, true]
        });
        logger.addActivity('trader', { message: `CTF approved for NegRiskAdapter — tx: ${txHash.slice(0, 18)}...` });
      }
    } catch (err) {
      logger.addActivity('trader_error', { message: `CTF setApprovalForAll failed: ${err.message?.slice(0, 100)}` });
    }

    // Ping Polymarket backend to sync the balance/allowance it sees
    try {
      await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      await clobClient.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
    } catch (_) {}

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
    logger.addActivity('trade_error', { message: 'Cannot trade: CLOB V2 client not initialized' });
    return { success: false, error: 'CLOB client not initialized' };
  }

  // Re-sync balance/allowance with Polymarket backend before every order.
  // initClient() does this once at startup but the CLOB backend can fall out
  // of sync after redemptions, restarts, or balance changes.
  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
  } catch (_) {}

  try {
    const resolvedTickSize = String(tickSize || '0.01');
    const tickNum  = parseFloat(resolvedTickSize) || 0.01;
    const decimals = tickNum <= 0.001 ? 3 : 2;
    // Round price to the market's tick precision, then hard-cap below 1.0
    const maxValidPrice = parseFloat((1.0 - tickNum).toFixed(decimals));
    const roundedPrice  = Math.min(
      Math.round(price * (10 ** decimals)) / (10 ** decimals),
      maxValidPrice
    );
    const size = parseFloat((amount / roundedPrice).toFixed(2));

    // Pre-seed the SDK's internal tick-size cache so it never makes a live
    // /tick-size API call for this token.  The SDK's getTickSize() returns
    // immediately when the token is already in the cache, bypassing the call
    // to GET /tick-size whose response may lack `minimum_tick_size` (causing
    // "Cannot read properties of undefined (reading 'toString')").
    if (client.tickSizes && !(tokenId in client.tickSizes)) {
      client.tickSizes[tokenId] = resolvedTickSize;
    }

    let response;
    let lastError = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // V2: expiration and taker are gone from the order struct
        response = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: roundedPrice,
            size,
            side: Side.BUY
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
          if (!errMsg) { try { errMsg = JSON.stringify(response).substring(0, 150); } catch { errMsg = 'Unknown response'; } }
          lastError = String(errMsg).substring(0, 150);
          logger.addActivity('trade_error', { message: `Order rejected (attempt ${attempt}/${maxRetries}): ${lastError}` });
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      } catch (err) {
        const raw = err.message || String(err);
        let clean;
        if (raw.length > 300 || raw.includes('[Circular]')) {
          const m = raw.match(/"(?:errorMsg|error|message)"\s*:\s*"([^"]{1,120})"/);
          clean = m ? m[1] : `HTTP ${raw.match(/statusCode.*?(\d{3})/)?.[1] || 'error'} from Polymarket (check VPS logs)`;
        } else {
          clean = raw.substring(0, 150);
        }
        const isCloudflare = clean.includes('403') || clean.includes('Forbidden') || clean.includes('blocked');
        lastError = isCloudflare ? 'Cloudflare rate-limited (403)' : clean;
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

async function placeFakSellOrder(tokenId, size, price, negRisk = true, tickSize = '0.01') {
  const client = clobClient;
  if (!client) return { success: false, error: 'No CLOB client' };

  try {
    const resolvedTickSize = String(tickSize || '0.01');
    const tickNum  = parseFloat(resolvedTickSize) || 0.01;
    const decimals = tickNum <= 0.001 ? 3 : 2;
    const roundedPrice = parseFloat(Math.max(0.02, Math.min(0.97,
      Math.round(price * (10 ** decimals)) / (10 ** decimals)
    )).toFixed(decimals));
    const roundedSize = parseFloat(size.toFixed(2));

    if (client.tickSizes && !(tokenId in client.tickSizes)) {
      client.tickSizes[tokenId] = resolvedTickSize;
    }

    const response = await client.createAndPostOrder(
      { tokenID: tokenId, price: roundedPrice, size: roundedSize, side: Side.SELL },
      { tickSize: resolvedTickSize, negRisk: !!negRisk },
      OrderType.FAK
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

async function placeSellOrder(tokenId, size, price, negRisk = true, tickSize = '0.01') {
  const client = clobClient;
  if (!client) return { success: false, error: 'No CLOB client' };

  try {
    const roundedPrice = Math.max(0.02, Math.min(0.97, Math.round(price * 100) / 100));
    const roundedSize  = parseFloat(size.toFixed(2));

    const resolvedTickSize = String(tickSize || '0.01');

    if (client.tickSizes && !(tokenId in client.tickSizes)) {
      client.tickSizes[tokenId] = resolvedTickSize;
    }

    // V2: expiration and taker removed
    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size: roundedSize,
        side: Side.SELL
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

module.exports = { executeTrade, initClient, placeOrder, placeSellOrder, placeFakSellOrder, getProxyWallet, getEoaAddress, buildClobAuthHeaders, getUsdcBalance, invalidateBalanceCache };
