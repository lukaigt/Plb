const { ethers } = require('ethers');

const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const SAFE = '0x94eAb3d7352aEb36A7378bc635b97E2968112e7E';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)'
];
const NEG_RISK_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function wcol() view returns (address)'
];
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)'
];

async function test() {
  const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);
  const adapter = new ethers.Contract(NEG_RISK, NEG_RISK_ABI, provider);
  const safe = new ethers.Contract(SAFE, SAFE_ABI, provider);

  console.log('=== REDEMPTION DRY RUN TEST ===\n');

  // Step 1: Check Safe wallet
  console.log('1. Checking Safe wallet...');
  try {
    const owners = await safe.getOwners();
    const threshold = await safe.getThreshold();
    console.log('   Safe owners:', owners);
    console.log('   Threshold:', threshold.toString());
    console.log('   PASS\n');
  } catch(e) { console.log('   FAIL:', e.message.substring(0, 80), '\n'); }

  // Step 2: Get wrapped collateral
  console.log('2. Fetching wrapped collateral from NegRiskAdapter...');
  let wcol;
  try {
    wcol = await adapter.wcol();
    console.log('   Wrapped collateral:', wcol);
    console.log('   PASS\n');
  } catch(e) { console.log('   FAIL:', e.message.substring(0, 80), '\n'); return; }

  // Step 3: Find a recent resolved BTC market
  console.log('3. Finding recent resolved BTC 15-min market...');
  let testConditionId = null;
  let testTokenId = null;
  let testMarketName = null;
  
  const now = Math.floor(Date.now() / 1000);
  for (let i = 3; i <= 20; i++) {
    const ts = now - (now % 900) - (i * 900);
    const slug = `btc-updown-15m-${ts}`;
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const events = await res.json();
      if (events && events.length > 0 && events[0].markets && events[0].markets.length > 0) {
        const market = events[0].markets[0];
        if (market.conditionId) {
          testConditionId = market.conditionId;
          testMarketName = market.question || events[0].title;
          const tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
          if (tokenIds && tokenIds.length > 0) testTokenId = tokenIds[0];
          console.log('   Found:', testMarketName);
          console.log('   ConditionId:', testConditionId.substring(0, 20) + '...');
          break;
        }
      }
    } catch(e) {}
  }
  
  if (!testConditionId) {
    console.log('   Could not find a recent market to test with\n');
    return;
  }

  // Step 4: Check payout denominator
  console.log('\n4. Checking if market is resolved on-chain...');
  try {
    const pd = await ctf.payoutDenominator(testConditionId);
    console.log('   payoutDenominator:', pd.toString());
    console.log('   Resolved:', pd.gt(0) ? 'YES' : 'NO');
    console.log('   PASS\n');
  } catch(e) { console.log('   FAIL:', e.message.substring(0, 80), '\n'); }

  // Step 5: Check token balance
  if (testTokenId) {
    console.log('5. Checking token balance on Safe wallet...');
    try {
      const bal = await ctf.balanceOf(SAFE, testTokenId);
      console.log('   Token balance:', ethers.utils.formatUnits(bal, 6), 'shares');
      console.log('   Has balance:', bal.gt(0) ? 'YES' : 'NO (already redeemed or lost)');
      console.log('   PASS\n');
    } catch(e) { console.log('   FAIL:', e.message.substring(0, 80), '\n'); }
  }

  // Step 6: Simulate NegRiskAdapter redeemPositions call
  console.log('6. Simulating NegRiskAdapter.redeemPositions (static call)...');
  try {
    const iface = new ethers.utils.Interface(NEG_RISK_ABI);
    const callData = iface.encodeFunctionData('redeemPositions', [
      wcol,
      ethers.constants.HashZero,
      testConditionId,
      [1, 2]
    ]);
    console.log('   Encoded call data OK (', callData.substring(0, 20), '...)');
    
    // Try estimateGas from Safe to NegRiskAdapter
    const gasEstimate = await provider.estimateGas({
      from: SAFE,
      to: NEG_RISK,
      data: callData
    });
    console.log('   Gas estimate:', gasEstimate.toString());
    console.log('   PASS - NegRiskAdapter call would SUCCEED!\n');
  } catch(e) {
    console.log('   Gas estimate failed:', e.message.substring(0, 100));
    console.log('   This is expected if Safe has no balance for this market or already redeemed\n');
  }

  // Step 7: Simulate CTF redeemPositions call
  console.log('7. Simulating CTF.redeemPositions (static call)...');
  try {
    const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const iface = new ethers.utils.Interface(CTF_ABI);
    const callData = iface.encodeFunctionData('redeemPositions', [
      USDC,
      ethers.constants.HashZero,
      testConditionId,
      [1, 2]
    ]);
    
    const gasEstimate = await provider.estimateGas({
      from: SAFE,
      to: CTF,
      data: callData
    });
    console.log('   Gas estimate:', gasEstimate.toString());
    console.log('   PASS - CTF call would SUCCEED!\n');
  } catch(e) {
    console.log('   Gas estimate failed:', e.message.substring(0, 100));
    console.log('   Expected for negRisk markets (must use NegRiskAdapter)\n');
  }

  console.log('=== TEST COMPLETE ===');
}

test().catch(e => console.error('Test error:', e.message));
