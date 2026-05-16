const { ethers } = require('ethers');
const axios      = require('axios');
const logger     = require('./logger');
const trader     = require('./trader');

const CTF_ADDRESS          = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PUSD_ADDRESS         = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_ADDRESS         = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SAFE_FACTORY_ADDRESS = '0xaacfeea03eb1561c4e67d661e40682bd20e3541b';
const WCOL_ADDRESS         = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2';

const RELAYER_BASE = 'https://relayer-v2.polymarket.com';

const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com'
];

const COLLATERALS = [
  { addr: PUSD_ADDRESS, label: 'pUSD'   },
  { addr: USDC_ADDRESS, label: 'USDC.e' },
  { addr: WCOL_ADDRESS, label: 'wcol'   }
];

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)'
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
const KNOWN_COLLATERALS       = new Set([PUSD_ADDRESS.toLowerCase(), USDC_ADDRESS.toLowerCase(), WCOL_ADDRESS.toLowerCase()]);

const pendingRedemptions   = [];
const redemptionHistory    = [];
const redeemedConditionIds = new Set();
let   safeAddress          = null;
let   isChecking           = false;

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

// ─── Build Safe signature (shared by Relayer + direct Safe paths) ─────────────

async function buildSafeSignature(wallet, safeContract, conditionId, col) {
  const iface    = new ethers.utils.Interface(CTF_ABI);
  const nonce    = await safeContract.nonce();
  const data     = iface.encodeFunctionData('redeemPositions', [
    col.addr, ethers.constants.HashZero, conditionId, [1, 2]
  ]);

  const txHash = await safeContract.getTransactionHash(
    CTF_ADDRESS, 0, data, 0, 0, 0, 0,
    ethers.constants.AddressZero, ethers.constants.AddressZero, nonce
  );

  const rawSig   = await wallet.signMessage(ethers.utils.arrayify(txHash));
  const sigBytes = ethers.utils.arrayify(rawSig);
  let v = sigBytes[64];
  if (v < 27) v += 27;
  v += 4;
  sigBytes[64] = v;

  return { data, nonce: nonce.toString(), signature: ethers.utils.hexlify(sigBytes) };
}

// ─── Find which collateral the market uses + which wallet holds the tokens ─────
//
// Strategy:
//  1. Check payoutDenominator > 0 (market must be resolved on-chain).
//  2. Compute the indexSet=1 position token ID for each collateral and check
//     the actual ERC-1155 balance in EOA and Safe.  Whichever collateral has a
//     real balance wins — this avoids the callStatic false-positive problem where
//     ALL collaterals pass once the market is resolved, causing us to pick the
//     wrong one (e.g. pUSD when the tokens are actually USDC.e).
//  3. If no balance is found but the market IS resolved (den > 0), tokens are
//     already redeemed — return sentinel to clear the queue entry.
//
// Redemption path classification (logged explicitly on every redeem):
//
//   pusd_ctf_direct   — post-V2 market backed by pUSD collateral.
//                       CTF.redeemPositions(pUSD, ...) is called.
//                       Output: pUSD arrives in holder wallet automatically.
//                       No manual wrap needed.
//
//   legacy_ctf_direct — pre-V2 market backed by USDC.e collateral.
//                       CTF.redeemPositions(USDC.e, ...) is called.
//                       Output: USDC.e arrives in holder wallet.
//                       Manual wrap to pUSD required on polymarket.com.
//
//   wcol_ctf_direct   — wrapped-collateral market (rare). Same CTF call,
//                       wcol arrives in holder wallet.
//
// NOTE: There is no separate "pUSD adapter contract" to call. The CTF itself
// acts as the adapter — CTF.redeemPositions with pUSD as the collateral arg
// burns the ERC-1155 position tokens and returns pUSD directly to the caller.
// The pUSD adapter described in Polymarket docs IS this CTF call with pUSD.

function classifyRedemptionPath(colLabel) {
  if (colLabel === 'pUSD')   return 'pusd_ctf_direct';
  if (colLabel === 'USDC.e') return 'legacy_ctf_direct';
  return 'wcol_ctf_direct';
}

