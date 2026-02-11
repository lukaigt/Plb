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

const { setupProxy } = require('./src/proxy');
setupProxy();

const { ethers, Wallet, Contract } = require('ethers');

const POLYGON_RPC = 'https://polygon-rpc.com';
const CHAIN_ID = 137;

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)'
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
  const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
  const wallet = new Wallet(cleanKey, provider);

  console.log(`Wallet: ${wallet.address}`);

  const maticBalance = await provider.getBalance(wallet.address);
  console.log(`MATIC balance: ${ethers.utils.formatEther(maticBalance)}`);

  const usdc = new Contract(USDC_E, ERC20_ABI, wallet);
  const usdcBalance = await usdc.balanceOf(wallet.address);
  console.log(`USDC.e balance: ${ethers.utils.formatUnits(usdcBalance, 6)}`);

  if (parseFloat(ethers.utils.formatEther(maticBalance)) < 0.01) {
    console.error('\nERROR: You need MATIC for gas fees. Send at least 0.1 MATIC to your wallet.');
    process.exit(1);
  }

  const ctf = new Contract(CTF_CONTRACT, CTF_ABI, wallet);

  const currentAllowance = await usdc.allowance(wallet.address, EXCHANGE);
  const currentNegAllowance = await usdc.allowance(wallet.address, NEG_RISK_EXCHANGE);
  const ctfApproved = await ctf.isApprovedForAll(wallet.address, EXCHANGE);
  const ctfNegApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_EXCHANGE);
  const ctfAdapterApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);

  console.log(`\nCurrent allowances:`);
  console.log(`  USDC -> Exchange: ${currentAllowance.gt(0) ? 'APPROVED' : 'NOT APPROVED'}`);
  console.log(`  USDC -> NegRisk Exchange: ${currentNegAllowance.gt(0) ? 'APPROVED' : 'NOT APPROVED'}`);
  console.log(`  CTF -> Exchange: ${ctfApproved ? 'APPROVED' : 'NOT APPROVED'}`);
  console.log(`  CTF -> NegRisk Exchange: ${ctfNegApproved ? 'APPROVED' : 'NOT APPROVED'}`);
  console.log(`  CTF -> NegRisk Adapter: ${ctfAdapterApproved ? 'APPROVED' : 'NOT APPROVED'}`);

  const gasPrice = await provider.getGasPrice();
  const txOpts = { gasLimit: 100000, gasPrice: gasPrice.mul(2) };

  console.log('\nSetting approvals...\n');

  if (currentAllowance.lt(ethers.utils.parseUnits('1000000', 6))) {
    console.log('1/5 Approving USDC.e for Exchange...');
    const tx1 = await usdc.approve(EXCHANGE, MAX_UINT, txOpts);
    console.log(`   tx: ${tx1.hash}`);
    await tx1.wait();
    console.log('   DONE');
  } else {
    console.log('1/5 USDC.e -> Exchange: already approved');
  }

  if (currentNegAllowance.lt(ethers.utils.parseUnits('1000000', 6))) {
    console.log('2/5 Approving USDC.e for NegRisk Exchange...');
    const tx2 = await usdc.approve(NEG_RISK_EXCHANGE, MAX_UINT, txOpts);
    console.log(`   tx: ${tx2.hash}`);
    await tx2.wait();
    console.log('   DONE');
  } else {
    console.log('2/5 USDC.e -> NegRisk Exchange: already approved');
  }

  if (!ctfApproved) {
    console.log('3/5 Approving CTF for Exchange...');
    const tx3 = await ctf.setApprovalForAll(EXCHANGE, true, txOpts);
    console.log(`   tx: ${tx3.hash}`);
    await tx3.wait();
    console.log('   DONE');
  } else {
    console.log('3/5 CTF -> Exchange: already approved');
  }

  if (!ctfNegApproved) {
    console.log('4/5 Approving CTF for NegRisk Exchange...');
    const tx4 = await ctf.setApprovalForAll(NEG_RISK_EXCHANGE, true, txOpts);
    console.log(`   tx: ${tx4.hash}`);
    await tx4.wait();
    console.log('   DONE');
  } else {
    console.log('4/5 CTF -> NegRisk Exchange: already approved');
  }

  if (!ctfAdapterApproved) {
    console.log('5/5 Approving CTF for NegRisk Adapter...');
    const tx5 = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, txOpts);
    console.log(`   tx: ${tx5.hash}`);
    await tx5.wait();
    console.log('   DONE');
  } else {
    console.log('5/5 CTF -> NegRisk Adapter: already approved');
  }

  console.log('\n=== ALL ALLOWANCES SET ===');
  console.log('You can now trade on Polymarket via the CLOB API.');
  console.log('Restart the bot: pm2 restart polymarket-bot');
}

setAllowances().catch(err => {
  console.error('Failed:', err.message);
});
