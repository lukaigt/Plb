const logger = require('./logger');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');

let proxyConfigured = false;
let proxyAgent = null;

function setupProxy() {
  const proxyUrl = process.env.PROXY_URL;

  if (!proxyUrl) {
    logger.addActivity('proxy', { message: 'No PROXY_URL set - using direct connection' });
    return false;
  }

  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    const undiciAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(undiciAgent);

    proxyAgent = new HttpsProxyAgent(proxyUrl);

    axios.defaults.httpsAgent = proxyAgent;
    axios.defaults.httpAgent = proxyAgent;
    axios.defaults.proxy = false;

    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;

    const maskedUrl = proxyUrl.replace(/:([^@:]+)@/, ':****@');
    logger.addActivity('proxy', { message: `Proxy configured for ALL requests: ${maskedUrl}` });
    proxyConfigured = true;
    return true;
  } catch (err) {
    logger.addActivity('proxy_error', { message: `Failed to configure proxy: ${err.message}` });
    return false;
  }
}

function getProxyAgent() {
  return proxyAgent;
}

function isProxyActive() {
  return proxyConfigured;
}

async function testProxy() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    const ip = data.ip;
    logger.addActivity('proxy_test', { 
      message: `Outgoing IP: ${ip} (proxy ${proxyConfigured ? 'ACTIVE' : 'NOT active'})` 
    });
    return { ip, proxyActive: proxyConfigured };
  } catch (err) {
    logger.addActivity('proxy_test_error', { message: `Proxy test failed: ${err.message}` });
    return { ip: 'unknown', proxyActive: false, error: err.message };
  }
}

module.exports = { setupProxy, isProxyActive, getProxyAgent, testProxy };