async function findResolvedCollateral(provider, conditionId, eoaAddr, safAddr) {
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

  // Gate 1: market must be resolved on-chain
  try {
    const den = await ctf.payoutDenominator(conditionId);
    if (den.eq(0)) {
      logger.addActivity('redeemer', { message: `payoutDenominator=0 — not resolved yet | conditionId=${conditionId.slice(0, 18)}…` });
      return null;
    }
    logger.addActivity('redeemer', { message: `payoutDenominator=${den.toString()} ✓ — market resolved on-chain | conditionId=${conditionId.slice(0, 18)}…` });
  } catch (err) {
    logger.addActivity('redeemer', { message: `payoutDenominator error: ${(err.message || '').slice(0, 60)}` });
    return null;
  }

  // Gate 2: find the collateral with an actual token balance
  // Checks pUSD first — if a post-V2 market, pUSD balance is found here and
  // the redemption path is automatically pusd_ctf_direct (no manual wrap).
  const wallets = [eoaAddr, safAddr].filter(Boolean);
  try {
    const col1 = await ctf.getCollectionId(ethers.constants.HashZero, conditionId, 1);

    for (const col of COLLATERALS) {
      const posId = await ctf.getPositionId(col.addr, col1);
      for (const w of wallets) {
        const bal = await ctf.balanceOf(w, posId);
        if (bal.gt(0)) {
          const redemptionPath = classifyRedemptionPath(col.label);
          const tokenOut       = col.label;   // token received after CTF.redeemPositions
          const holderType     = (eoaAddr && w.toLowerCase() === eoaAddr.toLowerCase()) ? 'EOA' : 'Safe';
          logger.addActivity('redeemer', {
            message: [
              `[DETECT] conditionId=${conditionId.slice(0, 18)}…`,
              `positionId=${posId.toString().slice(0, 18)}…`,
              `collateral=${col.label} (${col.addr.slice(0, 10)}…)`,
              `balance=${ethers.utils.formatUnits(bal, 6)}`,
              `holder=${holderType}(${w.slice(0, 10)}…)`,
              `path=${redemptionPath}`,
              `token_out=${tokenOut}`,
              tokenOut === 'pUSD'   ? '→ pUSD returned automatically (no wrap needed)' :
              tokenOut === 'USDC.e' ? '→ USDC.e returned — manual wrap to pUSD needed on polymarket.com' :
                                     '→ wcol returned'
            ].join(' | ')
          });
          return { ...col, holderWallet: w, positionId: posId.toString(), redemptionPath, tokenOut };
        }
      }
    }
  } catch (err) {
    logger.addActivity('redeemer', { message: `Balance check error: ${(err.message || '').slice(0, 60)}` });
  }

  // Gate 3: market resolved but no balance found — tokens already redeemed.
  logger.addActivity('redeemer', { message: `Market resolved on-chain but no tokens found in any wallet — already redeemed | conditionId=${conditionId.slice(0, 18)}…` });
  return { alreadyRedeemed: true };
}

// ─── Relayer redemption (gasless, primary path) ───────────────────────────────

