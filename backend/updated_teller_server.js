/*
 * Simple Teller backend server
 *
 * POST /api/teller/sync
 *   Body: { access_token: "..." }  // or { accessToken: "..." }
 *   Action: fetch accounts + recent transactions, persist result.
 *
 * GET /admin  (basic auth)
 *   Shows persisted sync records (file + in-memory for current runtime).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ---------------- Persistence helpers ----------------
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'data.json');

const syncEntries = [];

function safeLoad() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

function safeSave(entries) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write DATA_FILE:', e.message);
  }
}

// ---------------- Auth for /admin ----------------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

// ---------------- Teller HTTP helper ----------------
function callTeller(endpoint, accessToken) {
  return new Promise((resolve, reject) => {
    let host = 'api.teller.io';
    let reqPath = endpoint;

    try {
      if (endpoint.startsWith('http')) {
        const u = new URL(endpoint);
        host = u.hostname;
        reqPath = u.pathname + u.search;
      }
    } catch (err) {
      return reject(err);
    }

    const options = {
      hostname: host,
      path: reqPath,
      method: 'GET',
      auth: `${accessToken}:`, // basic auth: token as username
      headers: { 'User-Agent': 'teller-example-node-server' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        } else {
          reject(new Error(`Teller API request failed: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ---------------- Utility: recent tx filter ----------------
function filterRecentTransactions(transactions, numMonths = 3) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - numMonths);
  return (transactions || []).filter((tx) => {
    try { return new Date(tx.date) >= cutoff; }
    catch { return false; }
  });
}

// ---------------- HTTP Server ----------------
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*'); // set your domain in prod
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ---------- Admin dashboard ----------
  if (req.method === 'GET' && req.url === '/admin') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Admin"' });
      return res.end('Authentication required');
    }

    try {
      const encoded = authHeader.split(' ')[1];
      const decoded = Buffer.from(encoded, 'base64').toString();
      const [user, pass] = decoded.split(':');
      if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
    } catch {
      res.writeHead(400);
      return res.end('Bad Authorization header');
    }

    // Combine persisted + in-memory (current runtime)
    const entries = safeLoad().concat(syncEntries);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write('<html><head><title>Teller Sync Data</title>');
    res.write('<style>body{font-family:Arial,sans-serif;margin:20px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:8px;}th{background:#f2f2f2;text-align:left;}pre{white-space:pre-wrap;margin:0}</style>');
    res.write('</head><body>');
    res.write('<h1>Teller Sync Data</h1>');
    res.write('<table>');
    res.write('<tr><th>Timestamp</th><th>Access Token</th><th>Accounts &amp; Transactions</th></tr>');
    for (const entry of entries) {
      res.write('<tr>');
      res.write(`<td>${entry.timestamp || ''}</td>`);
      res.write(`<td>${entry.accessToken || ''}</td>`);
      res.write('<td><pre>');
      try { res.write(JSON.stringify(entry.accounts, null, 2)); }
      catch { res.write('Invalid entry'); }
      res.write('</pre></td>');
      res.write('</tr>');
    }
    res.write('</table>');
    res.end('</body></html>');
    return;
  }

  // ---------- Sync endpoint ----------
  if (req.method === 'POST' && req.url === '/api/teller/sync') {
    console.log('Received /api/teller/sync request');

    let body = '';
    req.on('data', (chunk) => { body += chunk; });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const accessToken = payload.access_token || payload.accessToken;
        if (!accessToken) throw new Error('Missing access_token');

        // 1) Accounts
        const accounts = await callTeller('/accounts', accessToken);

        // 2) For each account, fetch and keep only recent transactions
        const results = [];
        for (const account of accounts) {
          if (account?.links?.transactions) {
            const tx = await callTeller(account.links.transactions, accessToken);
            const recent = filterRecentTransactions(tx, 3);
            results.push({
              accountId: account.id,
              institution: account.institution ? account.institution.name : undefined,
              transactions: recent
            });
          }
        }

        // 3) Build a single record and persist (memory + file)
        const record = {
          accessToken,
          timestamp: new Date().toISOString(),
          accounts: results
        };
        syncEntries.push(record);                 // in-memory for this runtime
        const store = safeLoad();                 // file-backed
        store.push(record);
        safeSave(store);

        // 4) Respond once
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(record));
      } catch (err) {
        console.error('Sync error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Teller backend server running on port ${PORT}`);
});
