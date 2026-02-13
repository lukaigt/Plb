const { ethers } = require('ethers');
const logger = require('./logger');
const redeemer = require('./redeemer');

const DATA_API = 'https://data-api.polymarket.com';
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const SAFE_FACTORY_ABI = [
  'function computeProxyAddress(address owner) view returns (address)'
];

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

    const proxyWallet = await getProxyWallet(eoaAddress);

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

    let redeemableCount = 0;
    const redeemablePositions = [];

    for (const pos of allPositions) {
      const conditionId = pos.conditionId;
      const tokenId = pos.asset;
      const size = parseFloat(pos.size || 0);
      const title = pos.title || pos.slug || 'Unknown market';
      const outcome = pos.outcome || 'Unknown';
      const redeemable = pos.redeemable === true || pos.redeemable === 'true';
      const curPrice = parseFloat(pos.curPrice || 0);
      const negRisk = pos.negRisk === true || pos.negRisk === 'true' || false;

      if (size <= 0) continue;

      if (redeemable) {
        if (!conditionId || !conditionId.startsWith('0x')) {
          logger.addActivity('position_scanner', {
            message: `Skipping position (invalid conditionId): ${title} | conditionId=${conditionId || 'missing'}`
          });
          continue;
        }

        redeemableCount++;

        redeemablePositions.push({
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
          message: `REDEEMABLE: ${title} | ${outcome} | ${size.toFixed(2)} shares | negRisk=${negRisk} | conditionId: ${conditionId.substring(0, 15)}...`
        });
      }
    }

    if (redeemableCount > 0) {
      logger.addActivity('position_scanner', {
        message: `Found ${redeemableCount} redeemable position(s)! Adding to redemption queue...`
      });
    } else {
      logger.addActivity('position_scanner', {
        message: `Found ${allPositions.length} position(s) but none are currently redeemable`
      });
    }

    lastScanResult = {
      found: allPositions.length,
      redeemable: redeemableCount,
      positions: redeemablePositions,
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