async function redeemViaRelayer(wallet, conditionId, col, safAddr, provider) {
  const relayerKey     = process.env.RELAYER_API_KEY;
  const relayerAddress = process.env.RELAYER_API_KEY_ADDRESS || wallet.address;

  if (!relayerKey) return null;
  if (!safAddr)    return null;

  try {
    const safeContract = new ethers.Contract(safAddr, SAFE_ABI, provider);
    const { data, nonce, signature } = await buildSafeSignature(wallet, safeContract, conditionId, col);

    const body = {
      from:        wallet.address,
      to:          CTF_ADDRESS,
      proxyWallet: safAddr,
      data,
      nonce,
      signature,
      signatureParams: {
        gasPrice:       '0',
        operation:      '0',
        safeTxnGas:     '0',
        baseGas:        '0',
        gasToken:       ethers.constants.AddressZero,
        refundReceiver: ethers.constants.AddressZero
      },
      type: 'SAFE'
    };

    logger.addActivity('redeemer', { message: `Relayer: submitting CTF + ${col.label} (gasless)...` });

    const submitRes = await axios.post(`${RELAYER_BASE}/submit`, body, {
      headers: {
        'RELAYER_API_KEY':         relayerKey,
        'RELAYER_API_KEY_ADDRESS': relayerAddress,
        'Content-Type':            'application/json'
      },
      timeout: 30000
    });

    const { transactionID, state } = submitRes.data || {};
    if (!transactionID) {
      logger.addActivity('redeemer', { message: `Relayer submit returned no transactionID: ${JSON.stringify(submitRes.data).slice(0, 100)}` });
      return null;
    }

    logger.addActivity('redeemer', { message: `Relayer accepted txID=${transactionID} state=${state} — polling for hash...` });

    // Poll for tx hash (up to 3 minutes)
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 8000));
      try {
        const pollRes = await axios.get(`${RELAYER_BASE}/transaction`, {
          params:  { id: transactionID },
          headers: {
            'RELAYER_API_KEY':         relayerKey,
            'RELAYER_API_KEY_ADDRESS': relayerAddress
          },
          timeout: 10000
        });
        const tx = pollRes.data || {};
        logger.addActivity('redeemer', { message: `Relayer poll: state=${tx.state} hash=${tx.transactionHash || 'pending'}` });

        if (tx.transactionHash) {
          const receipt = await provider.waitForTransaction(tx.transactionHash, 1, 60000);
          if (verifyRedemptionReceipt(receipt, safAddr)) {
            return { success: true, via: 'Relayer', txHash: tx.transactionHash };
          }
          logger.addActivity('redeemer', { message: `Relayer tx mined but no ${col.label} Transfer in receipt` });
          return { success: false };
        }

        if (tx.state === 'STATE_FAILED' || tx.state === 'FAILED') {
          logger.addActivity('redeemer', { message: `Relayer tx failed: ${JSON.stringify(tx).slice(0, 100)}` });
          return { success: false };
        }
      } catch (pollErr) {
        logger.addActivity('redeemer', { message: `Relayer poll error: ${pollErr.message?.slice(0, 60)}` });
      }
    }

    logger.addActivity('redeemer', { message: `Relayer polling timed out for txID=${transactionID}` });
    return { success: false };

  } catch (err) {
    const msg = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 120)
      : (err.message || '').slice(0, 100);
    logger.addActivity('redeemer', { message: `Relayer submit error: ${msg}` });
    return null;
  }
}

// ─── EOA redemption (fallback 1) ─────────────────────────────────────────────

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

// ─── Safe redemption (fallback 2) ────────────────────────────────────────────

async function redeemViaSafe(wallet, conditionId, col, safAddr, provider) {
  const safeContract = new ethers.Contract(safAddr, SAFE_ABI, wallet);
  const gasPrice     = await provider.getGasPrice();
  const { data, signature } = await buildSafeSignature(wallet, safeContract, conditionId, col);

  logger.addActivity('redeemer', { message: `Safe: submitting CTF + ${col.label}...` });
  const tx = await safeContract.execTransaction(
    CTF_ADDRESS, 0, data, 0, 0, 0, 0,
    ethers.constants.AddressZero, ethers.constants.AddressZero, signature,
    { gasPrice: gasPrice.mul(2), gasLimit: 500000 }
  );
  return tx;
}

// ─── Core redemption: route by token holder ───────────────────────────────────
//
// col.holderWallet tells us where the ERC-1155 tokens actually live.
// col.redemptionPath is set by findResolvedCollateral():
//   'pusd_ctf_direct'   → post-V2 market, pUSD returned automatically
//   'legacy_ctf_direct' → pre-V2 market, USDC.e returned (manual wrap needed)
//   'wcol_ctf_direct'   → wcol market (rare)
//
// Routing by holder:
//   Tokens on EOA  → EOA direct (needs MATIC gas)
//   Tokens on Safe → Relayer (gasless) → Safe direct (needs MATIC gas)
//
// The CTF.redeemPositions call is identical for all paths — the collateral
// address argument (col.addr) determines what token comes back.

