/*
 * Simple Teller backend server
 *
 * This server exposes a single POST endpoint at `/api/teller/sync` to accept
 * an `access_token` from your Teller Connect client. It then uses the
 * access token to fetch the user’s accounts and their transactions from
 * the Teller API and filters the transactions to the last three months.
 *
 * Notes:
 * - This implementation uses only Node.js built‑in modules (`http`,
 *   `https`) so it can run without any external dependencies. If you
 *   prefer Express or axios, feel free to swap them in.
 * - The server adds CORS headers (`Access-Control-Allow-Origin: *`) so
 *   it can accept requests from your hosted Teller Connect page on a
 *   different domain. For production use, set this to your actual
 *   domain instead of `*`.
 * - Replace the port number (3000) as needed.
 *
 * To run this server locally:
 *   node teller_server.js
 *
 * Then, update the fetch call in your front‑end (index.html) to point to
 *   http://localhost:3000/api/teller/sync
 * or to the URL where this server is deployed. Ensure the server is
 *   accessible over HTTPS if your front‑end is served over HTTPS.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(process.env.DATA_DIR || '/tmp', 'data.json');
// in the same directory as this server script.

// by setting ADMIN_USER and ADMIN_PASS environment variables in your
// Render service settings.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

/**
 * Perform a GET request to the Teller API with the provided access token.
 *
 * @param {string} endpoint The path (starting with `/`) of the Teller API
 *   endpoint to call. You can pass full URLs (e.g. those returned in
 *   account.links.transactions), in which case the host and pathname are
 *   extracted automatically.
 * @param {string} accessToken The Teller access token (from onSuccess).
 * @returns {Promise<any>} Resolves to parsed JSON response.
 */
function callTeller(endpoint, accessToken) {
  return new Promise((resolve, reject) => {
    // If a full URL is provided, extract hostname and path. Otherwise
    // default to api.teller.io.
    let host = 'api.teller.io';
    let path = endpoint;
    try {
      if (endpoint.startsWith('http')) {
        const u = new URL(endpoint);
        host = u.hostname;
        path = u.pathname + u.search;
      }
    } catch (err) {
      return reject(err);
    }
    const options = {
      hostname: host,
      path: path,
      method: 'GET',
      auth: `${accessToken}:`, // Basic auth: username = accessToken, blank password
      headers: {
        // User-Agent is recommended by Teller; adjust as needed
        'User-Agent': 'teller-example-node-server'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (parseErr) {
            reject(parseErr);
          }
        } else {
          reject(new Error(`Teller API request failed: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * Filter an array of transactions to include only those within the last
 * `numMonths` months. Assumes each transaction has a `date` property
 * formatted as an ISO 8601 date string (e.g. `2023-07-15`).
 *
 * @param {Array} transactions An array of transaction objects.
 * @param {number} numMonths The number of months to look back (default 3).
 * @returns {Array} Filtered array of transactions.
 */
function filterRecentTransactions(transactions, numMonths = 3) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - numMonths);
  return transactions.filter((tx) => {
    try {
      const txDate = new Date(tx.date);
      return txDate >= cutoff;
    } catch (err) {
      return false;
    }
  });
}

// Create an HTTP server. For HTTPS in production, terminate TLS at a proxy
// (e.g. Nginx) or use a proper certificate in Node.
const server = http.createServer(async (req, res) => {
  // Allow cross‑origin requests. Replace '*' with your front‑end origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    // Respond to preflight
    res.writeHead(204);
    return res.end();
  }

  // Admin dashboard. Requires basic auth. Shows persisted sync data.
  if (req.method === 'GET' && req.url === '/admin') {
    const authHeader = req.headers['authorization'];
    // Send authentication challenge if no credentials are provided
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Admin"' });
      return res.end('Authentication required');
    }
    // Decode provided credentials
    try {
      const encoded = authHeader.split(' ')[1];
      const decoded = Buffer.from(encoded, 'base64').toString();
      const [user, pass] = decoded.split(':');
      if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
    } catch (err) {
      res.writeHead(400);
      return res.end('Bad Authorization header');
    }
    // Read stored data
    let entries = [];
    if (fs.existsSync(DATA_FILE)) {
      try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        entries = JSON.parse(data);
      } catch (err) {
        // ignore parse errors
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write('<html><head><title>Teller Data</title>');
    res.write('<style>body{font-family:Arial,sans-serif;margin:20px;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #ddd;padding:8px;} th{background:#f2f2f2;text-align:left;} pre{white-space:pre-wrap;}</style>');
    res.write('</head><body>');
    res.write('<h1>Teller Sync Data</h1>');
    res.write('<table>');
    res.write('<tr><th>Timestamp</th><th>Access Token</th><th>Accounts &amp; Transactions</th></tr>');
    for (const entry of entries) {
      res.write('<tr>');
      res.write(`<td>${entry.timestamp || ''}</td>`);
      res.write(`<td>${entry.accessToken || ''}</td>`);
      res.write('<td><pre>');
      try {
        res.write(JSON.stringify(entry.accounts, null, 2));
      } catch {
        res.write('Invalid entry');
      }
      res.write('</pre></td>');
      res.write('</tr>');
    }
    res.write('</table>');
    res.end('</body></html>');
    return;
  }

  if (req.method === 'POST' && req.url === '/api/teller/sync') {
      console.log('Received /api/teller/sync request');
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
const accessToken = payload.access_token || payload.accessToken;
        if (!accessToken) {
          throw new Error('Missing access_token');
        }
        // Step 1: list all accounts
        const accounts = await callTeller('/accounts', accessToken);
        const results = [];
        // Step 2: fetch transactions for each account and filter recent
        for (const account of accounts) {
          if (account.links && account.links.transactions) {
            // Note: account.links.transactions may be a full URL
            const transactions = await callTeller(account.links.transactions, accessToken);
            const recent = filterRecentTransactions(transactions, 3);
            results.push({
              accountId: account.id,
              institution: account.institution ? account.institution.name : undefined,
              transactions: recent
            });
          }
        }
        // Persist the results to the data file. We append each sync with the
        // access token and timestamp for later viewing in the admin portal.
        try {
          let store = [];
          if (fs.existsSync(DATA_FILE)) {
            store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
          }
          store.push({
            accessToken: accessToken,
            timestamp: new Date().toISOString(),
            accounts: results
          });
          fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
        } catch (storageErr) {
          console.error('Failed to store sync data:', storageErr);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Teller backend server running on port ${PORT}`);
});
