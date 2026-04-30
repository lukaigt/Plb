const { ethers } = require('ethers');
const logger = require('./logger');
const trader = require('./trader');

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PUSD_ADDRESS  = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // V2 collateral (pUSD)
const USDC_ADDRESS  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // V1 collateral (USDC.e, legacy)
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com'
];

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)'
];

// NegRiskAdapter has a 2-argument redeemPositions (confirmed in deployed bytecode):
//   redeemPositions(bytes32 conditionId, uint256[] amounts)
// where amounts[i] = how many tokens to redeem for outcome i (others = 0).
// This is DIFFERENT from CTF which takes (address, bytes32, bytes32, uint256[]).
const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
  'function wcol() view returns (address)',
  'function balanceOf(address account, uint256 id) view returns (uint256)'
];

// ERC-1155 operator approval — NegRiskAdapter pulls CTF tokens from the EOA
// via safeTransferFrom, so the EOA must have set this operator approval.
const ERC1155_APPROVAL_ABI = [
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)'
];

// Session cache + in-flight promise lock so concurrent callers (auto-redeem,
// bondStrategy, manual force-redeem) don't all submit duplicate approval txs.
let _negRiskApprovalVerified = false;
let _negRiskApprovalInFlight = null;

async function ensureNegRiskApproval(wallet, provider) {
  if (_negRiskApprovalVerified) return true;
  if (_negRiskApprovalInFlight) return _negRiskApprovalInFlight;

  _negRiskApprovalInFlight = (async () => {
    try {
      const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_APPROVAL_ABI, provider);
      const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
      if (isApproved) {
        logger.addActivity('redeemer', { message: 'CTF approval for NegRiskAdapter already set' });
        _negRiskApprovalVerified = true;
        return true;
      }
      logger.addActivity('redeemer', { message: 'Setting CTF setApprovalForAll(NegRiskAdapter, true) — required for redemption...' });
      const ctfWriter = new ethers.Contract(CTF_ADDRESS, ERC1155_APPROVAL_ABI, wallet);
      const gasPrice = await provider.getGasPrice();
      const tx = await ctfWriter.setApprovalForAll(NEG_RISK_ADAPTER, true, {
        gasPrice: gasPrice.mul(2),
        gasLimit: 100000
      });
      logger.addActivity('redeemer', { message: `Approval tx sent: ${tx.hash.slice(0, 18)}... waiting for confirmation` });
      const receipt = await tx.wait();
      if (receipt.status === 1) {
        logger.addActivity('redeemer', { message: `CTF approval confirmed on-chain (block ${receipt.blockNumber})` });
        _negRiskApprovalVerified = true;
        return true;
      }
      logger.addActivity('redeemer_error', { message: 'Approval tx mined but reverted (status=0)' });
      return false;
    } catch (err) {
      logger.addActivity('redeemer_error', { message: `ensureNegRiskApproval error: ${(err.message||'').slice(0,120)}` });
      return false;
    } finally {
      _negRiskApprovalInFlight = null;
    }
  })();

  return _negRiskApprovalInFlight;
}

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

