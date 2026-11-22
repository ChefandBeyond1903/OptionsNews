// Vercel serverless endpoint: same analysis as the local server, without practice trading
import { analyze, getMarket } from '../analyze.js';

const DEFAULTS = 'AAPL,MSFT,NVDA,AMD,TSLA,AMZN,GOOGL,META,NFLX,AVGO,JPM,BAC,XOM,CVX,PFE,DIS,BA,COIN,PLTR,INTC,SPY,QQQ';
const cache = new Map(), TTL = 10 * 60e3;

async function cached(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await analyze(sym).catch(e => ({ symbol: sym, error: String(e.message || e) }));
  cache.set(sym, { t: Date.now(), v });
  return v;
}

export default async function handler(req, res) {
  const raw = Array.isArray(req.query.tickers) ? req.query.tickers[0] : req.query.tickers;
  const syms = [...new Set((raw || DEFAULTS).toUpperCase().split(/[,\s]+/).filter(s => /^[A-Z.\-]{1,6}$/.test(s)))].slice(0, 40);
  const market = await getMarket().catch(() => null);
  const results = [];
  for (let i = 0; i < syms.length; i += 6) results.push(...await Promise.all(syms.slice(i, i + 6).map(cached)));
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(200).json({ updated: new Date(), market, results });
}
