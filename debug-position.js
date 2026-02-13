require('dotenv').config();
const { ethers } = require('ethers');

const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const SAFE = '0x94eAb3d7352aEb36A7378bc635b97E2968112e7E';
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)'
];

const WINNING_POSITIONS = [
  {
    name: 'BTC Feb 13, 6:45-7:00AM',
    value: 4.48,
    dataApiConditionId: '0x922f1c67adc10beb2e67ec4c3b4e32f5ce8e3cbbc8f19d3437b78dc0a02ff0e6',
    tokenId: '12266552356322777655809949261698774888028831923752093728486532301723800534425',
    slug: 'btc-updown-15m-'
  }
];

async function findGammaConditionId(slug, name) {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 1; i <= 30; i++) {
    const ts = now - (now % 900) - (i * 900);
    const fullSlug = `btc-updown-15m-${ts}`;
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${fullSlug}`);
      const events = await res.json();
      if (events && events.length > 0 && events[0].markets) {
        for (const m of events[0].markets) {
          if (m.question && m.question.includes('6:45AM-7:00AM')) {
            return { gammaConditionId: m.conditionId, question: m.question, clobTokenIds: m.clobTokenIds };
          }
        }
      }
    } catch(e) {}
  }
  return null;
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  let eoaAddress = null;
  if (privateKey) {
    const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    eoaAddress = new ethers.Wallet(cleanKey).address;
  }

  console.log('=== POSITION DEBUG ===');
  console.log('Safe:', SAFE);
  console.log('EOA:', eoaAddress || 'NOT SET - check .env file!');
  console.log('');

  const pos = WINNING_POSITIONS[0];
  console.log(`--- ${pos.name} ($${pos.value}) ---`);
  console.log('Data API conditionId:', pos.dataApiConditionId);

  // Check Data API conditionId on CTF
  const pd1 = await ctf.payoutDenominator(pos.dataApiConditionId);
  console.log('Data API conditionId payoutDenominator:', pd1.toString(), pd1.gt(0) ? 'RESOLVED' : 'NOT RESOLVED');

  // Find the Gamma API conditionId
  console.log('\nSearching Gamma API for same market...');
  const gamma = await findGammaConditionId();
  if (gamma) {
    console.log('Gamma API conditionId:', gamma.gammaConditionId);
    console.log('Question:', gamma.question);
    console.log('Same as Data API?', gamma.gammaConditionId === pos.dataApiConditionId ? 'YES' : 'NO - DIFFERENT!');

    const pd2 = await ctf.payoutDenominator(gamma.gammaConditionId);
    console.log('Gamma conditionId payoutDenominator:', pd2.toString(), pd2.gt(0) ? 'RESOLVED' : 'NOT RESOLVED');

    if (gamma.clobTokenIds) {
      const tokenIds = typeof gamma.clobTokenIds === 'string' ? JSON.parse(gamma.clobTokenIds) : gamma.clobTokenIds;
      console.log('\nGamma token IDs:', tokenIds.map(t => t.substring(0, 25) + '...'));
      console.log('Data API tokenId:', pos.tokenId.substring(0, 25) + '...');

      for (let i = 0; i < tokenIds.length; i++) {
        const safeBal = await ctf.balanceOf(SAFE, tokenIds[i]);
        console.log(`  Token[${i}] Safe balance: ${ethers.utils.formatUnits(safeBal, 6)}`);
        if (eoaAddress) {
          const eoaBal = await ctf.balanceOf(eoaAddress, tokenIds[i]);
          console.log(`  Token[${i}] EOA balance: ${ethers.utils.formatUnits(eoaBal, 6)}`);
        }
      }
    }

    // Try estimateGas with GAMMA conditionId
    if (pd2.gt(0)) {
      console.log('\nTrying CTF.redeemPositions with Gamma conditionId...');
      const iface = new ethers.utils.Interface(CTF_ABI);
      const callData = iface.encodeFunctionData('redeemPositions', [
        USDC, ethers.constants.HashZero, gamma.gammaConditionId, [1, 2]
      ]);

      try {
        const gas = await provider.estimateGas({ from: SAFE, to: CTF, data: callData });
        console.log('  Safe gas estimate:', gas.toString(), '- WOULD SUCCEED!');
      } catch(e) {
        console.log('  Safe FAILED:', e.message.substring(0, 80));
      }

      if (eoaAddress) {
        try {
          const gas = await provider.estimateGas({ from: eoaAddress, to: CTF, data: callData });
          console.log('  EOA gas estimate:', gas.toString(), '- WOULD SUCCEED!');
        } catch(e) {
          console.log('  EOA FAILED:', e.message.substring(0, 80));
        }
      }
    }
  } else {
    console.log('Could not find this market on Gamma API');
  }

  // Also check Data API tokenId balances
  console.log('\nData API tokenId balance check:');
  const safeBal = await ctf.balanceOf(SAFE, pos.tokenId);
  console.log('  Safe balance:', ethers.utils.formatUnits(safeBal, 6));
  if (eoaAddress) {
    const eoaBal = await ctf.balanceOf(eoaAddress, pos.tokenId);
    console.log('  EOA balance:', ethers.utils.formatUnits(eoaBal, 6));
  }

  console.log('\n=== DONE ===');
}

main().catch(e => console.error('Fatal:', e.message));
