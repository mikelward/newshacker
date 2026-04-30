#!/usr/bin/env node
// Dev-only reverse proxy: sits in front of Vite (port 5173) and intercepts
// /api/items requests, fanning them out to Firebase. All other requests pass
// through to Vite unchanged. This lets `npm run dev` work without vercel auth.
//
// Usage:
//   1. Start Vite:  npm run dev           (port 5173)
//   2. Start proxy: node dev-proxy.mjs    (port 3000)
//   3. Open http://localhost:3000 in the browser

import http from 'node:http';
import https from 'node:https';

const PROXY_PORT = 3000;
const VITE_PORT = 5173;
const HN_API = 'https://hacker-news.firebaseio.com/v0';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function handleApiItems(req, res) {
  const url = new URL(req.url, `http://localhost:${PROXY_PORT}`);
  const idsParam = url.searchParams.get('ids');
  if (!idsParam) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ids' }));
    return;
  }
  const ids = idsParam.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (ids.length === 0 || ids.length > 30) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid ids' }));
    return;
  }
  const items = await Promise.all(
    ids.map(id => httpsGet(`${HN_API}/item/${id}.json`).catch(() => null))
  );
  const fields = url.searchParams.get('fields');
  const result = fields === 'full' ? items : items.map(item => {
    if (!item) return null;
    const { id, type, by, time, title, url: u, text, score, descendants, dead, deleted } = item;
    return { id, type, by, time, title, url: u, text, score, descendants, dead, deleted };
  });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=60',
  });
  res.end(JSON.stringify(result));
}

function proxyToVite(req, res) {
  const options = {
    hostname: 'localhost',
    port: VITE_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${VITE_PORT}` },
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on('error', () => {
    res.writeHead(502);
    res.end('Vite not reachable');
  });

  req.pipe(proxy, { end: true });
}

function handleUpgrade(req, socket, head) {
  const options = {
    hostname: 'localhost',
    port: VITE_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${VITE_PORT}` },
  };
  const proxy = http.request(options);
  proxy.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(proxyRes.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n'
    );
    if (proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxy.on('error', () => socket.destroy());
  proxy.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PROXY_PORT}`);
  if (url.pathname === '/api/items') {
    handleApiItems(req, res);
    return;
  }
  // All other /api/* routes return 503 in dev mode
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/items') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not configured in dev mode' }));
    return;
  }
  proxyToVite(req, res);
});

server.on('upgrade', handleUpgrade);

server.listen(PROXY_PORT, () => {
  console.log(`Dev proxy: http://localhost:${PROXY_PORT} → Vite :${VITE_PORT}`);
  console.log(`/api/items handled locally (Firebase fan-out)`);
});