async function attemptRedeem(wallet, conditionId, col, safAddr, provider) {
  const holderWallet    = col.holderWallet || null;
  const redemptionPath  = col.redemptionPath || classifyRedemptionPath(col.label);
  const tokenOut        = col.tokenOut || col.label;
  const positionId      = col.positionId || 'unknown';
  const isEOA  = holderWallet && holderWallet.toLowerCase() === wallet.address.toLowerCase();
  const isSafe = holderWallet && safAddr && holderWallet.toLowerCase() === safAddr.toLowerCase();
  const holderType = isEOA ? 'EOA' : isSafe ? 'Safe' : 'unknown';

  // ── Entry diagnostic — logged before every redemption attempt ───────────────
  logger.addActivity('redeemer', {
    message: [
      `[REDEEM-START] conditionId=${conditionId.slice(0, 18)}…`,
      `positionId=${positionId.slice(0, 18)}…`,
      `collateral=${col.label}`,
      `holder=${holderType}(${(holderWallet || 'none').slice(0, 10)}…)`,
      `path=${redemptionPath}`,
      `contract=CTF(${CTF_ADDRESS.slice(0, 10)}…)`,
      `function=redeemPositions(${col.label}, HashZero, conditionId, [1,2])`,
      `token_expected_out=${tokenOut}`,
      tokenOut === 'pUSD'
        ? '→ pUSD will arrive in wallet automatically'
        : tokenOut === 'USDC.e'
        ? '→ USDC.e will arrive in wallet — manual wrap to pUSD needed'
        : `→ ${tokenOut} will arrive in wallet`
    ].join(' | ')
  });

  // ── Tokens on EOA: redeem directly ──────────────────────────────────────────
  if (isEOA) {
    logger.addActivity('redeemer', { message: `[REDEEM] EOA direct | calling CTF.redeemPositions(${col.label}, ...)` });
    try {
      const tx      = await redeemViaEOA(wallet, conditionId, col, provider);
      const receipt = await tx.wait();
      if (verifyRedemptionReceipt(receipt, null)) {
        logger.addActivity('redeemer', {
          message: `[REDEEM-SUCCESS] via=EOA | path=${redemptionPath} | token_received=${tokenOut} | txHash=${receipt.transactionHash.slice(0, 20)}…`
        });
        return { success: true, via: 'EOA', txHash: receipt.transactionHash, redemptionPath, tokenOut };
      }
      logger.addActivity('redeemer', { message: `[REDEEM] EOA tx mined but no ${col.label} Transfer in receipt` });
    } catch (err) {
      logger.addActivity('redeemer', {
        message: `[REDEEM] EOA tx failed: ${(err.reason || err.message || '').slice(0, 80)}`
      });
    }
    return { success: false, redemptionPath, tokenOut };
  }

  // ── Tokens on Safe: Relayer → Safe direct ───────────────────────────────────
  if (isSafe || !holderWallet) {
    // 1. Relayer (gasless, primary)
    const relayerResult = await redeemViaRelayer(wallet, conditionId, col, safAddr, provider);
    if (relayerResult !== null) {
      if (relayerResult.success) {
        logger.addActivity('redeemer', {
          message: `[REDEEM-SUCCESS] via=Relayer | path=${redemptionPath} | token_received=${tokenOut} | txHash=${relayerResult.txHash?.slice(0, 20)}…`
        });
        return { ...relayerResult, redemptionPath, tokenOut };
      }
      logger.addActivity('redeemer', { message: `[REDEEM] Relayer path failed — trying Safe direct...` });
    } else if (process.env.RELAYER_API_KEY) {
      logger.addActivity('redeemer', { message: `[REDEEM] Relayer submit returned null — trying Safe direct...` });
    }

    // 2. Safe direct
    if (!safAddr) {
      logger.addActivity('redeemer_error', {
        message: `[REDEEM] No proxy wallet — set PROXY_WALLET_ADDRESS in .env`
      });
      return { success: false, redemptionPath, tokenOut };
    }
    try {
      const tx      = await redeemViaSafe(wallet, conditionId, col, safAddr, provider);
      const receipt = await tx.wait();
      if (verifyRedemptionReceipt(receipt, safAddr)) {
        logger.addActivity('redeemer', {
          message: `[REDEEM-SUCCESS] via=Safe | path=${redemptionPath} | token_received=${tokenOut} | txHash=${receipt.transactionHash.slice(0, 20)}…`
        });
        return { success: true, via: 'Safe', txHash: receipt.transactionHash, redemptionPath, tokenOut };
      }
      logger.addActivity('redeemer', { message: `[REDEEM] Safe tx mined but no ${col.label} Transfer — may already be redeemed` });
    } catch (err) {
      logger.addActivity('redeemer', {
        message: `[REDEEM] Safe tx failed: ${(err.reason || err.message || '').slice(0, 80)}`
      });
    }
  }

  return { success: false, redemptionPath, tokenOut };
}

// ─── Pending redemption queue ─────────────────────────────────────────────────

