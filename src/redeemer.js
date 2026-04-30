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

// Try pUSD first (all new V2 markets), then USDC.e (legacy V1 positions).
// callStatic on each will tell us which collateral the position was created with.
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

const TRANSFER_TOPIC           = ethers.utils.id('Transfer(address,address,uint256)');
const EXECUTION_FAILURE_TOPIC  = ethers.utils.id('ExecutionFailure(bytes32,uint256)');
const KNOWN_COLLATERALS        = new Set([PUSD_ADDRESS.toLowerCase(), USDC_ADDRESS.toLowerCase()]);

const pendingRedemptions = [];
const redemptionHistory  = [];
let   safeAddress        = null;
let   isChecking         = false;

// ─── Provider ────────────────────────────────────────────────────────────────

async function getWorkingProvider() {
  const customRpc  = process.env.POLYGON_RPC_URL;
  const rpcsToTry  = customRpc ? [customRpc, ...POLYGON_RPCS] : POLYGON_RPCS;
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
      const provider = await getWorkingProvider();
      const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const eoaAddress = new ethers.Wallet(cleanKey).address;
      const factory  = new ethers.Contract(SAFE_FACTORY_ADDRESS, SAFE_FACTORY_ABI, provider);
      const computed = await factory.computeProxyAddress(eoaAddress);
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

async function hasTokenBalance(provider, walletAddress, tokenId) {
  if (!tokenId) return true;
  try {
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const bal = await ctf.balanceOf(walletAddress, tokenId);
    return bal.gt(0);
  } catch { return true; }
}

// Require a real ERC-20 Transfer from a known collateral (pUSD or USDC.e).
// A tx can return status=1 with zero payout if the wrong collateral is used or
// balance is zero — the Transfer check catches that false-positive correctly.
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

// ─── Core redemption ─────────────────────────────────────────────────────────

// Strategy: try CTF.redeemPositions with pUSD, then USDC.e.
// callStatic is the ONLY resolution gate — payoutDenominator() is NOT used
// because it returns 0 for NegRisk markets (soccer, NBA, NFL, etc.) even
// after the game ends. callStatic reverts → we catch → retry later.
async function redeemViaEOA(wallet, conditionId, provider) {
  const gasPrice = await provider.getGasPrice();
  const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

  let lastErr;
  for (const col of COLLATERALS) {
    try {
      logger.addActivity('redeemer', { message: `Trying CTF + ${col.label} (callStatic)...` });
      await contract.callStatic.redeemPositions(
        col.addr, ethers.constants.HashZero, conditionId, [1, 2]
      );
      logger.addActivity('redeemer', { message: `callStatic OK (${col.label}) — submitting tx...` });
      const tx = await contract.redeemPositions(
        col.addr, ethers.constants.HashZero, conditionId, [1, 2],
        { gasPrice: gasPrice.mul(2), gasLimit: 300000 }
      );
      return tx;
    } catch (err) {
      lastErr = err;
      const reason = err.reason || err.message || '';
      logger.addActivity('redeemer', { message: `CTF ${col.label} failed: ${reason.slice(0, 80)} — trying next` });
    }
  }
  throw lastErr || new Error('All CTF collaterals failed');
}

async function redeemViaSafe(wallet, conditionId, safAddr, provider) {
  const safeContract = new ethers.Contract(safAddr, SAFE_ABI, wallet);
  const iface        = new ethers.utils.Interface(CTF_ABI);
  const nonce        = await safeContract.nonce();
  const gasPrice     = await provider.getGasPrice();

  let lastErr;
  for (const col of COLLATERALS) {
    try {
      logger.addActivity('redeemer', { message: `Safe: trying CTF + ${col.label}...` });
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

      const tx = await safeContract.execTransaction(
        CTF_ADDRESS, 0, data, 0, 0, 0, 0,
        ethers.constants.AddressZero, ethers.constants.AddressZero, adjustedSig,
        { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
      );
      return tx;
    } catch (err) {
      lastErr = err;
      logger.addActivity('redeemer', { message: `Safe CTF ${col.label} failed: ${(err.message || '').slice(0, 60)} — trying next` });
    }
  }
  throw lastErr || new Error('All Safe CTF collaterals failed');
}

// ─── Pending redemption queue ─────────────────────────────────────────────────

function addPendingRedemption(trade) {
  if (!trade || (!trade.conditionId && !trade.tokenId)) {
    logger.addActivity('redeemer', { message: 'Cannot track trade: missing conditionId and tokenId' });
    return;
  }

  const existing = pendingRedemptions.find(r =>
    (r.tokenId    && trade.tokenId    && r.tokenId    === trade.tokenId) ||
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
      const endTime = new Date(r.marketEndTime).getTime();
      return now >= endTime + 30_000;
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

        const eoaHas  = await hasTokenBalance(provider, wallet.address, redemption.tokenId);
        const safeHas = safAddr ? await hasTokenBalance(provider, safAddr, redemption.tokenId) : false;
        logger.addActivity('redeemer', {
          message: `Balance check "${(redemption.question || 'trade').slice(0, 40)}" | EOA: ${eoaHas} | Safe: ${safeHas}`
        });

        if (!eoaHas && !safeHas) {
          const retries = redemption.balanceRetryCount || 0;
          if (retries < 3) {
            redemption.balanceRetryCount = retries + 1;
            logger.addActivity('redeemer', { message: `No token balance (retry ${retries + 1}/3): "${(redemption.question || '').slice(0, 40)}"` });
            continue;
          }
          redemption.status    = 'no_payout';
          redemption.redeemedAt = new Date().toISOString();
          redemptionHistory.push({ ...redemption });
          logger.addActivity('redeemer', { message: `No tokens after 3 checks — marking lost: "${(redemption.question || '').slice(0, 40)}"` });
          continue;
        }

        const fromSafe = !eoaHas && safeHas;
        logger.addActivity('redeemer', {
          message: `Tokens on ${fromSafe ? 'Safe' : 'EOA'} — attempting redemption: "${(redemption.question || '').slice(0, 40)}"`
        });

        redemption.status = 'redeeming';
        let redeemed = false;
        let lastError = null;

        try {
          const tx      = fromSafe && safAddr
            ? await redeemViaSafe(wallet, conditionId, safAddr, provider)
            : await redeemViaEOA(wallet, conditionId, provider);
          const receipt = await tx.wait();
          const ok      = verifyRedemptionReceipt(receipt, fromSafe ? safAddr : null);

          if (ok) {
            redemption.status     = 'redeemed';
            redemption.txHash     = receipt.transactionHash;
            redemption.redeemedAt = new Date().toISOString();
            redemptionHistory.push({ ...redemption });
            redeemed = true;

            const winIds = redemption.tradeIds || (redemption.tradeId ? [redemption.tradeId] : []);
            for (const tid of winIds) logger.updateTrade(tid, { result: 'win', pnl: 0 });

            logger.addActivity('redeem_success', {
              message: `COLLECTED! TX: ${receipt.transactionHash.slice(0, 20)}... | "${(redemption.question || '').slice(0, 40)}"`
            });
          } else {
            lastError = 'Tx mined but no collateral Transfer event — position may already be redeemed';
            logger.addActivity('redeemer', { message: lastError });
          }
        } catch (err) {
          lastError = err.message || String(err);
          logger.addActivity('redeemer', { message: `Redeem tx failed: ${lastError.slice(0, 80)}` });
        }

        if (!redeemed) {
          redemption.retryCount = (redemption.retryCount || 0) + 1;
          const elapsedMs  = Date.now() - new Date(redemption.addedAt || 0).getTime();
          const elapsedMin = Math.floor(elapsedMs / 60000);
          if (elapsedMs > 2 * 60 * 60 * 1000) {
            redemption.status = 'error';
            redemption.error  = (lastError || 'All methods failed').slice(0, 100);
            redemptionHistory.push({ ...redemption });
            logger.addActivity('redeemer_error', {
              message: `Gave up after 2h (${redemption.retryCount} attempts): ${(lastError || '').slice(0, 60)}`
            });
          } else {
            redemption.status = 'waiting';
            logger.addActivity('redeemer_error', {
              message: `Will retry (attempt ${redemption.retryCount}, +${elapsedMin}min): ${(lastError || '').slice(0, 60)}`
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

    let eoaHas = false, safeHas = false;
    try {
      if (tokenId) eoaHas = await hasTokenBalance(provider, wallet.address, tokenId);
    } catch (e) {
      logger.addActivity('redeemer', { message: `RPC error checking EOA balance for "${label}" — will retry` });
      return false;
    }
    try {
      if (safAddr && tokenId) safeHas = await hasTokenBalance(provider, safAddr, tokenId);
    } catch (e) {
      logger.addActivity('redeemer', { message: `RPC error checking Safe balance for "${label}" — will retry` });
      return false;
    }

    logger.addActivity('redeemer', {
      message: `Balance check "${label}" | EOA(${wallet.address.slice(0, 10)}…): ${eoaHas} | Safe(${safAddr ? safAddr.slice(0, 10) + '…' : 'unknown'}): ${safeHas}`
    });

    if (!eoaHas && !safeHas) {
      logger.addActivity('redeemer', { message: `No tokens found for "${label}" — market may not be resolved yet, will retry` });
      return false;
    }

    const fromSafe = !eoaHas && safeHas;
    logger.addActivity('redeemer', {
      message: `Redeeming "${label}" from ${fromSafe ? `Safe (${safAddr.slice(0, 10)}…)` : `EOA (${wallet.address.slice(0, 10)}…)`}`
    });

    const tx      = fromSafe && safAddr
      ? await redeemViaSafe(wallet, condId, safAddr, provider)
      : await redeemViaEOA(wallet, condId, provider);
    const receipt = await tx.wait();
    const ok      = verifyRedemptionReceipt(receipt, fromSafe ? safAddr : null);

    if (ok) {
      redemptionHistory.push({
        question, conditionId, tokenId,
        status: 'redeemed',
        txHash: receipt.transactionHash,
        redeemedAt: new Date().toISOString()
      });
      logger.addActivity('redeem_success', {
        message: `COLLECTED (${fromSafe ? 'Safe' : 'EOA'})! TX: ${receipt.transactionHash.slice(0, 20)}… | "${label}"`
      });
      return true;
    }

    logger.addActivity('redeemer', {
      message: `Tx mined but no collateral Transfer for "${label}" — will retry next tick`
    });
    return false;

  } catch (err) {
    logger.addActivity('redeemer', {
      message: `redeemPosition failed for "${label}": ${(err.reason || err.message || '').slice(0, 80)} — will retry`
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
    safeAddress:    safeAddress || null,
    totalRedeemed:  redemptionHistory.filter(r => r.status === 'redeemed').length,
    totalLost:      redemptionHistory.filter(r => r.status === 'no_payout').length,
    totalErrors:    redemptionHistory.filter(r => r.status === 'error').length
  };
}

module.exports = {
  addPendingRedemption,
  checkAndRedeem,
  redeemPosition,
  getRedemptionStatus
};
