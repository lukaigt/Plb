require('dotenv').config();

const _origStringify = JSON.stringify;
JSON.stringify = function(value, replacer, space) {
  const seen = new WeakSet();
  const safeReplacer = function(key, val) {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    if (replacer) return replacer.call(this, key, val);
    return val;
  };
  return _origStringify.call(JSON, value, safeReplacer, space);
};

// Do NOT call setupProxy() here — the global proxy agent would intercept
// ethers.js RPC calls too, and Polygon public RPCs reject proxy CONNECT
// tunnels, causing "could not detect network". The proxy is only needed
// for Polymarket's geo-blocked CLOB API, not Polygon RPC endpoints.

const { ethers, Wallet, Contract } = require('ethers');

const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com',
];

// ── V2 CONTRACTS (April 2026 migration) ───────────────────────────────────────
const PUSD            = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // pUSD (replaces USDC.e)
const CTF_CONTRACT    = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // unchanged
const EXCHANGE_V2     = '0xE111180000d2663C0091e4f400237545B87B996B'; // Exchange V2
const NEG_RISK_EX_V2  = '0xe2222d279d744050d28e00520010520000310F59'; // NegRisk Exchange V2
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'; // unchanged

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)'
];

const CTF_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)'
];

const MAX_UINT = ethers.constants.MaxUint256;