function addPendingRedemption(trade) {
  if (!trade || (!trade.conditionId && !trade.tokenId)) {
    logger.addActivity('redeemer', { message: 'Cannot track trade: missing conditionId and tokenId' });
    return;
  }

  // Never re-add a position we've already confirmed as redeemed on-chain.
  if (trade.conditionId && redeemedConditionIds.has(trade.conditionId)) return;

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
    const eoaAddr  = wallet.address;
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

        const col = await findResolvedCollateral(provider, conditionId, eoaAddr, safAddr);
        if (!col) {
          logger.addActivity('redeemer', { message: `"${label}": not yet resolved — will retry` });
          continue;
        }

        if (col.alreadyRedeemed) {
          redemption.status     = 'redeemed';
          redemption.redeemedAt = new Date().toISOString();
          redemptionHistory.push({ ...redemption });
          if (redemption.conditionId) redeemedConditionIds.add(redemption.conditionId);
          logger.addActivity('redeem_success', { message: `Already redeemed on-chain — cleared from queue: "${label}"` });
          continue;
        }

        redemption.status = 'redeeming';
        const result = await attemptRedeem(wallet, conditionId, col, safAddr, provider);

        if (result.success) {
          redemption.status     = 'redeemed';
          redemption.txHash     = result.txHash;
          redemption.redeemedAt = new Date().toISOString();
          redemptionHistory.push({ ...redemption });
          if (redemption.conditionId) redeemedConditionIds.add(redemption.conditionId);

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
            redemption.error  = 'All paths (Relayer, EOA, Safe) returned no Transfer after 2h';
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
    const eoaAddr  = wallet.address;
    const safAddr  = await getProxyWalletAddress();

    const condId = formatConditionId(conditionId);
    if (!condId) {
      logger.addActivity('redeemer_error', { message: `Invalid conditionId for "${label}"` });
      return false;
    }

    const col = await findResolvedCollateral(provider, condId, eoaAddr, safAddr);
    if (!col) {
      logger.addActivity('redeemer', { message: `"${label}": not yet resolved — will retry` });
      return false;
    }

    if (col.alreadyRedeemed) {
      if (conditionId) redeemedConditionIds.add(conditionId);
      redemptionHistory.push({ question, conditionId, tokenId, status: 'redeemed', redeemedAt: new Date().toISOString() });
      logger.addActivity('redeem_success', { message: `Already redeemed on-chain — cleared: "${label}"` });
      return true;
    }

    const result = await attemptRedeem(wallet, condId, col, safAddr, provider);

    if (result.success) {
      if (conditionId) redeemedConditionIds.add(conditionId);
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
      message: `All paths (Relayer, EOA, Safe) returned no Transfer for "${label}" — will retry next tick`
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
      conditionId:   r.conditionId ? r.conditionId.slice(0, 18) + '...' : null,
      retryCount:    r.retryCount  || 0,
      error:         r.error       || null,
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

// ─── At-entry collateral detection (no resolution required) ──────────────────
//
// Call this at the moment the bot ENTERS a market, before any order is placed.
// Compares the CLOB YES tokenId against the computed CTF position token IDs for
// each known collateral (pUSD, USDC.e, wcol). No market resolution needed —
// just on-chain math. Returns 'pUSD' | 'USDC.e' | 'wCOL' | 'UNKNOWN'.
//
// This is the definitive source of truth: if the YES tokenId matches the pUSD
// position token, the market is post-V2 pUSD-backed and will redeem to pUSD
// automatically. If it matches USDC.e, a manual wrap is needed after redemption.

async function detectMarketCollateral(conditionId, yesTokenId) {
  if (!conditionId || !yesTokenId) return 'UNKNOWN';

  const condId = formatConditionId(conditionId);
  if (!condId) return 'UNKNOWN';

  try {
    const provider = await getWorkingProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const col1 = await ctf.getCollectionId(ethers.constants.HashZero, condId, 1);

    const yes = yesTokenId.toString();
    for (const col of COLLATERALS) {
      const posId = await ctf.getPositionId(col.addr, col1);
      if (posId.toString() === yes) return col.label;
    }
    return 'UNKNOWN';
  } catch (err) {
    return 'UNKNOWN';
  }
}

module.exports = {
  addPendingRedemption,
  checkAndRedeem,
  redeemPosition,
  getRedemptionStatus,
  detectMarketCollateral
};
