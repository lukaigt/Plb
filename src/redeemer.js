const { ethers } = require('ethers');
const logger = require('./logger');
const trader = require('./trader');

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const POLYGON_RPCS = [
  'https://polygon-rpc.com',
  'https://rpc-mainnet.matic.quiknode.pro',
  'https://polygon.llamarpc.com',
  'https://polygon-mainnet.public.blastapi.io'
];

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)'
];

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
  'function wcol() view returns (address)'
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

const pendingRedemptions = [];
const redemptionHistory = [];
let safeAddress = null;
let isChecking = false;

async function getProxyWalletAddress() {
  if (safeAddress) return safeAddress;

  // 1. From CLOB SDK (set during initClient)
  const fromTrader = trader.getProxyWallet();
  if (fromTrader) {
    safeAddress = fromTrader;
    logger.addActivity('redeemer', { message: `Proxy wallet (CLOB API): ${fromTrader.substring(0, 10)}...` });
    return safeAddress;
  }

  // 2. From .env override
  const envProxy = process.env.PROXY_WALLET_ADDRESS;
  if (envProxy) {
    safeAddress = envProxy;
    logger.addActivity('redeemer', { message: `Proxy wallet (env): ${envProxy.substring(0, 10)}...` });
    return safeAddress;
  }

  // 3. Compute on-chain from SafeFactory — deterministic, no API needed
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (privateKey) {
    try {
      const provider = await getWorkingProvider();
      const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const eoaAddress = new ethers.Wallet(cleanKey).address;
      const factory = new ethers.Contract(SAFE_FACTORY_ADDRESS, SAFE_FACTORY_ABI, provider);
      const computed = await factory.computeProxyAddress(eoaAddress);
      if (computed && computed !== ethers.constants.AddressZero) {
        safeAddress = computed;
        logger.addActivity('redeemer', { message: `Proxy wallet (SafeFactory on-chain): ${computed.substring(0, 10)}...` });
        return safeAddress;
      }
    } catch (err) {
      logger.addActivity('redeemer', { message: `SafeFactory lookup failed: ${err.message?.slice(0, 60)}` });
    }
  }

  logger.addActivity('redeemer', { message: 'No proxy wallet found — checking EOA only. Set PROXY_WALLET_ADDRESS in .env if redemption fails.' });
  return null;
}

function addPendingRedemption(trade) {
  if (!trade || (!trade.conditionId && !trade.tokenId)) {
    logger.addActivity('redeemer', {
      message: `Cannot track trade for redemption: missing conditionId and tokenId`
    });
    return;
  }

  const existing = pendingRedemptions.find(r =>
    (r.tokenId && trade.tokenId && r.tokenId === trade.tokenId) ||
    (r.conditionId && trade.conditionId && r.conditionId === trade.conditionId && r.side === trade.side)
  );
  if (existing) return;

  pendingRedemptions.push({
    conditionId: trade.conditionId,
    tokenId: trade.tokenId || null,
    negRisk: trade.negRisk !== undefined ? trade.negRisk : true,
    marketEndTime: trade.marketEndTime,
    action: trade.action,
    side: trade.side,
    size: trade.size,
    price: trade.price,
    question: trade.question,
    addedAt: new Date().toISOString(),
    status: 'waiting'
  });

  logger.addActivity('redeemer', {
    message: `Tracking trade for redemption: ${trade.question || 'BTC trade'} | conditionId: ${trade.conditionId.substring(0, 15)}...`
  });
}

function getProvider() {
  const customRpc = process.env.POLYGON_RPC_URL;
  if (customRpc) {
    return new ethers.providers.JsonRpcProvider(customRpc);
  }
  return new ethers.providers.JsonRpcProvider(POLYGON_RPCS[0]);
}

async function getWorkingProvider() {
  const customRpc = process.env.POLYGON_RPC_URL;
  const rpcsToTry = customRpc ? [customRpc, ...POLYGON_RPCS] : POLYGON_RPCS;

  for (const rpc of rpcsToTry) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getNetwork();
      return provider;
    } catch {
      continue;
    }
  }
  return new ethers.providers.JsonRpcProvider(POLYGON_RPCS[0]);
}


