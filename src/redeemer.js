const { ethers } = require('ethers');
const logger = require('./logger');
const trader = require('./trader');

const CTF_ADDRESS          = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PUSD_ADDRESS         = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_ADDRESS         = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';

const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com'
];

const COLLATERALS = [
  { addr: PUSD_ADDRESS, label: 'pUSD'   },
  { addr: USDC_ADDRESS, label: 'USDC.e' }
];

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)'
];

const SAFE_FACTORY_ABI = [
  'function computeProxyAddress(address owner) view returns (address)'
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)'
];

const TRANSFER_TOPIC          = ethers.utils.id('Transfer(address,address,uint256)');
const EXECUTION_FAILURE_TOPIC = ethers.utils.id('ExecutionFailure(bytes32,uint256)');
const KNOWN_COLLATERALS       = new Set([PUSD_ADDRESS.toLowerCase(), USDC_ADDRESS.toLowerCase()]);

const pendingRedemptions = [];
const redemptionHistory  = [];
let   safeAddress        = null;
let   isChecking         = false;

// ─── Provider ────────────────────────────────────────────────────────────────

async function getWorkingProvider() {
  const customRpc = process.env.POLYGON_RPC_URL;
  const rpcsToTry = customRpc ? [customRpc, ...POLYGON_RPCS] : POLYGON_RPCS;
  for (const rpc of rpcsToTry) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getNetwork();
      return provider;
    } catch { continue; }
  }
  return new ethers.providers.JsonRpcProvider(POLYGON_RPCS[0]);
}

// ─── Proxy wallet ─────────────────────────────────────────────────────────────

