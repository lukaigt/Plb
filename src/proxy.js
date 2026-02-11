const http = require('http');
const https = require('https');
const logger = require('./logger');

let proxyConfigured = false;

function setupProxy() {
  const proxyUrl = process.env.PROXY_URL;

  if (!proxyUrl) {
    logger.addActivity('proxy', { message: 'No PROXY_URL set - using direct connection' });
    return false;
  }

  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const { HttpProxyAgent } = require('http-proxy-agent');

    const httpsAgent = new HttpsProxyAgent(proxyUrl);
    const httpAgent = new HttpProxyAgent(proxyUrl);

    http.globalAgent = httpAgent;
    https.globalAgent = httpsAgent;

    const maskedUrl = proxyUrl.replace(/:([^@:]+)@/, ':****@');
    logger.addActivity('proxy', { message: `Global agents overridden with proxy: ${maskedUrl}` });
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

async function testProxy() {
  try {
    return new Promise((resolve) => {
      https.get('https://api.ipify.org?format=json', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            logger.addActivity('proxy_test', {
              message: `Outgoing IP: ${parsed.ip} (proxy ${proxyConfigured ? 'ACTIVE' : 'NOT active'})`
            });
            resolve({ ip: parsed.ip, proxyActive: proxyConfigured });
          } catch (e) {
            resolve({ ip: 'unknown', proxyActive: proxyConfigured, error: 'Failed to parse IP response' });
          }
        });
      }).on('error', (err) => {
        logger.addActivity('proxy_test_error', { message: `Proxy test failed: ${err.message}` });
        resolve({ ip: 'unknown', proxyActive: false, error: err.message });
      });
    });
  } catch (err) {
    return { ip: 'unknown', proxyActive: false, error: err.message };
  }
}

async function testGeoblock() {
  try {
    return new Promise((resolve) => {
      https.get('https://polymarket.com/api/geoblock', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            logger.addActivity('geoblock_test', {
              message: `Geoblock check: blocked=${parsed.blocked}, country=${parsed.country}, ip=${parsed.ip}`
            });
            resolve(parsed);
          } catch (e) {
            resolve({ blocked: true, error: 'Failed to parse geoblock response' });
          }
        });
      }).on('error', (err) => {
        resolve({ blocked: true, error: err.message });
      });
    });
  } catch (err) {
    return { blocked: true, error: err.message };
  }
}

module.exports = { setupProxy, isProxyActive, testProxy, testGeoblock };