async function setAllowances() {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: WALLET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  // Try each RPC in order until one responds
  let provider = null;
  for (const rpcUrl of POLYGON_RPCS) {
    try {
      const p = new ethers.providers.JsonRpcProvider(rpcUrl);
      await p.getNetwork(); // throws if unreachable
      provider = p;
      console.log(`RPC: ${rpcUrl}`);
      break;
    } catch {
      console.log(`RPC failed, trying next: ${rpcUrl}`);
    }
  }
  if (!provider) {
    console.error('ERROR: All Polygon RPCs failed. Check internet/VPS connectivity.');
    process.exit(1);
  }

  const wallet = new Wallet(cleanKey, provider);

  console.log(`Wallet (EOA): ${wallet.address}`);

  const maticBalance = await provider.getBalance(wallet.address);
  console.log(`MATIC balance: ${ethers.utils.formatEther(maticBalance)}`);

  if (parseFloat(ethers.utils.formatEther(maticBalance)) < 0.005) {
    console.error('\nERROR: You need MATIC for gas fees. Send at least 0.1 MATIC to your wallet.');
    process.exit(1);
  }

  const pusd = new Contract(PUSD, ERC20_ABI, wallet);
  const ctf  = new Contract(CTF_CONTRACT, CTF_ABI, wallet);

  const pusdBalance = await pusd.balanceOf(wallet.address);
  console.log(`pUSD balance: ${ethers.utils.formatUnits(pusdBalance, 6)}\n`);

  // ── READ CURRENT STATE ──────────────────────────────────────────────────────
  const [
    pusdAllowEx,
    pusdAllowNeg,
    ctfEx,
    ctfNeg,
    ctfAdapter
  ] = await Promise.all([
    pusd.allowance(wallet.address, EXCHANGE_V2),
    pusd.allowance(wallet.address, NEG_RISK_EX_V2),
    ctf.isApprovedForAll(wallet.address, EXCHANGE_V2),
    ctf.isApprovedForAll(wallet.address, NEG_RISK_EX_V2),
    ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER)
  ]);

  console.log('Current approval state:');
  console.log(`  pUSD  -> Exchange V2        (0xE111…): ${pusdAllowEx.gt(0)  ? 'APPROVED' : 'NOT APPROVED'}`);
  console.log(`  pUSD  -> NegRisk Exchange V2 (0xe222…): ${pusdAllowNeg.gt(0) ? 'APPROVED' : 'NOT APPROVED'}`);
  console.log(`  CTF   -> Exchange V2        (0xE111…): ${ctfEx      ? 'APPROVED' : 'NOT APPROVED'}  ← required for SELL orders`);
  console.log(`  CTF   -> NegRisk Exchange V2 (0xe222…): ${ctfNeg     ? 'APPROVED' : 'NOT APPROVED'}  ← required for SELL orders (NegRisk)`);
  console.log(`  CTF   -> NegRisk Adapter    (0xd91E…): ${ctfAdapter  ? 'APPROVED' : 'NOT APPROVED'}  ← required for redemption`);

  const gasPrice = await provider.getGasPrice();
  const txOpts   = { gasLimit: 150000, gasPrice: gasPrice.mul(2) };

  console.log('\nSetting approvals...\n');

  // 1. pUSD → Exchange V2 (collateral for BUY orders)
  if (pusdAllowEx.lt(ethers.utils.parseUnits('1000000', 6))) {
    console.log('1/5 Approving pUSD for Exchange V2 (0xE111…)...');
    const tx = await pusd.approve(EXCHANGE_V2, MAX_UINT, txOpts);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
    console.log('    DONE');
  } else {
    console.log('1/5 pUSD -> Exchange V2: already approved');
  }

  // 2. pUSD → NegRisk Exchange V2 (collateral for BUY orders, NegRisk markets)
  if (pusdAllowNeg.lt(ethers.utils.parseUnits('1000000', 6))) {
    console.log('2/5 Approving pUSD for NegRisk Exchange V2 (0xe222…)...');
    const tx = await pusd.approve(NEG_RISK_EX_V2, MAX_UINT, txOpts);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
    console.log('    DONE');
  } else {
    console.log('2/5 pUSD -> NegRisk Exchange V2: already approved');
  }

  // 3. CTF → Exchange V2  ← THE KEY FIX FOR SELL ORDERS
  // Without this the exchange cannot pull conditional tokens from the EOA
  // when the bot places a FAK sell, resulting in "allowance: 0" rejection.
  if (!ctfEx) {
    console.log('3/5 Approving CTF for Exchange V2 (0xE111…) [REQUIRED FOR SELLS]...');
    const tx = await ctf.setApprovalForAll(EXCHANGE_V2, true, txOpts);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
    console.log('    DONE');
  } else {
    console.log('3/5 CTF -> Exchange V2: already approved');
  }

  // 4. CTF → NegRisk Exchange V2  ← REQUIRED FOR SELL ORDERS ON NEGRISK MARKETS
  if (!ctfNeg) {
    console.log('4/5 Approving CTF for NegRisk Exchange V2 (0xe222…) [REQUIRED FOR SELLS]...');
    const tx = await ctf.setApprovalForAll(NEG_RISK_EX_V2, true, txOpts);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
    console.log('    DONE');
  } else {
    console.log('4/5 CTF -> NegRisk Exchange V2: already approved');
  }

  // 5. CTF → NegRisk Adapter (redemption path — unchanged from V1)
  if (!ctfAdapter) {
    console.log('5/5 Approving CTF for NegRisk Adapter (0xd91E…) [REQUIRED FOR REDEMPTION]...');
    const tx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, txOpts);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
    console.log('    DONE');
  } else {
    console.log('5/5 CTF -> NegRisk Adapter: already approved');
  }

  // ── FINAL VERIFICATION ──────────────────────────────────────────────────────
  console.log('\n=== FINAL APPROVAL STATE ===');
  const [fa1, fa2, fa3, fa4, fa5] = await Promise.all([
    pusd.allowance(wallet.address, EXCHANGE_V2),
    pusd.allowance(wallet.address, NEG_RISK_EX_V2),
    ctf.isApprovedForAll(wallet.address, EXCHANGE_V2),
    ctf.isApprovedForAll(wallet.address, NEG_RISK_EX_V2),
    ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER)
  ]);
  console.log(`  pUSD  -> Exchange V2        (0xE111…): ${fa1.gt(0) ? 'APPROVED ✓' : 'FAILED ✗'}`);
  console.log(`  pUSD  -> NegRisk Exchange V2 (0xe222…): ${fa2.gt(0) ? 'APPROVED ✓' : 'FAILED ✗'}`);
  console.log(`  CTF   -> Exchange V2        (0xE111…): ${fa3        ? 'APPROVED ✓' : 'FAILED ✗'}`);
  console.log(`  CTF   -> NegRisk Exchange V2 (0xe222…): ${fa4        ? 'APPROVED ✓' : 'FAILED ✗'}`);
  console.log(`  CTF   -> NegRisk Adapter    (0xd91E…): ${fa5        ? 'APPROVED ✓' : 'FAILED ✗'}`);

  const allOk = fa1.gt(0) && fa2.gt(0) && fa3 && fa4 && fa5;
  if (allOk) {
    console.log('\nAll approvals confirmed. Run: pm2 restart polymarket-bot');
  } else {
    console.log('\nWARNING: One or more approvals failed. Check RPC or MATIC balance and retry.');
    process.exit(1);
  }
}

setAllowances().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