async function getProxyWalletAddress() {
  if (safeAddress) return safeAddress;

  const fromTrader = trader.getProxyWallet();
  if (fromTrader) {
    safeAddress = fromTrader;
    logger.addActivity('redeemer', { message: `Proxy wallet (CLOB API): ${fromTrader.slice(0, 10)}...` });
    return safeAddress;
  }

  const envProxy = process.env.PROXY_WALLET_ADDRESS;
  if (envProxy) {
    safeAddress = envProxy;
    logger.addActivity('redeemer', { message: `Proxy wallet (env): ${envProxy.slice(0, 10)}...` });
    return safeAddress;
  }

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (privateKey) {
    try {
      const provider  = await getWorkingProvider();
      const cleanKey  = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const eoaAddr   = new ethers.Wallet(cleanKey).address;
      const factory   = new ethers.Contract(SAFE_FACTORY_ADDRESS, SAFE_FACTORY_ABI, provider);
      const computed  = await factory.computeProxyAddress(eoaAddr);
      if (computed && computed !== ethers.constants.AddressZero) {
        safeAddress = computed;
        logger.addActivity('redeemer', { message: `Proxy wallet (SafeFactory): ${computed.slice(0, 10)}...` });
        return safeAddress;
      }
    } catch (err) {
      logger.addActivity('redeemer', { message: `SafeFactory lookup failed: ${err.message?.slice(0, 60)}` });
    }
  }

  logger.addActivity('redeemer', { message: 'No proxy wallet found — EOA only. Set PROXY_WALLET_ADDRESS in .env if needed.' });
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatConditionId(raw) {
  if (!raw) return null;
  const cid = String(raw);
  if (cid.startsWith('0x') && cid.length === 66) return cid;
  if (cid.startsWith('0x')) {
    try { return ethers.utils.hexZeroPad(cid, 32); } catch { return null; }
  }
  try {
    return ethers.utils.hexZeroPad(ethers.utils.hexlify(ethers.BigNumber.from(cid)), 32);
  } catch { return null; }
}

// Require a real ERC-20 Transfer from pUSD or USDC.e in the receipt.
// CTF.redeemPositions(wrongCollateral or zeroBalance) returns status=1 with NO Transfer.
// Requiring a Transfer prevents declaring "COLLECTED" on a zero-payout tx.
function verifyRedemptionReceipt(receipt, safAddr) {
  if (receipt.status !== 1) return false;
  if (safAddr) {
    const hasFailure = receipt.logs.some(l =>
      l.address.toLowerCase() === safAddr.toLowerCase() &&
      l.topics[0] === EXECUTION_FAILURE_TOPIC
    );
    if (hasFailure) return false;
  }
  return receipt.logs.some(l =>
    KNOWN_COLLATERALS.has(l.address.toLowerCase()) &&
    l.topics[0] === TRANSFER_TOPIC
  );
}

// ─── Find which collateral the market uses (callStatic = no gas) ──────────────
//
// payoutDenominator() is NOT used here because it returns 0 for NegRisk markets
// (soccer, NBA, NFL, etc.) even after the game ends — it would permanently block
// all sports redemptions. callStatic is the correct resolution gate.

async function findResolvedCollateral(provider, conditionId) {
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
  for (const col of COLLATERALS) {
    try {
      await ctf.callStatic.redeemPositions(col.addr, ethers.constants.HashZero, conditionId, [1, 2]);
      logger.addActivity('redeemer', { message: `callStatic OK: market resolved, collateral is ${col.label}` });
      return col;
    } catch (err) {
      logger.addActivity('redeemer', {
        message: `callStatic ${col.label}: ${(err.reason || err.message || '').slice(0, 60)}`
      });
    }
  }
  return null;
}

// ─── EOA redemption ───────────────────────────────────────────────────────────

async function redeemViaEOA(wallet, conditionId, col, provider) {
  const gasPrice = await provider.getGasPrice();
  const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  logger.addActivity('redeemer', { message: `EOA: submitting CTF + ${col.label}...` });
  const tx = await contract.redeemPositions(
    col.addr, ethers.constants.HashZero, conditionId, [1, 2],
    { gasPrice: gasPrice.mul(2), gasLimit: 300000 }
  );
  return tx;
}

// ─── Safe redemption ──────────────────────────────────────────────────────────

async function redeemViaSafe(wallet, conditionId, col, safAddr, provider) {
  const safeContract = new ethers.Contract(safAddr, SAFE_ABI, wallet);
  const iface        = new ethers.utils.Interface(CTF_ABI);
  const nonce        = await safeContract.nonce();
  const gasPrice     = await provider.getGasPrice();

  const data = iface.encodeFunctionData('redeemPositions', [
    col.addr, ethers.constants.HashZero, conditionId, [1, 2]
  ]);

  const txHash = await safeContract.getTransactionHash(
    CTF_ADDRESS, 0, data, 0, 0, 0, 0,
    ethers.constants.AddressZero, ethers.constants.AddressZero, nonce
  );

  const signature = await wallet.signMessage(ethers.utils.arrayify(txHash));
  const sigBytes  = ethers.utils.arrayify(signature);
  let v = sigBytes[64];
  if (v < 27) v += 27;
  v += 4;
  sigBytes[64] = v;
  const adjustedSig = ethers.utils.hexlify(sigBytes);

  logger.addActivity('redeemer', { message: `Safe: submitting CTF + ${col.label}...` });
  const tx = await safeContract.execTransaction(
    CTF_ADDRESS, 0, data, 0, 0, 0, 0,
    ethers.constants.AddressZero, ethers.constants.AddressZero, adjustedSig,
    { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
  );
  return tx;
}

// ─── Core: try EOA, then Safe if EOA gets no Transfer ─────────────────────────
//
// IMPORTANT: CTF.redeemPositions succeeds with status=1 even when balance is 0.
// This means a "successful" EOA tx can still pay out nothing if the tokens are
// on the Safe/proxy wallet. We detect this with the Transfer event check, then
// automatically fall through to the Safe path.

async function attemptRedeem(wallet, conditionId, col, safAddr, provider, label) {
  // 1. Try EOA
  try {
    const tx      = await redeemViaEOA(wallet, conditionId, col, provider);
    const receipt = await tx.wait();
    if (verifyRedemptionReceipt(receipt, null)) {
      return { success: true, via: 'EOA', txHash: receipt.transactionHash };
    }
    logger.addActivity('redeemer', {
      message: `EOA tx mined but no ${col.label} Transfer — tokens may be on Safe. Trying Safe...`
    });
  } catch (err) {
    logger.addActivity('redeemer', {
      message: `EOA tx failed: ${(err.reason || err.message || '').slice(0, 80)} — trying Safe...`
    });
  }

  // 2. Try Safe (tokens may have been settled there by the exchange)
  if (!safAddr) {
    logger.addActivity('redeemer_error', {
      message: `EOA had no tokens and PROXY_WALLET_ADDRESS is unknown — set it in .env to redeem from Safe`
    });
    return { success: false };
  }

  try {
    const tx      = await redeemViaSafe(wallet, conditionId, col, safAddr, provider);
    const receipt = await tx.wait();
    if (verifyRedemptionReceipt(receipt, safAddr)) {
      return { success: true, via: 'Safe', txHash: receipt.transactionHash };
    }
    logger.addActivity('redeemer', { message: `Safe also got no ${col.label} Transfer — may already be redeemed` });
  } catch (err) {
    logger.addActivity('redeemer', {
      message: `Safe tx failed: ${(err.reason || err.message || '').slice(0, 80)}`
    });
  }

  return { success: false };
}

// ─── Pending redemption queue ─────────────────────────────────────────────────

function addPendingRedemption(trade) {
  if (!trade || (!trade.conditionId && !trade.tokenId)) {
    logger.addActivity('redeemer', { message: 'Cannot track trade: missing conditionId and tokenId' });
    return;
  }

  const existing = pendingRedemptions.find(r =>
    (r.tokenId     && trade.tokenId     && r.tokenId     === trade.tokenId) ||
    (r.conditionId && trade.conditionId && r.conditionId === trade.conditionId && r.side === trade.side)
  );
  if (existing) return;

  pendingRedemptions.push({
    conditionId:   trade.conditionId,
    tokenId:       trade.tokenId || null,
    negRisk:       trade.negRisk !== undefined ? trade.negRisk : true,
    marketEndTime: trade.marketEndTime,
    action:        trade.action,
    side:          trade.side,
    size:          trade.size,
    price:         trade.price,
    question:      trade.question,
    addedAt:       new Date().toISOString(),
    status:        'waiting'
  });

  logger.addActivity('redeemer', {
    message: `Tracking for redemption: "${(trade.question || 'trade').slice(0, 50)}" | cid: ${(trade.conditionId || '').slice(0, 15)}...`
  });
}

// ─── Periodic queue processor ─────────────────────────────────────────────────

async function checkAndRedeem() {
  if (isChecking) return;
  if (pendingRedemptions.length === 0) return;

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) return;

  isChecking = true;
  try {
    const provider = await getWorkingProvider();
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet   = new ethers.Wallet(cleanKey, provider);
    const safAddr  = await getProxyWalletAddress();

    const now   = Date.now();
    const ready = pendingRedemptions.filter(r => {
      if (r.status !== 'waiting') return false;
      return now >= new Date(r.marketEndTime).getTime() + 30_000;
    });

    if (ready.length === 0) { isChecking = false; return; }

    logger.addActivity('redeemer', { message: `Checking ${ready.length} position(s) for redemption...` });

    for (const redemption of ready) {
      try {
        const conditionId = formatConditionId(redemption.conditionId);
        if (!conditionId) {
          redemption.status = 'error';
          redemption.error  = `Invalid conditionId: ${redemption.conditionId}`;
          logger.addActivity('redeemer_error', { message: `Invalid conditionId: ${redemption.question}` });
          continue;
        }

        const label = (redemption.question || 'trade').slice(0, 40);

        // Find the correct collateral via callStatic — also confirms market is resolved.
        // If null → market not resolved yet → retry silently next cycle.
        const col = await findResolvedCollateral(provider, conditionId);
        if (!col) {
          logger.addActivity('redeemer', { message: `"${label}": not yet resolved on-chain — will retry` });
          continue;
        }

        redemption.status = 'redeeming';
        const result = await attemptRedeem(wallet, conditionId, col, safAddr, provider, label);

        if (result.success) {
          redemption.status     = 'redeemed';
          redemption.txHash     = result.txHash;
          redemption.redeemedAt = new Date().toISOString();
          redemptionHistory.push({ ...redemption });

          const winIds = redemption.tradeIds || (redemption.tradeId ? [redemption.tradeId] : []);
          for (const tid of winIds) logger.updateTrade(tid, { result: 'win', pnl: 0 });

          logger.addActivity('redeem_success', {
            message: `COLLECTED via ${result.via}! TX: ${result.txHash.slice(0, 20)}... | "${label}"`
          });
        } else {
          redemption.retryCount = (redemption.retryCount || 0) + 1;
          const elapsedMs  = Date.now() - new Date(redemption.addedAt || 0).getTime();
          const elapsedMin = Math.floor(elapsedMs / 60000);
          if (elapsedMs > 2 * 60 * 60 * 1000) {
            redemption.status = 'error';
            redemption.error  = 'EOA + Safe both returned no Transfer after 2h';
            redemptionHistory.push({ ...redemption });
            logger.addActivity('redeemer_error', {
              message: `Gave up after 2h (${redemption.retryCount} attempts): "${label}"`
            });
          } else {
            redemption.status = 'waiting';
            logger.addActivity('redeemer_error', {
              message: `Retry (attempt ${redemption.retryCount}, +${elapsedMin}min): "${label}"`
            });
          }
        }
      } catch (err) {
        const elapsedMs = Date.now() - new Date(redemption.addedAt || 0).getTime();
        if (elapsedMs > 2 * 60 * 60 * 1000) {
          redemption.status = 'error';
          redemption.error  = err.message?.slice(0, 100);
          redemptionHistory.push({ ...redemption });
        } else {
          redemption.status = 'waiting';
        }
        logger.addActivity('redeemer_error', { message: `Redeem loop error (will retry): ${err.message?.slice(0, 80)}` });
      }
    }

    const done = pendingRedemptions.filter(r =>
      r.status === 'redeemed' || r.status === 'no_payout' || r.status === 'error'
    );
    for (const d of done) {
      const idx = pendingRedemptions.indexOf(d);
      if (idx >= 0) pendingRedemptions.splice(idx, 1);
    }

  } catch (err) {
    logger.addActivity('redeemer_error', { message: `Redeemer cycle error: ${err.message?.slice(0, 80)}` });
  } finally {
    isChecking = false;
  }
}

// ─── Single-position redemption (called from bondStrategy fast loop) ──────────

async function redeemPosition(conditionId, tokenId, negRisk, question) {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    logger.addActivity('redeemer_error', { message: 'Cannot redeem: WALLET_PRIVATE_KEY not set' });
    return false;
  }

  const label = (question || conditionId || 'position').slice(0, 50);

  try {
    const provider = await getWorkingProvider();
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet   = new ethers.Wallet(cleanKey, provider);
    const safAddr  = await getProxyWalletAddress();

    const condId = formatConditionId(conditionId);
    if (!condId) {
      logger.addActivity('redeemer_error', { message: `Invalid conditionId for "${label}"` });
      return false;
    }

    // callStatic finds the right collateral and confirms market is resolved.
    // If null → not resolved yet → return false so bondStrategy retries next tick.
    const col = await findResolvedCollateral(provider, condId);
    if (!col) {
      logger.addActivity('redeemer', { message: `"${label}": not yet resolved — will retry` });
      return false;
    }

    // Try EOA first; if EOA gets no Transfer (tokens on Safe), try Safe automatically.
    const result = await attemptRedeem(wallet, condId, col, safAddr, provider, label);

    if (result.success) {
      redemptionHistory.push({
        question, conditionId, tokenId,
        status:     'redeemed',
        txHash:     result.txHash,
        redeemedAt: new Date().toISOString()
      });
      logger.addActivity('redeem_success', {
        message: `COLLECTED via ${result.via}! TX: ${result.txHash.slice(0, 20)}… | "${label}"`
      });
      return true;
    }

    logger.addActivity('redeemer', {
      message: `Both EOA and Safe got no Transfer for "${label}" — will retry next tick`
    });
    return false;

  } catch (err) {
    logger.addActivity('redeemer', {
      message: `redeemPosition error for "${label}": ${(err.reason || err.message || '').slice(0, 80)} — will retry`
    });
    return false;
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

function getRedemptionStatus() {
  return {
    pending: pendingRedemptions.map(r => ({
      question:      r.question,
      side:          r.side,
      size:          r.size,
      status:        r.status,
      marketEndTime: r.marketEndTime,
      addedAt:       r.addedAt
    })),
    history: redemptionHistory.slice(0, 20).map(r => ({
      question:   r.question,
      side:       r.side,
      size:       r.size,
      status:     r.status,
      txHash:     r.txHash || null,
      redeemedAt: r.redeemedAt
    })),
    safeAddress:   safeAddress || null,
    totalRedeemed: redemptionHistory.filter(r => r.status === 'redeemed').length,
    totalLost:     redemptionHistory.filter(r => r.status === 'no_payout').length,
    totalErrors:   redemptionHistory.filter(r => r.status === 'error').length
  };
}

module.exports = {
  addPendingRedemption,
  checkAndRedeem,
  redeemPosition,
  getRedemptionStatus
};
