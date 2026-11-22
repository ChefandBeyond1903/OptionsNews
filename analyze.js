const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36' };
const RATE = 0.045;

/* ---------- news sentiment (one factor among several) ---------- */
const LEX = {
  beat: 2, beats: 2, surge: 2, surges: 2, soar: 2, soars: 2, rally: 2, jump: 1.5, jumps: 1.5, upgrade: 2, upgraded: 2, record: 1.5,
  growth: 1, strong: 1, raises: 1.5, raised: 1.5, boost: 1.5, outperform: 2, buy: 1, bullish: 2, gain: 1, gains: 1, profit: 1,
  approval: 1.5, approved: 1.5, partnership: 1, wins: 1.5, expands: 1, buyback: 1.5, rises: 1, climbs: 1.5, optimism: 1,
  miss: -2, misses: -2, plunge: -2.5, plunges: -2.5, slump: -2, tumble: -2, tumbles: -2, drop: -1.5, drops: -1.5, falls: -1.5,
  downgrade: -2, downgraded: -2, lawsuit: -2, probe: -2, investigation: -2, recall: -2, cuts: -1.5, cut: -1.5, layoffs: -1.5,
  weak: -1.5, warning: -1.5, warns: -2, bearish: -2, sell: -1, loss: -1.5, losses: -1.5, fraud: -3, bankruptcy: -3, fine: -1,
  fined: -1.5, ban: -1.5, delay: -1, delays: -1, concern: -1, concerns: -1, fears: -1.5, risk: -0.5, tariff: -1, tariffs: -1,
  decline: -1.5, declines: -1.5, sinks: -2, slides: -1.5,
};
function scoreText(t) {
  let s = 0;
  const w = t.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/);
  for (let i = 0; i < w.length; i++) {
    let v = LEX[w[i]];
    if (v === undefined) continue;
    if (['not', 'no', 'without'].includes(w[i - 1])) v = -v * 0.7;
    s += v;
  }
  return Math.max(-4, Math.min(4, s));
}
const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/<[^>]+>/g, '').trim();

async function getNews(sym) {
  const urls = [
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`,
    `https://news.google.com/rss/search?q=${sym}+stock+when:7d&hl=en-US&gl=US&ceid=US:en`,
  ];
  const items = [], seen = new Set();
  for (const u of urls) {
    try {
      const xml = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) })).text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const b = m[1], pick = tag => decode((b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || '');
        const title = pick('title'), date = new Date(pick('pubDate')), key = title.slice(0, 50).toLowerCase();
        if (!title || seen.has(key) || isNaN(date)) continue;
        seen.add(key);
        items.push({ title, link: pick('link'), date });
      }
    } catch { /* feed unavailable */ }
  }
  const cutoff = Date.now() - 7 * 864e5;
  return items.filter(i => i.date > cutoff).sort((a, b) => b.date - a.date).slice(0, 15);
}

/* ---------- Yahoo data ---------- */
let session = null;
async function auth() {
  if (session) return session;
  const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
  const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const crumb = await (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } })).text();
  if (!crumb || crumb.includes('<')) throw new Error('no crumb');
  return (session = { cookie, crumb });
}
async function yget(url) {
  const s = await auth();
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(s.crumb),
    { headers: { ...UA, Cookie: s.cookie }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function getPrices(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`,
    { headers: UA, signal: AbortSignal.timeout(8000) });
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0];
  return res.timestamp.map((t, i) => ({ t, c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume[i] || 0 })).filter(x => x.c != null);
}

async function getEarnings(sym) {
  try {
    const j = await yget(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=calendarEvents`);
    const d = j.quoteSummary.result[0].calendarEvents.earnings.earningsDate?.[0]?.raw;
    return d ? new Date(d * 1000) : null;
  } catch { return null; }
}