function formatConditionId(rawConditionId) {
  if (!rawConditionId) return null;

  let cid = String(rawConditionId);

  if (cid.startsWith('0x') && cid.length === 66) {
    return cid;
  }

  if (cid.startsWith('0x')) {
    try {
      return ethers.utils.hexZeroPad(cid, 32);
    } catch {
      return null;
    }
  }

  try {
    return ethers.utils.hexZeroPad(ethers.utils.hexlify(ethers.BigNumber.from(cid)), 32);
  } catch {
    return null;
  }
}

function encodeRedeemCall(conditionId, negRisk, wrappedCollateral, amounts) {
  if (negRisk) {
    const iface = new ethers.utils.Interface(NEG_RISK_ABI);
    return iface.encodeFunctionData('redeemPositions', [
      conditionId,
      amounts || [1]
    ]);
  } else {
    const iface = new ethers.utils.Interface(CTF_ABI);
    return iface.encodeFunctionData('redeemPositions', [
      USDC_ADDRESS,
      ethers.constants.HashZero,
      conditionId,
      [1, 2]
    ]);
  }
}

async function signAndExecSafe(wallet, safeContract, to, data, provider) {
  const nonce = await safeContract.nonce();
  const gasPrice = await provider.getGasPrice();

  const txHash = await safeContract.getTransactionHash(
    to, 0, data, 0, 0, 0, 0,
    ethers.constants.AddressZero,
    ethers.constants.AddressZero,
    nonce
  );

  const signature = await wallet.signMessage(ethers.utils.arrayify(txHash));
  const sigBytes = ethers.utils.arrayify(signature);
  let v = sigBytes[64];
  if (v < 27) v += 27;
  v += 4;
  sigBytes[64] = v;
  const adjustedSig = ethers.utils.hexlify(sigBytes);

  const tx = await safeContract.execTransaction(
    to, 0, data, 0, 0, 0, 0,
    ethers.constants.AddressZero,
    ethers.constants.AddressZero,
    adjustedSig,
    { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
  );

  return tx;
}

async function getWrappedCollateral(provider) {
  try {
    const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, provider);
    const wcol = await adapter.wcol();
    return wcol;
  } catch (err) {
    logger.addActivity('redeemer', {
      message: `Could not fetch wrapped collateral: ${err.message.substring(0, 50)}`
    });
    return null;
  }
}

