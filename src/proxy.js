const logger = require('./logger');

let proxyConfigured = false;

function setupProxy() {
  const proxyUrl = process.env.PROXY_URL;

  if (!proxyUrl) {
    logger.addActivity('proxy', { message: 'No PROXY_URL set - using direct connection' });
    return false;
  }

  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    const proxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(proxyAgent);

    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;

    const maskedUrl = proxyUrl.replace(/:([^@:]+)@/, ':****@');
    logger.addActivity('proxy', { message: `Proxy configured: ${maskedUrl}` });
    proxyConfigured = true;
    return true;
  } catch (err) {
    logger.addActivity('proxy_error', { message: `Failed to configure proxy: ${err.message}` });
    return false;
  }
}

function isProxyActive() {
  return proxyConfigured;
}

module.exports = { setupProxy, isProxyActive };
