import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, getMarket } from './analyze.js';
import * as paper from './paper.js';

const PORT = process.env.PORT || 3000;
const DEFAULTS = 'AAPL,MSFT,NVDA,AMD,TSLA,AMZN,GOOGL,META,NFLX,AVGO,JPM,BAC,XOM,CVX,PFE,DIS,BA,COIN,PLTR,INTC,SPY,QQQ';
const cache = new Map(), TTL = 10 * 60e3;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

async function cached(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await analyze(sym).catch(e => ({ symbol: sym, error: String(e.message || e) }));
  cache.set(sym, { t: Date.now(), v });
  return v;
}
async function scan(syms) {
  const out = [];
  for (let i = 0; i < syms.length; i += 4) out.push(...await Promise.all(syms.slice(i, i + 4).map(cached)));
  return out.filter(r => !r.error);
}
const scanDefaults = () => scan(DEFAULTS.split(','));

// practice-trading engine: checks triggers, stops and targets every 2 minutes during market hours
setInterval(() => paper.tick(scanDefaults).catch(e => console.error('paper tick:', e.message)), 120e3);
setTimeout(() => paper.tick(scanDefaults).catch(() => {}), 5e3);

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(ok => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/analyze') {
      const syms = [...new Set((url.searchParams.get('tickers') || DEFAULTS).toUpperCase().split(/[,\s]+/).filter(s => /^[A-Z.\-]{1,6}$/.test(s)))].slice(0, 40);
      const market = await getMarket().catch(() => null);
      const results = [];
      for (let i = 0; i < syms.length; i += 4) results.push(...await Promise.all(syms.slice(i, i + 4).map(cached)));
      return json(res, 200, { updated: new Date(), market, results });
    }
    if (url.pathname === '/api/paper' && req.method === 'GET') return json(res, 200, paper.summary());
    if (url.pathname.startsWith('/api/paper/') && req.method === 'POST') {
      if (req.headers['x-app'] !== '1') return json(res, 403, { error: 'forbidden' });   // blocks other websites from posting here
      const b = await body(req), act = url.pathname.split('/').pop();
      if (act === 'arm') paper.arm(await cached(String(b.symbol).toUpperCase()));
      else if (act === 'cancel') paper.cancel(+b.id);
      else if (act === 'close') await paper.close(+b.id);
      else if (act === 'auto') paper.setAuto(b.on);
      else if (act === 'reset') paper.reset(b.balance, b.riskPct);
      else return json(res, 404, { error: 'unknown action' });
      return json(res, 200, paper.summary());
    }
  } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([\\/]|\.\.)+/, '');
  const file = path.join('public', rel);
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(d);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Options News running at http://localhost:${PORT}`));
