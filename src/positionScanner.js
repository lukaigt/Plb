const { ethers } = require('ethers');
const logger = require('./logger');
const redeemer = require('./redeemer');

const DATA_API = 'https://data-api.polymarket.com';
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const SAFE_FACTORY_ABI = [
  'function computeProxyAddress(address owner) view returns (address)'
];
const KNOWN_PROXY_WALLET = '0x94eAb3d7352aEb36A7378bc635b97E2968112e7E';

let hasScannedOnStartup = false;
let lastScanResult = null;

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

async function getProxyWallet(eoaAddress) {
  try {
    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const factory = new ethers.Contract(SAFE_FACTORY_ADDRESS, SAFE_FACTORY_ABI, provider);
    const computed = await factory.computeProxyAddress(eoaAddress);
    const code = await provider.getCode(computed);
    if (code !== '0x') {
      return computed;
    }
    return null;
  } catch (err) {
    logger.addActivity('position_scanner', {
      message: `Could not find proxy wallet: ${err.message.substring(0, 60)}`
    });
    return null;
  }
}

async function fetchPositions(walletAddress) {
  try {
    const url = `${DATA_API}/positions?user=${walletAddress}&sizeThreshold=0`;
    logger.addActivity('position_scanner', {
      message: `Fetching positions for ${walletAddress.substring(0, 10)}...`
    });

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      logger.addActivity('position_scanner', {
        message: `Data API returned ${res.status} for positions`
      });
      return [];
    }

    const positions = await res.json();
    if (!Array.isArray(positions)) return [];

    return positions;
  } catch (err) {
    logger.addActivity('position_scanner_error', {
      message: `Failed to fetch positions: ${err.message.substring(0, 80)}`
    });
    return [];
  }
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

    let proxyWallet = await getProxyWallet(eoaAddress);

    if (!proxyWallet && KNOWN_PROXY_WALLET) {
      proxyWallet = KNOWN_PROXY_WALLET;
      logger.addActivity('position_scanner', {
        message: `Factory lookup failed — using known proxy wallet: ${KNOWN_PROXY_WALLET.substring(0, 10)}...`
      });
    }

    const walletsToCheck = [eoaAddress];
    if (proxyWallet && proxyWallet.toLowerCase() !== eoaAddress.toLowerCase()) {
      walletsToCheck.push(proxyWallet);
      logger.addActivity('position_scanner', {
        message: `Also checking proxy wallet: ${proxyWallet.substring(0, 10)}...`
      });
    }

    let allPositions = [];
    for (const addr of walletsToCheck) {
      const positions = await fetchPositions(addr);
      allPositions = allPositions.concat(positions);
    }

    if (allPositions.length === 0) {
      logger.addActivity('position_scanner', {
        message: 'No existing positions found on any wallet'
      });
      lastScanResult = { found: 0, redeemable: 0, positions: [] };
      return lastScanResult;
    }

    logger.addActivity('position_scanner', {
      message: `Found ${allPositions.length} total position(s) across wallet(s)`
    });

    let queuedCount = 0;
    let skippedActive = 0;
    const queuedPositions = [];

    for (const pos of allPositions) {
      const conditionId = pos.conditionId;
      const tokenId = pos.asset;
      const size = parseFloat(pos.size || 0);
      const title = pos.title || pos.slug || 'Unknown market';
      const outcome = pos.outcome || 'Unknown';
      const curPrice = parseFloat(pos.curPrice || 0);
      const negRisk = pos.negativeRisk === true || pos.negativeRisk === 'true' || pos.negRisk === true || false;
      const resolved = curPrice === 0 || curPrice === 1 || pos.redeemable === true || pos.redeemable === 'true';

      if (size <= 0) continue;

      if (!conditionId && !tokenId) {
        logger.addActivity('position_scanner', {
          message: `Skipping (no conditionId or tokenId): ${title}`
        });
        continue;
      }

      if (!resolved) {
        skippedActive++;
        logger.addActivity('position_scanner', {
          message: `Active market (not resolved): ${title} | ${outcome} | price=${curPrice.toFixed(3)}`
        });
        continue;
      }

      if (curPrice === 0) {
        logger.addActivity('position_scanner', {
          message: `Lost position (price=0): ${title} | ${outcome} | ${size.toFixed(2)} shares — skipping`
        });
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
        question: `[OLD] ${title} (${outcome})`
      });

      logger.addActivity('position_scanner', {
        message: `QUEUED FOR REDEMPTION: ${title} | ${outcome} | ${size.toFixed(2)} shares | price=${curPrice} | negRisk=${negRisk} | conditionId: ${conditionId.substring(0, 15)}...`
      });
    }

    if (queuedCount > 0) {
      logger.addActivity('position_scanner', {
        message: `Queued ${queuedCount} position(s) for redemption! (${skippedActive} still active)`
      });
    } else {
      logger.addActivity('position_scanner', {
        message: `Found ${allPositions.length} position(s): ${skippedActive} active, 0 to redeem`
      });
    }

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