async function lookupOutcomeIndex(conditionId, tokenId) {
  try {
    const url = `https://gamma-api.polymarket.com/markets?conditionId=${conditionId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const markets = await res.json();
    if (!Array.isArray(markets) || markets.length === 0) return null;
    const market = markets[0];
    let clobIds = market.clobTokenIds;
    if (typeof clobIds === 'string') {
      try { clobIds = JSON.parse(clobIds); } catch { return null; }
    }
    if (!Array.isArray(clobIds)) return null;
    const idx = clobIds.indexOf(tokenId);
    if (idx >= 0) return { index: idx, total: clobIds.length };
    return null;
  } catch {
    return null;
  }
}

async function redeemViaEOA(wallet, conditionId, negRisk, provider, wrappedCollateral, tokenId) {
  const gasPrice = await provider.getGasPrice();

  if (negRisk) {
    const contract = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

    let balance = ethers.BigNumber.from(0);
    if (tokenId) {
      balance = await ctf.balanceOf(wallet.address, tokenId);
    }

    if (balance.eq(0)) {
      throw new Error('No token balance for NegRiskAdapter redemption');
    }

    let outcomeInfo = await lookupOutcomeIndex(conditionId, tokenId);
    let amounts;
    if (outcomeInfo) {
      amounts = new Array(outcomeInfo.total).fill(ethers.BigNumber.from(0));
      amounts[outcomeInfo.index] = balance;
      logger.addActivity('redeemer', {
        message: `NegRiskAdapter: redeeming ${ethers.utils.formatUnits(balance, 6)} tokens (outcome ${outcomeInfo.index} of ${outcomeInfo.total})`
      });
    } else {
      amounts = [balance, ethers.BigNumber.from(0)];
      logger.addActivity('redeemer', {
        message: `NegRiskAdapter: redeeming ${ethers.utils.formatUnits(balance, 6)} tokens (defaulting to outcome 0)`
      });
    }

    const tx = await contract.redeemPositions(
      conditionId,
      amounts,
      { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
    );

    return tx;
  } else {
    const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const tx = await contract.redeemPositions(
      USDC_ADDRESS,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
    );
    return tx;
  }
}

async function redeemViaSafe(wallet, conditionId, negRisk, safAddr, provider, wrappedCollateral, tokenId) {
  const safeContract = new ethers.Contract(safAddr, SAFE_ABI, wallet);
  const targetAddress = negRisk ? NEG_RISK_ADAPTER : CTF_ADDRESS;

  let amounts = null;
  if (negRisk && tokenId) {
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const balance = await ctf.balanceOf(safAddr, tokenId);
    if (balance.eq(0)) {
      throw new Error('No token balance on Safe for NegRiskAdapter redemption');
    }
    let outcomeInfo = await lookupOutcomeIndex(conditionId, tokenId);
    if (outcomeInfo) {
      amounts = new Array(outcomeInfo.total).fill(ethers.BigNumber.from(0));
      amounts[outcomeInfo.index] = balance;
    } else {
      amounts = [balance, ethers.BigNumber.from(0)];
    }
  }

  const redeemData = encodeRedeemCall(conditionId, negRisk, wrappedCollateral, amounts);

  const tx = await signAndExecSafe(wallet, safeContract, targetAddress, redeemData, provider);
  return tx;
}

async function hasTokenBalance(ctf, walletAddress, tokenId) {
  if (!tokenId) return true;
  try {
    const balance = await ctf.balanceOf(walletAddress, tokenId);
    return balance.gt(0);
  } catch {
    return true;
  }
}

const EXECUTION_SUCCESS_TOPIC = ethers.utils.id('ExecutionSuccess(bytes32,uint256)');
const EXECUTION_FAILURE_TOPIC = ethers.utils.id('ExecutionFailure(bytes32,uint256)');
const USDC_TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

function verifyRedemptionReceipt(receipt, safAddr) {
  if (!safAddr) {
    return receipt.status === 1;
  }

  const safeLower = safAddr.toLowerCase();

  let hasExecutionSuccess = false;
  let hasExecutionFailure = false;
  let hasUSDCTransfer = false;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === safeLower) {
      if (log.topics[0] === EXECUTION_SUCCESS_TOPIC) {
        hasExecutionSuccess = true;
      } else if (log.topics[0] === EXECUTION_FAILURE_TOPIC) {
        hasExecutionFailure = true;
      }
    }

    if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && log.topics[0] === USDC_TRANSFER_TOPIC) {
      hasUSDCTransfer = true;
    }
  }

  if (hasExecutionFailure) {
    return false;
  }

  if (hasExecutionSuccess && hasUSDCTransfer) {
    return true;
  }

  if (hasExecutionSuccess) {
    return true;
  }

  return false;
}

async function batchBalanceCheck(ctf, address, redemptions) {
  const BATCH = 10;
  const results = [];
  for (let i = 0; i < redemptions.length; i += BATCH) {
    const batch = redemptions.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (r) => {
        if (!r.tokenId) return { r, bal: ethers.BigNumber.from(1) };
        const bal = await ctf.balanceOf(address, r.tokenId);
        return { r, bal };
      })
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
      else results.push({ r: batch[settled.indexOf(s)], bal: ethers.BigNumber.from(1) });
    }
  }
  return results;
}

async function batchPayoutCheck(ctf, redemptions) {
  const BATCH = 10;
  const results = [];
  for (let i = 0; i < redemptions.length; i += BATCH) {
    const batch = redemptions.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (item) => {
        const cid = formatConditionId(item.redemption.conditionId);
        if (!cid) return { ...item, payout: null };
        const pd = await ctf.payoutDenominator(cid);
        return { ...item, payout: pd, formattedCid: cid };
      })
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
    }
  }
  return results;
}

async function checkAndRedeem() {
  if (isChecking) return;
  if (pendingRedemptions.length === 0) return;

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) return;

  isChecking = true;

  try {
    const provider = await getWorkingProvider();
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(cleanKey, provider);

    const safAddr = await getProxyWalletAddress();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const wrappedCollateral = await getWrappedCollateral(provider);

    const now = new Date();
    const ready = pendingRedemptions.filter(r => {
      if (r.status !== 'waiting') return false;
      const endTime = new Date(r.marketEndTime);
      return now >= new Date(endTime.getTime() + 30 * 1000);
    });

    if (ready.length === 0) {
      isChecking = false;
      return;
    }

    logger.addActivity('redeemer', {
      message: `Fast balance check on ${ready.length} position(s)...`
    });

    const eoaResults = await batchBalanceCheck(ctf, wallet.address, ready);

    let safeMap = new Map();
    if (safAddr) {
      const safeResults = await batchBalanceCheck(ctf, safAddr, ready);
      for (const sr of safeResults) safeMap.set(sr.r, sr.bal);
    }

    let zeroCount = 0;
    const withTokens = [];

    for (const { r, bal } of eoaResults) {
      if (bal.gt(0)) {
        withTokens.push({ redemption: r, location: 'eoa' });
        continue;
      }

      const safeBal = safeMap.get(r);
      if (safeBal && safeBal.gt(0)) {
        withTokens.push({ redemption: r, location: 'safe' });
        continue;
      }

      // Both EOA and Safe show zero — only give up after 5 consecutive checks
      // (RPC can return stale data or be temporarily unavailable)
      r.noBalanceAttempts = (r.noBalanceAttempts || 0) + 1;
      if (r.noBalanceAttempts >= 5) {
        r.status = 'no_balance';
        r.redeemedAt = new Date().toISOString();
        redemptionHistory.push({ ...r });
        zeroCount++;
      } else {
        logger.addActivity('redeemer', {
          message: `Zero balance on check ${r.noBalanceAttempts}/5 for "${(r.question || '').slice(0, 40)}" — will retry`
        });
      }
    }

    for (let i = pendingRedemptions.length - 1; i >= 0; i--) {
      if (pendingRedemptions[i].status === 'no_balance') {
        pendingRedemptions.splice(i, 1);
      }
    }

    logger.addActivity('redeemer', {
      message: `Balance check: ${zeroCount} empty (cleared), ${withTokens.length} with tokens`
    });

    if (withTokens.length === 0) {
      isChecking = false;
      return;
    }

    const payoutResults = await batchPayoutCheck(ctf, withTokens);

    const redeemable = payoutResults.filter(p => p.payout && !p.payout.eq(0) && p.formattedCid);
    const notResolved = payoutResults.length - redeemable.length;

    if (notResolved > 0) {
      logger.addActivity('redeemer', {
        message: `${notResolved} position(s) not yet resolved (will retry), ${redeemable.length} ready to redeem`
      });
    }

    for (const { redemption, location, formattedCid } of redeemable) {
      try {
        const redeemFromEOA = location === 'eoa';
        const redeemFromSafe = location === 'safe';

        logger.addActivity('redeemer', {
          message: `RESOLVED — redeeming from ${redeemFromEOA ? 'EOA' : 'Safe'}: ${redemption.question || 'BTC trade'}`
        });

        redemption.status = 'redeeming';

        let redeemed = false;
        let lastError = null;

        const isNegRisk = redemption.negRisk === true;
        const attempts = isNegRisk
          ? [
              { negRisk: true, label: 'NegRiskAdapter' },
              { negRisk: false, label: 'CTF' }
            ]
          : [
              { negRisk: false, label: 'CTF' },
              { negRisk: true, label: 'NegRiskAdapter' }
            ];

        for (const attempt of attempts) {
          if (redeemed) break;

          try {
            let tx;
            if (redeemFromSafe && safAddr) {
              tx = await redeemViaSafe(wallet, formattedCid, attempt.negRisk, safAddr, provider, wrappedCollateral, redemption.tokenId);
            } else {
              tx = await redeemViaEOA(wallet, formattedCid, attempt.negRisk, provider, wrappedCollateral, redemption.tokenId);
            }

            const receipt = await tx.wait();
            const internalSuccess = verifyRedemptionReceipt(receipt, redeemFromSafe ? safAddr : null);

            if (!internalSuccess) {
              lastError = 'Internal call failed';
              continue;
            }

            redemption.status = 'redeemed';
            redemption.txHash = receipt.transactionHash;
            redemption.redeemedAt = new Date().toISOString();
            redemptionHistory.push({ ...redemption });
            redeemed = true;

            const winIds = redemption.tradeIds || (redemption.tradeId ? [redemption.tradeId] : []);
            for (const tid of winIds) {
              logger.updateTrade(tid, { result: 'win', pnl: 0 });
            }

            logger.addActivity('redeem_success', {
              message: `COLLECTED via ${attempt.label}! TX: ${receipt.transactionHash.substring(0, 20)}... | ${redemption.question || 'BTC trade'}`
            });
          } catch (err) {
            lastError = err.message || String(err);
            logger.addActivity('redeemer', {
              message: `${attempt.label} failed: ${lastError.substring(0, 60)}...`
            });
          }
        }

        if (!redeemed) {
          const errMsg = lastError || 'All methods failed';
          if (errMsg.includes('payout is zero') || errMsg.includes('result is empty')) {
            redemption.status = 'no_payout';
            redemption.redeemedAt = new Date().toISOString();
            redemptionHistory.push({ ...redemption });
          } else {
            redemption.status = 'error';
            redemption.error = errMsg.substring(0, 100);
            redemption.retryCount = (redemption.retryCount || 0) + 1;
            if (redemption.retryCount >= 3) {
              redemptionHistory.push({ ...redemption });
              logger.addActivity('redeemer_error', {
                message: `Redeem failed after 3 retries: ${errMsg.substring(0, 80)}`
              });
            } else {
              redemption.status = 'waiting';
              logger.addActivity('redeemer_error', {
                message: `Redeem failed (attempt ${redemption.retryCount}/3, will retry): ${errMsg.substring(0, 60)}`
              });
            }
          }
        }
      } catch (err) {
        redemption.status = 'error';
        redemption.error = err.message?.substring(0, 100);
      }
    }

    for (let i = pendingRedemptions.length - 1; i >= 0; i--) {
      const r = pendingRedemptions[i];
      if (r.status === 'redeemed' || r.status === 'no_payout' || r.status === 'no_balance' || (r.status === 'error' && r.retryCount >= 3)) {
        pendingRedemptions.splice(i, 1);
      }
    }

  } catch (err) {
    logger.addActivity('redeemer_error', {
      message: `Redeemer cycle error: ${err.message?.substring(0, 80)}`
    });
  } finally {
    isChecking = false;
  }
}

function getRedemptionStatus() {
  return {
    pending: pendingRedemptions.map(r => ({
      question: r.question,
      side: r.side,
      size: r.size,
      status: r.status,
      marketEndTime: r.marketEndTime,
      addedAt: r.addedAt
    })),
    history: redemptionHistory.slice(0, 20).map(r => ({
      question: r.question,
      side: r.side,
      size: r.size,
      status: r.status,
      txHash: r.txHash || null,
      redeemedAt: r.redeemedAt
    })),
    safeAddress: safeAddress || null,
    totalRedeemed: redemptionHistory.filter(r => r.status === 'redeemed').length,
    totalLost: redemptionHistory.filter(r => r.status === 'no_payout').length,
    totalErrors: redemptionHistory.filter(r => r.status === 'error').length
  };
}

module.exports = {
  addPendingRedemption,
  checkAndRedeem,
  getRedemptionStatus
};
