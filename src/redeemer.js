const { ethers } = require('ethers');
const logger = require('./logger');

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const DEFAULT_RPC = 'https://polygon-rpc.com';
const KNOWN_PROXY_WALLET = '0x94eAb3d7352aEb36A7378bc635b97E2968112e7E';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)'
];

const NEG_RISK_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
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
let safeVerified = false;
let isChecking = false;

function addPendingRedemption(trade) {
  if (!trade || (!trade.conditionId && !trade.tokenId)) {
    logger.addActivity('redeemer', {
      message: `Cannot track trade for redemption: missing conditionId and tokenId`
    });
    return;
  }

  const key = trade.conditionId || trade.tokenId;
  const existing = pendingRedemptions.find(r => (r.conditionId && r.conditionId === trade.conditionId) || (r.tokenId && r.tokenId === trade.tokenId));
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
  const rpcUrl = process.env.POLYGON_RPC_URL || DEFAULT_RPC;
  return new ethers.providers.JsonRpcProvider(rpcUrl);
}

async function discoverSafeAddress(wallet, provider) {
  if (safeAddress && safeVerified) return safeAddress;

  try {
    const factory = new ethers.Contract(SAFE_FACTORY_ADDRESS, SAFE_FACTORY_ABI, provider);
    const computed = await factory.computeProxyAddress(wallet.address);
    const code = await provider.getCode(computed);

    if (code === '0x') {
      if (KNOWN_PROXY_WALLET) {
        const proxyCode = await provider.getCode(KNOWN_PROXY_WALLET);
        if (proxyCode !== '0x') {
          logger.addActivity('redeemer', {
            message: `Factory lookup failed — using known proxy wallet: ${KNOWN_PROXY_WALLET.substring(0, 10)}...`
          });
          safeAddress = KNOWN_PROXY_WALLET;
          return safeAddress;
        }
      }
      logger.addActivity('redeemer', {
        message: `No deployed Safe found for ${wallet.address.substring(0, 10)}... — will try direct EOA redemption`
      });
      return null;
    }

    const safe = new ethers.Contract(computed, SAFE_ABI, provider);
    try {
      const owners = await safe.getOwners();
      const threshold = await safe.getThreshold();
      const isOwner = owners.some(o => o.toLowerCase() === wallet.address.toLowerCase());

      if (!isOwner) {
        logger.addActivity('redeemer_error', {
          message: `Safe ${computed.substring(0, 10)}... found but EOA is not an owner — cannot sign transactions`
        });
        return null;
      }

      if (threshold.toNumber() > 1) {
        logger.addActivity('redeemer_error', {
          message: `Safe ${computed.substring(0, 10)}... requires ${threshold.toString()} signatures — single-sig redemption not possible`
        });
        return null;
      }

      safeAddress = computed;
      safeVerified = true;
      logger.addActivity('redeemer', {
        message: `Safe wallet verified: ${computed.substring(0, 10)}... | Owner confirmed, threshold=1`
      });
      return safeAddress;
    } catch (err) {
      safeAddress = computed;
      logger.addActivity('redeemer', {
        message: `Safe wallet found: ${computed.substring(0, 10)}... (could not verify ownership: ${err.message.substring(0, 40)})`
      });
      return safeAddress;
    }
  } catch (err) {
    logger.addActivity('redeemer_error', {
      message: `Safe discovery error: ${err.message.substring(0, 80)}`
    });
    return null;
  }
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

function encodeRedeemCall(conditionId, negRisk) {
  const abi = negRisk ? NEG_RISK_ABI : CTF_ABI;
  const iface = new ethers.utils.Interface(abi);
  return iface.encodeFunctionData('redeemPositions', [
    USDC_ADDRESS,
    ethers.constants.HashZero,
    conditionId,
    [1, 2]
  ]);
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

async function redeemViaEOA(wallet, conditionId, negRisk, provider) {
  const targetAddress = negRisk ? NEG_RISK_ADAPTER : CTF_ADDRESS;
  const targetAbi = negRisk ? NEG_RISK_ABI : CTF_ABI;
  const contract = new ethers.Contract(targetAddress, targetAbi, wallet);
  const gasPrice = await provider.getGasPrice();

  const tx = await contract.redeemPositions(
    USDC_ADDRESS,
    ethers.constants.HashZero,
    conditionId,
    [1, 2],
    { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
  );

  return tx;
}

async function redeemViaSafe(wallet, conditionId, negRisk, safAddr, provider) {
  const safeContract = new ethers.Contract(safAddr, SAFE_ABI, wallet);
  const targetAddress = negRisk ? NEG_RISK_ADAPTER : CTF_ADDRESS;
  const redeemData = encodeRedeemCall(conditionId, negRisk);

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

async function checkAndRedeem() {
  if (isChecking) return;
  if (pendingRedemptions.length === 0) return;

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) return;

  isChecking = true;

  try {
    const provider = getProvider();
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(cleanKey, provider);

    const safAddr = await discoverSafeAddress(wallet, provider);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

    const now = new Date();
    const ready = pendingRedemptions.filter(r => {
      if (r.status !== 'waiting') return false;
      const endTime = new Date(r.marketEndTime);
      return now >= new Date(endTime.getTime() + 2 * 60 * 1000);
    });

    if (ready.length === 0) {
      isChecking = false;
      return;
    }

    logger.addActivity('redeemer', {
      message: `Checking ${ready.length} trade(s) for redemption...`
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

        const payoutDenom = await ctf.payoutDenominator(conditionId);

        if (payoutDenom.eq(0)) {
          logger.addActivity('redeemer', {
            message: `Market not yet resolved: ${redemption.question || conditionId.substring(0, 15) + '...'}`
          });
          continue;
        }

        const walletToCheck = safAddr || wallet.address;
        const hasBalance = await hasTokenBalance(ctf, walletToCheck, redemption.tokenId);

        if (!hasBalance) {
          redemption.status = 'no_payout';
          redemption.redeemedAt = new Date().toISOString();
          redemptionHistory.push({ ...redemption });
          logger.addActivity('redeemer', {
            message: `No token balance (likely lost): ${redemption.question || 'BTC trade'}`
          });
          continue;
        }

        redemption.status = 'redeeming';
        logger.addActivity('redeemer', {
          message: `Market resolved! Redeeming: ${redemption.question || 'BTC trade'}`
        });

        let redeemed = false;
        let lastError = null;

        const attempts = [
          { negRisk: true, label: 'NegRiskAdapter' },
          { negRisk: false, label: 'CTF' }
        ];

        for (const attempt of attempts) {
          if (redeemed) break;

          try {
            logger.addActivity('redeemer', {
              message: `Trying ${attempt.label} for: ${redemption.question || 'BTC trade'}`
            });

            let tx;
            if (safAddr) {
              tx = await redeemViaSafe(wallet, conditionId, attempt.negRisk, safAddr, provider);
            } else {
              tx = await redeemViaEOA(wallet, conditionId, attempt.negRisk, provider);
            }

            const receipt = await tx.wait();
            redemption.status = 'redeemed';
            redemption.txHash = receipt.transactionHash;
            redemption.redeemedAt = new Date().toISOString();
            redemptionHistory.push({ ...redemption });
            redeemed = true;

            logger.addActivity('redeem_success', {
              message: `Redeemed via ${attempt.label}! TX: ${receipt.transactionHash.substring(0, 20)}... | ${redemption.question || 'BTC trade'}`
            });
          } catch (err) {
            const errMsg = err.message || String(err);
            lastError = errMsg;

            logger.addActivity('redeemer', {
              message: `${attempt.label} failed: ${errMsg.substring(0, 60)}... trying next`
            });
          }
        }

        if (!redeemed) {
          const errMsg = lastError || 'Both NegRiskAdapter and CTF failed';
          if (errMsg.includes('payout is zero') || errMsg.includes('result is empty')) {
            redemption.status = 'no_payout';
            redemption.redeemedAt = new Date().toISOString();
            redemptionHistory.push({ ...redemption });
            logger.addActivity('redeemer', {
              message: `No payout (lost): ${redemption.question || 'BTC trade'}`
            });
          } else {
            redemption.status = 'error';
            redemption.error = errMsg.substring(0, 100);
            redemption.redeemedAt = new Date().toISOString();
            redemptionHistory.push({ ...redemption });
            logger.addActivity('redeemer_error', {
              message: `Redeem failed (both contracts tried): ${errMsg.substring(0, 80)}`
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
      r.status === 'redeemed' || r.status === 'no_payout' || r.status === 'error'
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
    safeAddress: safeAddress ? `${safeAddress.substring(0, 10)}...` : null,
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
