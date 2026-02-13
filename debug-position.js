const { ethers } = require('ethers');

const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const SAFE = '0x94eAb3d7352aEb36A7378bc635b97E2968112e7E';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function balanceOf(address owner, uint256 tokenId) view returns (uint256)',
  'function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) pure returns (bytes32)'
];

const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const WINNING_POSITIONS = [
  {
    name: 'BTC Feb 13, 6:30-6:45AM',
    conditionId: '0x4e38d8ca6f9bfe8a89d8489d02e6e54eb60c42fa5be13858e2aa5e37e2deb32a',
    tokenId: '17981623054144211047055271887891526924846498969510010150349485671344877764511',
    value: 33.19
  },
  {
    name: 'BTC Feb 12, 5:15-5:30PM',
    conditionId: '0x7356e116ff27a85378e8a30aa6e8fdd3e68b3a74d6ffe2b12b5a5c4027f12f7c',
    tokenId: '47180250414069497310488053099489938424746839458770429261375367003834281754775',
    value: 19.06
  },
  {
    name: 'XRP Feb 11, 4:15-4:30PM',
    conditionId: '0x00b1f57b137d3392c2d20fac1a6ffb93be8e02a7c8b6dc0fbbb893f22cff74bb',
    tokenId: '45721544710873609359636973832753920421013668561372488289965777830023290978795',
    value: 9.99
  },
  {
    name: 'BTC Feb 13, 5:45-6:00AM',
    conditionId: '0x21eec08c40d2d4eab95fc636e9ba15eafde5ae7f7a82e3c7a1c2d0fd33c3dbff',
    tokenId: '10274089325382787352881363019459003820082296741998115992847539064390261949975',
    value: 7.48
  },
  {
    name: 'BTC Feb 13, 6:15-6:30AM',
    conditionId: '0xfb8c76151f6993550ff850e8b3e94b4b39f6de66fa006db9b9d3dff4fb741b29',
    tokenId: '72558526497709773202520508988997662694766299418618779050577888743233989204377',
    value: 5.00
  },
  {
    name: 'BTC Feb 13, 6:45-7:00AM',
    conditionId: '0x922f1c67adc10beb2e67ec4c3b4e32f5ce8e3cbbc8f19d3437b78dc0a02ff0e6',
    tokenId: '12266552356322777655809949261698774888028831923752093728486532301723800534425',
    value: 4.48
  }
];

async function debugPosition(pos, provider, ctf) {
  console.log(`\n=== ${pos.name} ($${pos.value}) ===`);
  console.log(`ConditionId: ${pos.conditionId}`);
  console.log(`TokenId: ${pos.tokenId.substring(0, 30)}...`);

  // Step 1: Check if resolved
  try {
    const pd = await ctf.payoutDenominator(pos.conditionId);
    console.log(`1. payoutDenominator: ${pd.toString()} (${pd.gt(0) ? 'RESOLVED' : 'NOT RESOLVED'})`);
    if (pd.gt(0)) {
      const p0 = await ctf.payoutNumerators(pos.conditionId, 0);
      const p1 = await ctf.payoutNumerators(pos.conditionId, 1);
      console.log(`   Payouts: outcome[0]=${p0.toString()}, outcome[1]=${p1.toString()}`);
    }
  } catch(e) {
    console.log(`1. FAILED: ${e.message.substring(0, 80)}`);
    return;
  }

  // Step 2: Check token balance on Safe
  try {
    const bal = await ctf.balanceOf(SAFE, pos.tokenId);
    console.log(`2. Safe token balance: ${ethers.utils.formatUnits(bal, 6)} shares (${bal.gt(0) ? 'HAS TOKENS' : 'EMPTY'})`);
  } catch(e) {
    console.log(`2. Balance check FAILED: ${e.message.substring(0, 80)}`);
  }

  // Step 3: Check token balance on EOA
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (privateKey) {
    try {
      const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const wallet = new ethers.Wallet(cleanKey);
      const bal = await ctf.balanceOf(wallet.address, pos.tokenId);
      console.log(`3. EOA token balance: ${ethers.utils.formatUnits(bal, 6)} shares (${bal.gt(0) ? 'HAS TOKENS' : 'EMPTY'})`);
    } catch(e) {
      console.log(`3. EOA balance check FAILED: ${e.message.substring(0, 80)}`);
    }
  }

  // Step 4: Try estimateGas for CTF redemption from Safe
  try {
    const iface = new ethers.utils.Interface(CTF_ABI);
    const callData = iface.encodeFunctionData('redeemPositions', [
      USDC,
      ethers.constants.HashZero,
      pos.conditionId,
      [1, 2]
    ]);
    const gas = await provider.estimateGas({
      from: SAFE,
      to: CTF,
      data: callData
    });
    console.log(`4. CTF estimateGas from Safe: ${gas.toString()} — WOULD SUCCEED`);
  } catch(e) {
    console.log(`4. CTF from Safe FAILED: ${e.message.substring(0, 100)}`);
  }

  // Step 5: Try estimateGas for CTF redemption from EOA
  if (privateKey) {
    try {
      const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const wallet = new ethers.Wallet(cleanKey);
      const iface = new ethers.utils.Interface(CTF_ABI);
      const callData = iface.encodeFunctionData('redeemPositions', [
        USDC,
        ethers.constants.HashZero,
        pos.conditionId,
        [1, 2]
      ]);
      const gas = await provider.estimateGas({
        from: wallet.address,
        to: CTF,
        data: callData
      });
      console.log(`5. CTF from EOA: ${gas.toString()} — WOULD SUCCEED`);
    } catch(e) {
      console.log(`5. CTF from EOA FAILED: ${e.message.substring(0, 100)}`);
    }
  }
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  const ctf = new ethers.Contract(CTF, CTF_ABI, provider);

  console.log('=== DEBUGGING ALL 6 WINNING POSITIONS ===');
  console.log('Safe wallet:', SAFE);
  
  if (process.env.WALLET_PRIVATE_KEY) {
    const cleanKey = process.env.WALLET_PRIVATE_KEY.startsWith('0x') ? process.env.WALLET_PRIVATE_KEY : `0x${process.env.WALLET_PRIVATE_KEY}`;
    console.log('EOA wallet:', new ethers.Wallet(cleanKey).address);
  }

  for (const pos of WINNING_POSITIONS) {
    await debugPosition(pos, provider, ctf);
  }

  console.log('\n=== DONE ===');
}

main().catch(e => console.error('Fatal:', e.message));