/* ---------- indicators ---------- */
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sma = (a, k) => mean(a.slice(-k));
const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
function ema(a, k) { const m = 2 / (k + 1); let e = a[0]; const out = [e]; for (let i = 1; i < a.length; i++) { e = a[i] * m + e * (1 - m); out.push(e); } return out; }
function rsi14(c) {
  let g = 0, l = 0;
  for (let i = c.length - 14; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function hv20(c) {
  const r = []; for (let i = c.length - 20; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const m = mean(r); return Math.sqrt(mean(r.map(x => (x - m) ** 2)) * 252 / 1);
}
function hvRank(c) {
  const cur = hv20(c), hist = [];
  for (let i = Math.max(40, c.length - 200); i < c.length; i += 2) hist.push(hv20(c.slice(0, i)));
  return Math.round(100 * hist.filter(x => x <= cur).length / hist.length);
}

/** Directional technical factors, each in [-1, 1]. spy20 = SPY 20d return (%) or null. */
function factors(rows, spy20) {
  const c = rows.map(r => r.c), v = rows.map(r => r.v), n = c.length, price = c[n - 1];
  const ret = k => (price / c[n - 1 - k] - 1) * 100;
  const e12 = ema(c, 12), e26 = ema(c, 26), macd = e12.map((x, i) => x - e26[i]), sig = ema(macd, 9);
  const trendVotes = [price > sma(c, 50) ? 1 : -1, sma(c, 20) > sma(c, 50) ? 1 : -1, macd[n - 1] > sig[n - 1] ? 1 : -1];
  if (n >= 200) trendVotes.push(sma(c, 50) > sma(c, 200) ? 1 : -1);
  const trend = mean(trendVotes);
  const rsi = rsi14(c);
  let momentum = 0.5 * Math.tanh(ret(20) / 10) + 0.5 * Math.tanh(ret(5) / 5);
  if (rsi > 78) momentum -= 0.3; else if (rsi < 22) momentum += 0.3;   // exhaustion -> mean reversion
  momentum = clamp(momentum);
  const relStrength = spy20 == null ? null : Math.tanh((ret(20) - spy20) / 8);
  const relVol = mean(v.slice(-5)) / (mean(v.slice(-50)) || 1);
  const volume = clamp(Math.sign(ret(5)) * clamp(relVol - 1, 0, 1));     // volume confirming the move
  const hi = Math.max(...rows.slice(-21, -1).map(r => r.h)), lo = Math.min(...rows.slice(-21, -1).map(r => r.l));
  const breakout = price > hi ? 1 : price < lo ? -1 : 0;
  const parts = [[trend, .30], [momentum, .25], [relStrength, .20], [volume, .10], [breakout, .15]].filter(p => p[0] !== null);
  const composite = parts.reduce((a, p) => a + p[0] * p[1], 0) / parts.reduce((a, p) => a + p[1], 0);
  return { trend, momentum, relStrength, volume, breakout, composite, rsi, relVol, ret5: ret(5), ret20: ret(20), price };
}

/** Walk-forward check: how often did this technical signal call the next-5-day direction? */
function backtest(rows) {
  let n = 0, hits = 0, sum = 0;
  for (let i = 60; i < rows.length - 5; i += 1) {
    const s = factors(rows.slice(0, i + 1), null).composite * 100;
    if (Math.abs(s) < 25) continue;
    const fwd = (rows[i + 5].c / rows[i].c - 1) * 100 * Math.sign(s);
    n++; sum += fwd; if (fwd > 0) hits++;
  }
  return n >= 5 ? { signals: n, hitRate: Math.round(100 * hits / n), avgReturn: +(sum / n).toFixed(2) } : null;
}

/* ---------- options math ---------- */
const N = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function bs(type, S, K, T, sig) {
  const d1 = (Math.log(S / K) + (RATE + sig * sig / 2) * T) / (sig * Math.sqrt(T)), d2 = d1 - sig * Math.sqrt(T);
  return type === 'CALL'
    ? { price: S * N(d1) - K * Math.exp(-RATE * T) * N(d2), delta: N(d1) }
    : { price: K * Math.exp(-RATE * T) * N(-d2) - S * N(-d1), delta: N(d1) - 1 };
}
function nextExpiry() {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  let add = (5 - d.getUTCDay() + 7) % 7; if (add < 5) add += 7;   // Friday at least 5 days out
  d.setUTCDate(d.getUTCDate() + add);
  return { date: d, days: add };
}

async function marketChain(sym, expiry, type, S) {
  try {
    const j = await yget(`https://query2.finance.yahoo.com/v7/finance/options/${sym}?date=${expiry.date.getTime() / 1000}`);
    const ch = j.optionChain.result[0].options[0];
    if (!ch) return null;
    const list = type === 'CALL' ? ch.calls : ch.puts;
    const atm = ch.calls.reduce((b, o) => Math.abs(o.strike - S) < Math.abs(b.strike - S) ? o : b, ch.calls[0]);
    return { list, atmIv: atm.impliedVolatility };
  } catch { return null; }
}

async function buildIdea(sym, type, S, weeklyMove, hv) {
  const expiry = nextExpiry(), T = expiry.days / 365, dir = type === 'CALL' ? 1 : -1;
  const chain = await marketChain(sym, expiry, type, S);
  let sigma = chain?.atmIv > 0.05 ? chain.atmIv : hv, source = chain ? 'market' : 'model';
  // pick strike with |delta| closest to 0.40 (balance of cost vs. probability)
  let best = null;
  // only suggest standard round strikes that are actually trading: $5 steps above $100, $1 steps below,
  // a real bid/ask (not crossed), and open interest of 100+. Odd $2.50 strikes are often missing or illiquid.
  const step = S >= 100 ? 5 : 1;
  const liquid = chain ? chain.list.filter(o => o.strike % step === 0 && o.bid > 0 && o.ask >= o.bid && o.openInterest >= 100) : [];
  const verified = liquid.length > 0;
  const strikes = chain ? (verified ? liquid : chain.list).map(o => o.strike)
    : [...new Set(Array.from({ length: 41 }, (_, i) => Math.round(S * (0.8 + i * 0.01) / step) * step))];
  for (const K of strikes) {
    const g = bs(type, S, K, T, sigma), diff = Math.abs(Math.abs(g.delta) - 0.40);
    if (!best || diff < best.diff) best = { K, diff, g };
  }
  let premium = best.g.price, bid = null, ask = null, volume = null, oi = null;
  if (chain) {
    const o = chain.list.find(x => x.strike === best.K);
    if (o) {
      bid = o.bid; ask = o.ask; volume = o.volume; oi = o.openInterest;
      premium = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.lastPrice || premium;
      if (o.impliedVolatility > 0.05) sigma = o.impliedVolatility;
    }
  }
  const target = S + dir * weeklyMove;
  const payoff = Math.max(0, dir * (target - best.K)) - premium;
  return {
    type, expiry: expiry.date.toISOString().slice(0, 10), strike: best.K, delta: +best.g.delta.toFixed(2),
    premium: +premium.toFixed(2), costPerContract: Math.round(premium * 100), breakeven: +(best.K + dir * premium).toFixed(2),
    target: +target.toFixed(2), stop: +(S - dir * weeklyMove * 0.6).toFixed(2),
    rewardRisk: premium > 0 ? +(payoff / premium).toFixed(1) : null,
    iv: +(sigma * 100).toFixed(0), source, verified, bid, ask, volume, openInterest: oi,
    spreadPct: bid > 0 && ask > 0 ? +(Math.abs(ask - bid) / premium * 100).toFixed(0) : null,
  };
}

/* ---------- live quotes (used by paper trading) ---------- */
export async function stockPrice(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`,
    { headers: UA, signal: AbortSignal.timeout(8000) });
  return (await r.json()).chart.result[0].meta.regularMarketPrice;
}
export async function optionQuote(sym, expiryISO, type, strike) {
  const j = await yget(`https://query2.finance.yahoo.com/v7/finance/options/${sym}?date=${Date.parse(expiryISO + 'T00:00:00Z') / 1000}`);
  const ch = j.optionChain.result[0].options[0];
  const o = ch && (type === 'CALL' ? ch.calls : ch.puts).find(x => x.strike === strike);
  if (!o) throw new Error('contract not found');
  const mid = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.lastPrice;
  return { bid: o.bid, ask: o.ask, mid, last: o.lastPrice };
}

/* ---------- market regime ---------- */
let marketCache = null;
export async function getMarket() {
  if (marketCache && Date.now() - marketCache.t < 10 * 60e3) return marketCache.v;
  const [spy, vix] = await Promise.all([getPrices('SPY'), getPrices('^VIX').catch(() => null)]);
  const c = spy.map(r => r.c), p = c.at(-1);
  const vixLast = vix ? vix.at(-1).c : null;
  let regime = (p > sma(c, 50) ? 0.4 : -0.4) + (sma(c, 20) > sma(c, 50) ? 0.3 : -0.3) + (p > c.at(-6) ? 0.3 : -0.3);
  if (vixLast > 30) regime -= 0.4; else if (vixLast > 22) regime -= 0.15; else if (vixLast < 15) regime += 0.1;
  const v = { regime: +clamp(regime).toFixed(2), spyRet20: (p / c.at(-21) - 1) * 100, spyPrice: p, vix: vixLast,
    label: regime > 0.3 ? 'Bullish' : regime < -0.3 ? 'Bearish' : 'Mixed' };
  marketCache = { t: Date.now(), v };
  return v;
}

/* ---------- main ---------- */
export async function analyze(sym) {
  const market = await getMarket();
  const [news, rows, earnings] = await Promise.all([getNews(sym), getPrices(sym), getEarnings(sym)]);
  if (rows.length < 60) throw new Error('not enough price history');

  const now = Date.now();
  let ws = 0, wt = 0;
  const headlines = news.map(n => {
    const s = scoreText(n.title), w = Math.exp(-(now - n.date) / (3 * 864e5));
    ws += s * w; wt += w;
    return { title: n.title, link: n.link, date: n.date, sentiment: s };
  });
  const newsScore = wt ? clamp(ws / wt / 2) : 0;

  const f = factors(rows, market.spyRet20);
  const hv = hv20(rows.map(r => r.c)), rank = hvRank(rows.map(r => r.c));
  const atr = mean(rows.slice(-14).map(r => r.h - r.l));
  const weeklyMove = Math.max(atr * Math.sqrt(5), f.price * hv * Math.sqrt(5 / 252) * 0.8);

  let raw = f.composite * 0.60 + newsScore * 0.25 + market.regime * 0.15;
  const dirSign = Math.sign(raw);
  if (dirSign !== 0 && dirSign !== Math.sign(market.regime) && Math.abs(market.regime) > 0.3) raw *= 0.8;  // don't fight the tape
  const score = Math.round(raw * 100);
  const signal = score >= 25 ? 'CALL' : score <= -25 ? 'PUT' : 'NEUTRAL';

  const bt = backtest(rows);
  const earningsDays = earnings ? Math.round((earnings - now) / 864e5) : null;
  const earningsRisk = earningsDays !== null && earningsDays >= 0 && earningsDays <= 7;

  const votes = [f.trend, f.momentum, f.relStrength, f.volume, f.breakout, newsScore, market.regime].filter(x => x !== null && x !== 0);
  const agree = votes.filter(x => Math.sign(x) === dirSign).length;
  let confidence = Math.abs(score) * 0.7 + agree * 4 + Math.min(1, headlines.length / 8) * 6;
  if (bt) confidence += bt.hitRate >= 55 ? 5 : bt.hitRate < 45 ? -10 : 0;
  if (earningsRisk) confidence -= 15;
  if (signal === 'NEUTRAL') confidence = Math.min(confidence, 40);
  confidence = Math.round(clamp(confidence, 0, 95) > 0 ? clamp(confidence, 0, 95) : 0);

  let idea = null, notes = [];
  if (signal !== 'NEUTRAL') {
    idea = await buildIdea(sym, signal, f.price, weeklyMove, hv).catch(() => null);
    if (rank >= 70) notes.push(`Volatility rank ${rank}: options are expensive; consider a debit spread instead of a naked ${signal.toLowerCase()}.`);
    if (earningsRisk) notes.push(`Earnings in ${earningsDays}d: IV crush risk. Avoid unless you want an earnings bet.`);
    if (f.rsi > 75 && signal === 'CALL') notes.push('RSI overbought: chasing a stretched move.');
    if (f.rsi < 25 && signal === 'PUT') notes.push('RSI oversold: bounce risk.');
    if (idea?.spreadPct > 15) notes.push(`Wide bid/ask spread (${idea.spreadPct}%): use limit orders.`);
    if (idea && idea.openInterest !== null && idea.openInterest < 100) notes.push('Low open interest: poor liquidity.');
    if (dirSign !== Math.sign(market.regime) && Math.abs(market.regime) > 0.3) notes.push(`Trade is against the ${market.label.toLowerCase()} market.`);
    if (bt && bt.hitRate < 50) notes.push(`This ticker's technical signal hit only ${bt.hitRate}% over the past year.`);
  }
  // "Winnability" ranking: signal strength adjusted for how well it has worked on this stock, payoff, option cost and liquidity
  let rankScore = 0;
  if (idea) {
    rankScore = confidence;
    if (bt) rankScore += (bt.hitRate - 50) * 0.6;
    if (idea.rewardRisk != null) rankScore += clamp(idea.rewardRisk, 0, 4) * 3;
    if (rank > 70) rankScore -= (rank - 70) * 0.3;                       // expensive options
    if (idea.spreadPct > 10) rankScore -= Math.min(10, idea.spreadPct - 10);
    if (idea.openInterest !== null && idea.openInterest < 100) rankScore -= 10;
    if (dirSign !== Math.sign(market.regime) && Math.abs(market.regime) > 0.3) rankScore -= 8;
    rankScore = Math.round(rankScore);
  }
  let timing = null;
  if (idea) {
    // use the last COMPLETED daily bar for trigger levels (drop today's partial bar)
    const etDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const done = etDay(rows.at(-1).t * 1000) === etDay(now) ? rows.slice(0, -1) : rows;
    const prev = done.at(-1), call = signal === 'CALL';
    const trigger = call ? prev.h : prev.l;
    const chase = call ? trigger + atr * 0.5 : trigger - atr * 0.5;
    // stock price at which the option is roughly +50% (delta approximation), never beyond 75% of the way to target
    const sellHalf = trigger + (call ? 1 : -1) * Math.min(0.5 * idea.premium / Math.max(0.15, Math.abs(idea.delta)), Math.abs(idea.target - trigger) * 0.75);
    timing = {
      sellHalf: +sellHalf.toFixed(2),
      trigger: +trigger.toFixed(2), chaseLimit: +chase.toFixed(2),
      entry: call
        ? `Buy only after the stock trades ABOVE $${trigger.toFixed(2)} (last session's high) after 9:00 AM CT. That confirms buyers are in control.`
        : `Buy only after the stock trades BELOW $${trigger.toFixed(2)} (last session's low) after 9:00 AM CT. That confirms sellers are in control.`,
      skip: `Skip if the stock is already past $${chase.toFixed(2)} (chasing), or gaps against you at the open.`,
      takeProfit: `Sell half when the option is up ~50% (about $${(idea.premium * 1.5).toFixed(2)}); sell the rest at the stock target $${idea.target} or if it stalls.`,
      stopLoss: `Exit if the option falls ~40% (about $${(idea.premium * 0.6).toFixed(2)}) or the stock reaches $${idea.stop}. Don't average down.`,
      timeStop: `Time stop: if the trade hasn't worked by Wednesday close, sell. Always be out by Thursday 2:30 PM CT: time decay speeds up and Friday expiry can wipe out a weekly option.`,
    };
  }
  return {
    history: rows.slice(-30).map(r => +r.c.toFixed(2)), timing, rankScore, symbol: sym, price: f.price, score, signal, confidence, agree, totalFactors: votes.length,
    factors: { trend: f.trend, momentum: f.momentum, relStrength: f.relStrength, volume: f.volume, breakout: f.breakout, news: newsScore, market: market.regime },
    rsi: f.rsi, ret5: f.ret5, ret20: f.ret20, relVol: f.relVol, hv: +(hv * 100).toFixed(0), hvRank: rank,
    earningsDays, backtest: bt, idea, notes, headlines,
  };
}
