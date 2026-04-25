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
      message: `Checking ${ready.length} position(s) for redemption...`
    });

    for (const redemption of ready) {
      try {
        const conditionId = formatConditionId(redemption.conditionId);

        if (!conditionId) {
          redemption.status = 'error';
          redemption.error = `Invalid conditionId: ${redemption.conditionId}`;
          logger.addActivity('redeemer_error', {
            message: `Invalid conditionId for ${redemption.question || 'trade'}: ${redemption.conditionId}`
          });
          continue;
        }

        // Check on-chain if the market has resolved first — if not, skip silently
        let payoutDenom;
        try {
          payoutDenom = await ctf.payoutDenominator(conditionId);
        } catch (rpcErr) {
          logger.addActivity('redeemer', {
            message: `RPC error checking payout for "${(redemption.question || 'trade').slice(0, 40)}" — will retry`
          });
          continue;
        }

        if (payoutDenom.eq(0)) {
          // Market not yet resolved on-chain — wait silently
          continue;
        }

        // Market is resolved — check token balances on EOA and Safe
        const eoaHasBalance = await hasTokenBalance(ctf, wallet.address, redemption.tokenId);
        const safeHasBalance = safAddr ? await hasTokenBalance(ctf, safAddr, redemption.tokenId) : false;

        if (!eoaHasBalance && !safeHasBalance) {
          const retryCount = redemption.balanceRetryCount || 0;
          if (retryCount < 3) {
            redemption.balanceRetryCount = retryCount + 1;
            logger.addActivity('redeemer', {
              message: `No token balance yet (retry ${retryCount + 1}/3): "${(redemption.question || 'trade').slice(0, 40)}"`
            });
            continue;
          }
          redemption.status = 'no_payout';
          redemption.redeemedAt = new Date().toISOString();
          redemptionHistory.push({ ...redemption });
          logger.addActivity('redeemer', {
            message: `No token balance after 3 checks — marking lost: "${(redemption.question || 'trade').slice(0, 40)}"`
          });
          continue;
        }

        const redeemFromEOA = eoaHasBalance;
        const redeemFromSafe = !eoaHasBalance && safeHasBalance;

        logger.addActivity('redeemer', {
          message: `Market resolved! Tokens on ${redeemFromEOA ? 'EOA' : 'Safe'}. Redeeming: "${(redemption.question || 'trade').slice(0, 40)}"`
        });

        redemption.status = 'redeeming';

        let redeemed = false;
        let lastError = null;

        const isNegRisk = redemption.negRisk === true;
        const attempts = isNegRisk
          ? [{ negRisk: true, label: 'NegRiskAdapter' }, { negRisk: false, label: 'CTF' }]
          : [{ negRisk: false, label: 'CTF' }, { negRisk: true, label: 'NegRiskAdapter' }];

        for (const attempt of attempts) {
          if (redeemed) break;
          try {
            logger.addActivity('redeemer', {
              message: `Trying ${attempt.label} via ${redeemFromEOA ? 'EOA' : 'Safe'}...`
            });

            let tx;
            if (redeemFromSafe && safAddr) {
              tx = await redeemViaSafe(wallet, conditionId, attempt.negRisk, safAddr, provider, wrappedCollateral, redemption.tokenId);
            } else {
              tx = await redeemViaEOA(wallet, conditionId, attempt.negRisk, provider, wrappedCollateral, redemption.tokenId);
            }

            const receipt = await tx.wait();
            const internalSuccess = verifyRedemptionReceipt(receipt, redeemFromSafe ? safAddr : null);

            if (!internalSuccess) {
              lastError = 'Safe internal call failed';
              logger.addActivity('redeemer', { message: `${attempt.label} tx mined but internal call failed — trying next` });
              continue;
            }

            redemption.status = 'redeemed';
            redemption.txHash = receipt.transactionHash;
            redemption.redeemedAt = new Date().toISOString();
            redemptionHistory.push({ ...redemption });
            redeemed = true;

            const winIds = redemption.tradeIds || (redemption.tradeId ? [redemption.tradeId] : []);
            for (const tid of winIds) logger.updateTrade(tid, { result: 'win', pnl: 0 });

            logger.addActivity('redeem_success', {
              message: `COLLECTED via ${attempt.label}! TX: ${receipt.transactionHash.substring(0, 20)}... | "${(redemption.question || 'trade').slice(0, 40)}"`
            });
          } catch (err) {
            lastError = err.message || String(err);
            logger.addActivity('redeemer', {
              message: `${attempt.label} failed: ${lastError.substring(0, 60)} — trying next`
            });
          }
        }

        if (!redeemed) {
          const errMsg = lastError || 'All methods failed';
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
      } catch (err) {
        redemption.status = 'error';
        redemption.error = err.message?.substring(0, 100);
        logger.addActivity('redeemer_error', {
          message: `Redeem check error: ${err.message?.substring(0, 80)}`
        });
      }
    }

    const completed = pendingRedemptions.filter(r =>
      r.status === 'redeemed' || r.status === 'no_payout' || (r.status === 'error' && r.retryCount >= 3)
    );
    for (const done of completed) {
      const idx = pendingRedemptions.indexOf(done);
      if (idx >= 0) pendingRedemptions.splice(idx, 1);
    }

  } catch (err) {
    logger.addActivity('redeemer_error', {
      message: `Redeemer cycle error: ${err.message?.substring(0, 80)}`
    });
  } finally {
    isChecking = false;
  }
}

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
    const wallet = new ethers.Wallet(cleanKey, provider);
    const safAddr = await getProxyWalletAddress();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const wrappedCollateral = await getWrappedCollateral(provider);

    const condId = formatConditionId(conditionId);
    if (!condId) {
      logger.addActivity('redeemer_error', { message: `Invalid conditionId for "${label}"` });
      return false;
    }

    // For standard (non-NegRisk) markets, verify on-chain resolution via CTF payoutDenominator.
    // For NegRisk markets this check is skipped — NegRisk resolution goes through its own
    // adapter and ctf.payoutDenominator() returns 0 even after the game ends. The redemption
    // call itself will revert if the market is not yet resolved, which is caught below.
    if (!negRisk) {
      let payoutDenom;
      try { payoutDenom = await ctf.payoutDenominator(condId); } catch {
        logger.addActivity('redeemer', { message: `RPC error checking payout for "${label}" — will retry next tick` });
        return false;
      }
      if (payoutDenom.eq(0)) {
        logger.addActivity('redeemer', { message: `Market not yet resolved on-chain for "${label}" — will retry` });
        return false;
      }
    }

    // Check which address holds the tokens (wrapped in try/catch — RPC blips must not kill the loop)
    let eoaHas = false;
    let safeHas = false;
    try {
      if (tokenId) eoaHas = !(await ctf.balanceOf(wallet.address, tokenId)).eq(0);
    } catch (e) {
      logger.addActivity('redeemer', { message: `RPC error checking EOA balance for "${label}": ${(e.message||'').slice(0,60)} — will retry` });
      return false;
    }
    try {
      if (safAddr && tokenId) safeHas = !(await ctf.balanceOf(safAddr, tokenId)).eq(0);
    } catch (e) {
      logger.addActivity('redeemer', { message: `RPC error checking Safe balance for "${label}": ${(e.message||'').slice(0,60)} — will retry` });
      return false;
    }

    if (!eoaHas && !safeHas) {
      if (!safAddr) {
        logger.addActivity('redeemer_error', {
          message: `CRITICAL: Proxy wallet address unknown — cannot check Safe balance for "${label}". Add PROXY_WALLET_ADDRESS=<your_safe_addr> to .env`
        });
      } else {
        logger.addActivity('redeemer', { message: `No token balance on EOA (${wallet.address.slice(0,10)}…) or Safe (${safAddr.slice(0,10)}…) for "${label}" — market may not be resolved yet, will retry` });
      }
      return false;
    }

    const redeemFromSafe = !eoaHas && safeHas;
    logger.addActivity('redeemer', {
      message: `Redeeming "${label}" from ${redeemFromSafe ? `Safe (${safAddr.slice(0,10)}…)` : `EOA (${wallet.address.slice(0,10)}…)`} — trying ${negRisk ? 'NegRisk then CTF' : 'CTF then NegRisk'}`
    });

    const attempts = negRisk
      ? [{ negRisk: true, label: 'NegRiskAdapter' }, { negRisk: false, label: 'CTF' }]
      : [{ negRisk: false, label: 'CTF' }, { negRisk: true, label: 'NegRiskAdapter' }];

    for (const att of attempts) {
      try {
        let tx;
        if (redeemFromSafe && safAddr) {
          tx = await redeemViaSafe(wallet, condId, att.negRisk, safAddr, provider, wrappedCollateral, tokenId);
        } else {
          tx = await redeemViaEOA(wallet, condId, att.negRisk, provider, wrappedCollateral, tokenId);
        }
        const receipt = await tx.wait();

        // For Safe transactions, verify the inner call actually succeeded (execTransaction
        // returns status=1 even when the inner call reverts — only ExecutionFailure reveals it)
        if (redeemFromSafe && safAddr) {
          const ok = verifyRedemptionReceipt(receipt, safAddr);
          if (!ok) {
            logger.addActivity('redeemer', { message: `${att.label} via Safe — ExecutionFailure on-chain for "${label}" — trying next method` });
            continue;
          }
        }

        redemptionHistory.push({ question, conditionId, tokenId, status: 'redeemed', txHash: receipt.transactionHash, redeemedAt: new Date().toISOString() });
        logger.addActivity('redeem_success', {
          message: `COLLECTED via ${att.label} (${redeemFromSafe ? 'Safe' : 'EOA'})! TX: ${receipt.transactionHash.substring(0, 20)}… | "${label}"`
        });
        return true;
      } catch (err) {
        logger.addActivity('redeemer', { message: `${att.label} failed for "${label}": ${(err.message || '').substring(0, 80)} — trying next` });
      }
    }

    logger.addActivity('redeemer_error', { message: `All redeem methods failed for "${label}" — will retry next tick` });
    return false;

  } catch (err) {
    logger.addActivity('redeemer_error', { message: `redeemPosition error for "${label}": ${(err.message || '').substring(0, 80)}` });
    return false;
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
  redeemPosition,
  getRedemptionStatus
};