function encodeRedeemCall(conditionId, negRisk, wrappedCollateral, amounts, collateral) {
  if (negRisk) {
    const iface = new ethers.utils.Interface(NEG_RISK_ABI);
    return iface.encodeFunctionData('redeemPositions', [
      conditionId,
      amounts || [1]
    ]);
  } else {
    // collateral defaults to pUSD (V2); fall back to USDC.e only for pre-V2 positions
    const collateralAddr = collateral || PUSD_ADDRESS;
    const iface = new ethers.utils.Interface(CTF_ABI);
    return iface.encodeFunctionData('redeemPositions', [
      collateralAddr,
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

// Extract the on-chain revert reason from an ethers v5 error object.
// Looks at multiple possible locations because providers nest the revert data differently.
function extractRevertReason(err) {
  if (!err) return 'unknown';
  // Direct reason string (some RPCs)
  if (err.reason && err.reason !== 'transaction failed' && err.reason.length < 200) {
    return err.reason;
  }
  // Standard Error(string) revert: 0x08c379a0 + abi-encoded string
  const dataCandidates = [
    err.data,
    err.error?.data,
    err.error?.error?.data,
    err.error?.error?.error?.data,
    err.error?.body,
  ].filter(Boolean);
  for (const d of dataCandidates) {
    if (typeof d === 'string') {
      // Try Error(string) selector
      if (d.startsWith('0x08c379a0')) {
        try {
          const decoded = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + d.slice(10));
          return `revert: ${decoded[0]}`;
        } catch {}
      }
      // Try Panic(uint256) selector
      if (d.startsWith('0x4e487b71')) {
        try {
          const code = ethers.utils.defaultAbiCoder.decode(['uint256'], '0x' + d.slice(10));
          return `panic(0x${code[0].toHexString().slice(2).padStart(2, '0')})`;
        } catch {}
      }
      // Try parsing JSON body (some RPCs return {jsonrpc:..., error:{message:"...execution reverted: REASON"}})
      if (d.startsWith('{')) {
        try {
          const parsed = JSON.parse(d);
          const msg = parsed?.error?.message || parsed?.message;
          if (msg) {
            const m = msg.match(/execution reverted:?\s*(.+?)(?:["}]|$)/i);
            if (m) return `revert: ${m[1].trim()}`;
            return msg.slice(0, 150);
          }
        } catch {}
      }
      // Bare hex revert data with no selector match
      if (d.startsWith('0x') && d.length > 2 && d.length <= 200) {
        return `revert data: ${d.slice(0, 80)}`;
      }
    }
  }
  // Fallback: parse "execution reverted" out of the message
  const msg = err.message || String(err);
  const m = msg.match(/execution reverted:?\s*([^"]+?)(?:["\\]|$)/i);
  if (m) return `revert: ${m[1].trim().slice(0, 150)}`;
  if (err.code) return `${err.code} (no reason returned)`;
  return msg.slice(0, 150);
}

// Run a callStatic simulation to capture the revert reason BEFORE wasting gas.
// Returns { ok: true } on success, or { ok: false, reason: '...' } on revert.
async function simulateCall(contract, methodName, args) {
  try {
    await contract.callStatic[methodName](...args);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: extractRevertReason(err) };
  }
}

async function redeemViaEOA(wallet, conditionId, negRisk, provider, wrappedCollateral, tokenId) {
  const gasPrice = await provider.getGasPrice();

  if (negRisk) {
    // NegRiskAdapter.redeemPositions (confirmed 2-arg interface in deployed bytecode):
    //   redeemPositions(bytes32 conditionId, uint256[] amounts)
    // amounts[outcomeIndex] = token balance to redeem; all others = 0.
    // The adapter pulls CTF tokens from msg.sender via safeTransferFrom (needs approval)
    // and pays out in wcol (wrapped collateral).
    const contract = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
    const ctf     = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

    // Check on-chain resolution FIRST — payoutDenominator = 0 means oracle hasn't
    // pushed results yet. Skip (no gas wasted) and let retry handle it.
    const denominator = await ctf.payoutDenominator(conditionId);
    if (denominator.eq(0)) {
      logger.addActivity('redeemer', {
        message: `NegRisk market not yet resolved on-chain (payoutDenominator=0) — will retry`
      });
      throw new Error('Market not yet resolved on-chain — retry later');
    }
    logger.addActivity('redeemer', {
      message: `NegRisk market resolved on-chain (payoutDenominator=${denominator.toString()}) — proceeding`
    });

    let ctfBal = ethers.BigNumber.from(0);
    let adapterBal = ethers.BigNumber.from(0);
    if (tokenId) {
      ctfBal     = await ctf.balanceOf(wallet.address, tokenId);
      adapterBal = await contract.balanceOf(wallet.address, tokenId);
    }
    const balance = ctfBal.gt(0) ? ctfBal : adapterBal;

    if (balance.eq(0)) {
      throw new Error('No token balance for NegRiskAdapter redemption (checked CTF + adapter)');
    }

    // ERC-1155 operator approval — adapter pulls tokens via CTF.safeTransferFrom
    const approved = await ensureNegRiskApproval(wallet, provider);
    if (!approved) {
      throw new Error('CTF setApprovalForAll(NegRiskAdapter) failed — cannot redeem');
    }

    // Build amounts array: try lookupOutcomeIndex first, fall back to [balance, 0] (YES=index 0)
    let outcomeInfo = await lookupOutcomeIndex(conditionId, tokenId);
    let amounts;
    if (outcomeInfo) {
      amounts = new Array(outcomeInfo.total).fill(ethers.BigNumber.from(0));
      amounts[outcomeInfo.index] = balance;
      logger.addActivity('redeemer', {
        message: `NegRisk: redeeming ${ethers.utils.formatUnits(balance, 6)} tokens at outcome ${outcomeInfo.index}/${outcomeInfo.total} | approval: true`
      });
    } else {
      amounts = [balance, ethers.BigNumber.from(0)];
      logger.addActivity('redeemer', {
        message: `NegRisk: redeeming ${ethers.utils.formatUnits(balance, 6)} tokens at outcome 0 (default YES) | approval: true`
      });
    }

    // Pre-flight simulation to catch any revert before wasting gas
    const sim = await simulateCall(contract, 'redeemPositions', [conditionId, amounts]);
    if (!sim.ok) {
      logger.addActivity('redeemer_error', {
        message: `NegRiskAdapter would revert. Reason: ${sim.reason}`
      });
      throw new Error(`NegRiskAdapter revert: ${sim.reason}`);
    }

    logger.addActivity('redeemer', {
      message: `NegRiskAdapter simulation OK — submitting...`
    });
    const tx = await contract.redeemPositions(
      conditionId,
      amounts,
      { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
    );

    return tx;
  } else {
    // Non-NegRisk: check on-chain resolution before attempting
    const ctfCheck = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const denominator = await ctfCheck.payoutDenominator(conditionId);
    if (denominator.eq(0)) {
      logger.addActivity('redeemer', {
        message: `CTF market not yet resolved on-chain (payoutDenominator=0) — will retry`
      });
      throw new Error('Market not yet resolved on-chain — retry later');
    }
    logger.addActivity('redeemer', {
      message: `CTF market resolved on-chain (payoutDenominator=${denominator.toString()}) — proceeding`
    });

    // Try pUSD first (V2 markets), then fall back to USDC.e (V1/legacy positions)
    const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const collaterals = [
      { addr: PUSD_ADDRESS, label: 'pUSD' },
      { addr: USDC_ADDRESS, label: 'USDC.e' }
    ];
    let lastErr;
    for (const col of collaterals) {
      try {
        logger.addActivity('redeemer', { message: `CTF redeem: trying ${col.label} as collateral...` });

        // Pre-flight simulation on this collateral
        const sim = await simulateCall(contract, 'redeemPositions', [
          col.addr, ethers.constants.HashZero, conditionId, [1, 2]
        ]);
        if (!sim.ok) {
          logger.addActivity('redeemer', { message: `CTF ${col.label} would revert: ${sim.reason} — trying next` });
          lastErr = new Error(`CTF ${col.label} revert: ${sim.reason}`);
          continue;
        }

        const tx = await contract.redeemPositions(
          col.addr,
          ethers.constants.HashZero,
          conditionId,
          [1, 2],
          { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
        );
        return tx;
      } catch (err) {
        lastErr = err;
        logger.addActivity('redeemer', { message: `CTF ${col.label} failed: ${(err.message||'').slice(0,60)} — trying next` });
      }
    }
    throw lastErr;
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

  if (negRisk) {
    const redeemData = encodeRedeemCall(conditionId, true, wrappedCollateral, amounts);
    return await signAndExecSafe(wallet, safeContract, targetAddress, redeemData, provider);
  }

  // Non-negRisk: try pUSD first (V2 markets), then USDC.e (V1/legacy)
  const collaterals = [
    { addr: PUSD_ADDRESS, label: 'pUSD' },
    { addr: USDC_ADDRESS, label: 'USDC.e' }
  ];
  let lastErr;
  for (const col of collaterals) {
    try {
      logger.addActivity('redeemer', { message: `Safe CTF redeem: trying ${col.label} as collateral...` });
      const redeemData = encodeRedeemCall(conditionId, false, wrappedCollateral, amounts, col.addr);
      const tx = await signAndExecSafe(wallet, safeContract, targetAddress, redeemData, provider);
      return tx;
    } catch (err) {
      lastErr = err;
      logger.addActivity('redeemer', { message: `Safe CTF ${col.label} failed: ${(err.message||'').slice(0,60)} — trying next` });
    }
  }
  throw lastErr;
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
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');
// Base set: pUSD (V2) and USDC.e (V1 legacy) emit ERC-20 Transfer on redemption.
// NegRiskAdapter pays out in wrapped collateral (wcol) — passed in dynamically.
const COLLATERAL_ADDRESSES = new Set([
  PUSD_ADDRESS.toLowerCase(),
  USDC_ADDRESS.toLowerCase()
]);

function verifyRedemptionReceipt(receipt, safAddr, wrappedCollateral) {
  if (receipt.status !== 1) return false;

  // Accept the dynamic NegRiskAdapter wcol address as a valid payout token too.
  const validPayoutTokens = new Set(COLLATERAL_ADDRESSES);
  if (wrappedCollateral) validPayoutTokens.add(wrappedCollateral.toLowerCase());

  let hasExecutionFailure = false;
  let hasCollateralTransfer = false;

  for (const log of receipt.logs) {
    // Safe-specific: inner call failure despite outer tx status=1
    if (safAddr && log.address.toLowerCase() === safAddr.toLowerCase()) {
      if (log.topics[0] === EXECUTION_FAILURE_TOPIC) hasExecutionFailure = true;
    }
    // Any ERC-20 Transfer from pUSD, USDC.e, OR wcol = payout actually moved
    if (validPayoutTokens.has(log.address.toLowerCase()) && log.topics[0] === TRANSFER_TOPIC) {
      hasCollateralTransfer = true;
    }
  }

  if (hasExecutionFailure) return false;

  // Require a payout transfer — if CTF/NegRisk was called on the wrong contract
  // or with zero balance, the tx still returns status=1 but no payout happens.
  return hasCollateralTransfer;
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

        // Skip payoutDenominator pre-check entirely — it returns 0 for ALL NegRisk markets
        // (most Polymarket soccer markets) even after resolution, causing silent false-negatives.
        // The on-chain redemption call itself reverts if the market is unresolved; that revert
        // is caught below and triggers a retry. Let the contract be the gate.
        const isNegRiskPosition = redemption.negRisk === true;

        // Check token balances on EOA and Safe
        const eoaHasBalance = await hasTokenBalance(ctf, wallet.address, redemption.tokenId);
        const safeHasBalance = safAddr ? await hasTokenBalance(ctf, safAddr, redemption.tokenId) : false;
        logger.addActivity('redeemer', {
          message: `Balance check "${(redemption.question || 'trade').slice(0, 40)}" | EOA: ${eoaHasBalance} | Safe: ${safeHasBalance} | negRisk: ${isNegRiskPosition}`
        });

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

            let receipt;
            try {
              receipt = await tx.wait();
            } catch (waitErr) {
              // tx mined but reverted (status=0). Re-simulate at mined block to get real reason.
              lastError = waitErr.message || String(waitErr);
              let revertReason = '(no revert data)';
              try {
                const txData = tx;
                const txReceipt = await provider.getTransactionReceipt(tx.hash).catch(() => null);
                if (txReceipt && txReceipt.blockNumber) {
                  const redeemContract = new ethers.Contract(
                    attempt.negRisk ? NEG_RISK_ADAPTER : CTF_ADDRESS,
                    attempt.negRisk ? NEG_RISK_ABI : CTF_ABI,
                    wallet
                  );
                  if (attempt.negRisk) {
                    await redeemContract.callStatic.redeemPositions(
                      wrappedCollateral, ethers.constants.HashZero, conditionId, [1, 2],
                      { blockTag: txReceipt.blockNumber }
                    );
                  }
                  revertReason = '(succeeded in replay — transient state issue)';
                } else {
                  revertReason = extractRevertReason(waitErr);
                }
              } catch (replayErr) {
                revertReason = extractRevertReason(replayErr);
              }
              logger.addActivity('redeemer_error', {
                message: `${attempt.label} tx reverted on-chain. Reason: ${revertReason}`
              });
              throw waitErr;
            }

            const internalSuccess = verifyRedemptionReceipt(receipt, redeemFromSafe ? safAddr : null, wrappedCollateral);

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
          redemption.retryCount = (redemption.retryCount || 0) + 1;
          const elapsedMs = Date.now() - new Date(redemption.addedAt || 0).getTime();
          const elapsedMin = Math.floor(elapsedMs / 60000);
          const elapsedHr  = (elapsedMs / 3600000).toFixed(1);
          // 48-hour window: Polymarket uses UMA protocol for on-chain resolution which can
          // take 24–72 hours after game end. Giving up at 2h meant we were quitting before
          // the oracle had even pushed results to the contract.
          if (elapsedMs > 48 * 60 * 60 * 1000) {
            redemption.status = 'error';
            redemption.error = errMsg.substring(0, 100);
            redemptionHistory.push({ ...redemption });
            logger.addActivity('redeemer_error', {
              message: `Redeem failed after 48 hours (${redemption.retryCount} attempts) — giving up: ${errMsg.substring(0, 60)}`
            });
          } else {
            redemption.status = 'waiting';
            logger.addActivity('redeemer_error', {
              message: `Redeem failed (attempt ${redemption.retryCount}, +${elapsedHr}h, will retry): ${errMsg.substring(0, 60)}`
            });
          }
        }
      } catch (err) {
        const elapsedMs = Date.now() - new Date(redemption.addedAt || 0).getTime();
        if (elapsedMs > 48 * 60 * 60 * 1000) {
          redemption.status = 'error';
          redemption.error = err.message?.substring(0, 100);
          redemptionHistory.push({ ...redemption });
        } else {
          redemption.status = 'waiting';
        }
        logger.addActivity('redeemer_error', {
          message: `Redeem check error (will retry): ${err.message?.substring(0, 80)}`
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

    // Skip payoutDenominator pre-check entirely — it returns 0 for ALL NegRisk markets
    // (most Polymarket soccer markets) even after resolution, causing silent false-negatives.
    // The on-chain redemption call itself reverts if the market is unresolved; that revert
    // is caught below and triggers a retry. Let the contract be the gate.

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

    logger.addActivity('redeemer', {
      message: `Balance check "${label}" | EOA(${wallet.address.slice(0,10)}…): ${eoaHas} | Safe(${safAddr ? safAddr.slice(0,10)+'…' : 'unknown'}): ${safeHas} | negRisk: ${negRisk}`
    });

    if (!eoaHas && !safeHas) {
      if (!safAddr) {
        logger.addActivity('redeemer_error', {
          message: `CRITICAL: Proxy wallet unknown — set PROXY_WALLET_ADDRESS in .env. EOA has no tokens for "${label}"`
        });
      } else {
        logger.addActivity('redeemer', { message: `No tokens on EOA or Safe for "${label}" — market may not yet be resolved on-chain, will retry` });
      }
      return false;
    }

    const redeemFromSafe = !eoaHas && safeHas;
    logger.addActivity('redeemer', {
      message: `Attempting redemption "${label}" from ${redeemFromSafe ? `Safe (${safAddr.slice(0,10)}…)` : `EOA (${wallet.address.slice(0,10)}…)`} — trying ${negRisk ? 'NegRisk then CTF' : 'CTF then NegRisk'}`
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

        // Verify a collateral transfer actually happened — a tx can return status=1
        // with zero payout if called on the wrong contract or with no token balance.
        const ok = verifyRedemptionReceipt(receipt, redeemFromSafe ? safAddr : null, wrappedCollateral);
        if (!ok) {
          // payoutDenominator > 0 (checked above) so the market IS resolved.
          // Zero payout means this outcome lost (bot holds losing tokens) or
          // a collateral mismatch. Log clearly and don't retry the same method.
          logger.addActivity('redeemer_error', {
            message: `${att.label} tx mined — 0 payout for "${label}". Market resolved but this outcome may have lost. TX: ${receipt.transactionHash.slice(0, 20)}…`
          });
          continue;
        }

        redemptionHistory.push({ question, conditionId, tokenId, status: 'redeemed', txHash: receipt.transactionHash, redeemedAt: new Date().toISOString() });
        logger.addActivity('redeem_success', {
          message: `COLLECTED via ${att.label} (${redeemFromSafe ? 'Safe' : 'EOA'})! TX: ${receipt.transactionHash.substring(0, 20)}… | "${label}"`
        });
        return true;
      } catch (err) {
        const msg = (err.message || '');
        // "not yet resolved" is expected — oracle hasn't pushed results yet
        if (msg.includes('not yet resolved')) {
          logger.addActivity('redeemer', { message: `"${label}": oracle not yet pushed on-chain — will keep retrying` });
          break; // no point trying other methods for same reason
        }
        logger.addActivity('redeemer', { message: `${att.label} failed for "${label}": ${msg.substring(0, 80)} — trying next` });
      }
    }

    logger.addActivity('redeemer_error', { message: `All redeem methods exhausted for "${label}" — will retry next tick` });
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
