const { ethers } = require('ethers');
const logger = require('./logger');
const redeemer = require('./redeemer');
const trader = require('./trader');

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

let hasScannedOnStartup = false;
let lastScanResult = null;

async function lookupCorrectConditionId(tokenId) {
  try {
    const url = `${GAMMA_API}/markets?clob_token_ids=${tokenId}`;
    const res = await fetchWithTimeout(url, 10000);
    if (!res.ok) return null;
    const markets = await res.json();
    if (Array.isArray(markets) && markets.length > 0 && markets[0].conditionId) {
      return markets[0].conditionId;
    }
  } catch (err) {}
  return null;
}

async function lookupMarketResolution(conditionId) {
  try {
    const url = `${GAMMA_API}/markets?conditionId=${conditionId}`;
    const res = await fetchWithTimeout(url, 10000);
    if (!res.ok) return null;
    const markets = await res.json();
    if (Array.isArray(markets) && markets.length > 0) {
      const m = markets[0];
      return {
        closed: m.closed === true,
        resolved: m.resolved === true || m.hasResolved === true,
        negRisk: m.negRisk === true || m.enableNegRisk === true
      };
    }
  } catch (err) {}
  return null;
}

async function fetchWithTimeout(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function resolveProxyWallet() {
  const fromTrader = trader.getProxyWallet();
  if (fromTrader) return fromTrader;
  const envProxy = process.env.PROXY_WALLET_ADDRESS;
  if (envProxy) return envProxy;
  return null;
}

async function fetchAllPositions(walletAddress) {
  const allPositions = [];
  let offset = 0;
  const limit = 100;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page++) {
    try {
      const url = `${DATA_API}/positions?user=${walletAddress}&sizeThreshold=0&limit=${limit}&offset=${offset}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        logger.addActivity('position_scanner', {
          message: `Data API returned ${res.status} for positions (page ${page + 1})`
        });
        break;
      }

      const positions = await res.json();
      if (!Array.isArray(positions) || positions.length === 0) break;

      allPositions.push(...positions);
      logger.addActivity('position_scanner', {
        message: `Fetched page ${page + 1}: ${positions.length} position(s) (total so far: ${allPositions.length})`
      });

      if (positions.length < limit) break;
      offset += limit;
    } catch (err) {
      logger.addActivity('position_scanner_error', {
        message: `Failed to fetch positions page ${page + 1}: ${err.message.substring(0, 80)}`
      });
      break;
    }
  }

  return allPositions;
}

async function scanExistingPositions() {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    logger.addActivity('position_scanner', {
      message: 'No wallet key configured — skipping position scan'
    });
    return { found: 0, redeemable: 0 };
  }

  try {
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(cleanKey);
    const eoaAddress = wallet.address;

    logger.addActivity('position_scanner', {
      message: `Scanning for existing positions on wallet ${eoaAddress.substring(0, 10)}...`
    });

    let proxyWallet = resolveProxyWallet();

    const walletsToCheck = [eoaAddress];
    if (proxyWallet && proxyWallet.toLowerCase() !== eoaAddress.toLowerCase()) {
      walletsToCheck.push(proxyWallet);
      logger.addActivity('position_scanner', {
        message: `Also checking proxy wallet: ${proxyWallet.substring(0, 10)}...`
      });
    }

    let allPositions = [];
    const seenAssets = new Set();

    for (const addr of walletsToCheck) {
      const positions = await fetchAllPositions(addr);
      for (const pos of positions) {
        const key = pos.asset || pos.conditionId || JSON.stringify(pos);
        if (!seenAssets.has(key)) {
          seenAssets.add(key);
          allPositions.push(pos);
        }
      }
    }

    if (allPositions.length === 0) {
      logger.addActivity('position_scanner', {
        message: 'No existing positions found on any wallet'
      });
      lastScanResult = { found: 0, redeemable: 0, positions: [] };
      return lastScanResult;
    }

    logger.addActivity('position_scanner', {
      message: `Found ${allPositions.length} total position(s) across wallet(s) — queueing all for on-chain resolution check`
    });

    let queuedCount = 0;
    let skippedNoId = 0;
    let skippedNoSize = 0;
    const queuedPositions = [];

    for (const pos of allPositions) {
      let conditionId = pos.conditionId;
      const tokenId = pos.asset;
      const size = parseFloat(pos.size || 0);
      const title = pos.title || pos.slug || 'Unknown market';
      const outcome = pos.outcome || 'Unknown';
      const curPrice = parseFloat(pos.curPrice || 0);

      if (size <= 0) {
        skippedNoSize++;
        continue;
      }

      if (!conditionId && !tokenId) {
        skippedNoId++;
        continue;
      }

      let negRisk = pos.negativeRisk === true || pos.negativeRisk === 'true' || pos.negRisk === true || false;

      if (tokenId) {
        const gammaConditionId = await lookupCorrectConditionId(tokenId);
        if (gammaConditionId) {
          if (gammaConditionId !== conditionId) {
            logger.addActivity('position_scanner', {
              message: `Fixed conditionId for ${title}: Data API differs from Gamma API`
            });
          }
          conditionId = gammaConditionId;

          const resolution = await lookupMarketResolution(gammaConditionId);
          if (resolution) {
            if (resolution.negRisk) negRisk = true;
          }
        }
      }

      if (!conditionId) {
        skippedNoId++;
        continue;
      }

      queuedCount++;

      queuedPositions.push({
        conditionId,
        tokenId,
        title,
        outcome,
        size,
        curPrice,
        negRisk
      });

      redeemer.addPendingRedemption({
        conditionId: conditionId,
        tokenId: tokenId,
        negRisk: negRisk,
        marketEndTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        action: 'EXISTING_POSITION',
        side: outcome,
        size: size,
        price: curPrice,
        question: `[SCAN] ${title} (${outcome})`
      });
    }

    logger.addActivity('position_scanner', {
      message: `Queued ${queuedCount} position(s) for on-chain check (skipped: ${skippedNoSize} empty, ${skippedNoId} no ID)`
    });

    lastScanResult = {
      found: allPositions.length,
      redeemable: queuedCount,
      positions: queuedPositions,
      scannedAt: new Date().toISOString(),
      walletsChecked: walletsToCheck.map(w => w.substring(0, 10) + '...')
    };

    hasScannedOnStartup = true;
    return lastScanResult;

  } catch (err) {
    logger.addActivity('position_scanner_error', {
      message: `Position scan failed: ${err.message.substring(0, 80)}`
    });
    return { found: 0, redeemable: 0, error: err.message };
  }
}

function getScanResult() {
  return lastScanResult || { found: 0, redeemable: 0, scanned: false };
}

function hasScanned() {
  return hasScannedOnStartup;
}

module.exports = {
  scanExistingPositions,
  getScanResult,
  hasScanned
};
