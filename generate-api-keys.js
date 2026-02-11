require('dotenv').config();

const { ClobClient } = require('@polymarket/clob-client');
const { Wallet } = require('ethers');

async function generateKeys() {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: WALLET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const signer = new Wallet(cleanKey);

  console.log(`Wallet address: ${signer.address}`);
  console.log('Generating CLOB API credentials...\n');

  const client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    signer
  );

  try {
    const creds = await client.createOrDeriveApiKey();

    console.log('=== YOUR CLOB API CREDENTIALS ===');
    console.log(`POLY_API_KEY=${creds.apiKey}`);
    console.log(`POLY_API_SECRET=${creds.secret}`);
    console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
    console.log('=================================\n');
    console.log('Copy these 3 lines into your .env file, replacing the old values.');
  } catch (err) {
    console.error('Failed to generate keys:', err.message);
    if (err.message.includes('403') || err.message.includes('blocked')) {
      console.error('This might be a geo-restriction. Make sure proxy is working.');
    }
  }
}

generateKeys();
