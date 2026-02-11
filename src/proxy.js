const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let proxyConfigured = false;

function patchClobClient(proxyUrl) {
  const helpersPath = path.join(
    path.dirname(require.resolve('@polymarket/clob-client')),
    'http-helpers',
    'index.js'
  );

  const backupPath = helpersPath + '.original';

  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, helpersPath);
    console.log('[PROXY] Restored original CLOB client from backup');
  }

  let code = fs.readFileSync(helpersPath, 'utf8');

  if (code.includes('__PROXY_PATCHED__')) {
    console.log('[PROXY] CLOB client has stale patch, reinstalling fresh copy...');
    try {
      require('child_process').execSync('npm install @polymarket/clob-client --force --no-audit 2>/dev/null', { cwd: path.resolve(__dirname, '..') });
      code = fs.readFileSync(helpersPath, 'utf8');
      console.log('[PROXY] Fresh CLOB client installed');
    } catch (e) {
      console.error('[PROXY] Could not reinstall CLOB client:', e.message);
      return false;
    }
  }

  fs.copyFileSync(helpersPath, backupPath);

  const originalLine = 'return await axios({ method, url: endpoint, headers, data, params });';

  if (!code.includes(originalLine)) {
    console.error('[PROXY] Could not find axios call in CLOB client to patch');
    return false;
  }

  const agentSetup = `import { HttpsProxyAgent } from 'https-proxy-agent';\nconst __proxyAgent = new HttpsProxyAgent(${JSON.stringify(proxyUrl)});\n`;
  code = agentSetup + code;

  const patchedLine = `// __PROXY_PATCHED__
    return await axios({ method, url: endpoint, headers, data, params, httpsAgent: __proxyAgent, httpAgent: __proxyAgent, proxy: false });`;

  code = code.replace(originalLine, patchedLine);

  const lines = code.split('\n');
  let patched = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('config: err.response') && lines[i].includes('config')) {
      console.log(`[PROXY] Removing circular-ref config line at line ${i + 1}: ${lines[i].trim()}`);
      lines[i] = '';
      patched = true;
    }
    if (lines[i].includes('console.error("[CLOB Client] request error", err)')) {
      lines[i] = lines[i].replace(
        'console.error("[CLOB Client] request error", err)',
        'console.error("[CLOB Client] request error", String(err))'
      );
      patched = true;
    }
    if (lines[i].includes('return { error: err }')) {
      lines[i] = lines[i].replace('return { error: err }', 'return { error: String(err) }');
      patched = true;
    }
  }
  code = lines.join('\n');
  if (patched) {
    console.log('[PROXY] Error handler patched (removed config, safe stringify)');
  }

  fs.writeFileSync(helpersPath, code, 'utf8');
  console.log('[PROXY] CLOB client http-helpers patched successfully');
  return true;
}

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

    const patched = patchClobClient(proxyUrl);

    const maskedUrl = proxyUrl.replace(/:([^@:]+)@/, ':****@');
    console.log(`[PROXY] Global agents overridden: ${maskedUrl}`);
    console.log(`[PROXY] CLOB client patched: ${patched}`);
    logger.addActivity('proxy', { message: `Proxy active (CLOB patched=${patched}): ${maskedUrl}` });
    proxyConfigured = true;
    return true;
  } catch (err) {
    console.error(`[PROXY ERROR] ${err.message}`);
    console.error(err.stack);
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
