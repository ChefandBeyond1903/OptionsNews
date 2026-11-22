// Practice (paper) trading: simulates fills with live prices using the same rules the site shows.
import fs from 'node:fs';
import { stockPrice, optionQuote } from './analyze.js';

const FILE = 'data/paper.json', FEE = 0.65;   // thinkorswim per-contract fee, charged on each side
const fresh = () => ({ settings: { balance: 5000, riskPct: 2, auto: false, maxPositions: 3 }, cash: 5000, pending: [], open: [], closed: [], log: [], nextId: 1 });
let S = load();
function load() { try { return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return fresh(); } }
function save() { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(S, null, 1)); }
const log = m => { S.log.unshift({ t: new Date().toISOString(), m }); S.log = S.log.slice(0, 100); };
const r2 = x => Math.round(x * 100) / 100;

function et(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute, wd: p.weekday };
}
const isOpen = t => !['Sat', 'Sun'].includes(t.wd) && t.mins >= 510 && t.mins < 900;
const exitDay = expiry => new Date(Date.parse(expiry + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10); // Thursday before Friday expiry
const equity = () => S.cash + S.open.reduce((a, p) => a + p.remaining * (p.mark ?? p.entry) * 100, 0);

export function arm(a) {
  if (!a || !a.idea || !a.timing) throw new Error('No trade idea for this stock');
  if ([...S.pending, ...S.open].some(p => p.symbol === a.symbol)) throw new Error(a.symbol + ' is already in practice');
  const i = a.idea, t = a.timing;
  S.pending.push({ id: S.nextId++, symbol: a.symbol, type: i.type, strike: i.strike, expiry: i.expiry, trigger: t.trigger,
    chaseLimit: t.chaseLimit, target: i.target, stop: i.stop, confidence: a.confidence, created: new Date().toISOString() });
  log(`Armed ${a.symbol} ${i.type} $${i.strike}: waiting for stock ${i.type === 'CALL' ? 'above' : 'below'} $${t.trigger}`);
  save();
}
export function cancel(id) {
  const p = S.pending.find(x => x.id === id); if (!p) throw new Error('Not found');
  S.pending = S.pending.filter(x => x !== p); log(`Cancelled ${p.symbol} order`); save();
}
export function setAuto(on) { S.settings.auto = !!on; log('Auto-practice ' + (on ? 'ON' : 'OFF')); save(); }
export function reset(balance, riskPct) {
  const b = Math.max(500, +balance || 5000);
  S = fresh(); S.settings.balance = b; S.settings.riskPct = Math.min(10, Math.max(0.5, +riskPct || 2)); S.cash = b; save();
}

function sell(pos, qty, price, why) {
  qty = Math.min(qty, pos.remaining);
  S.cash += qty * price * 100 - qty * FEE;
  pos.realized += qty * (price - pos.entry) * 100 - qty * FEE;
  pos.remaining -= qty;
  pos.events.push({ t: new Date().toISOString(), m: `Sold ${qty} @ $${price.toFixed(2)} (${why})` });
  log(`${pos.symbol}: sold ${qty} @ $${price.toFixed(2)}, ${why}`);
  if (pos.remaining === 0) {
    S.open = S.open.filter(x => x !== pos);
    S.closed.unshift({ ...pos, pnl: r2(pos.realized), exitReason: why, closedAt: new Date().toISOString() });
    S.closed = S.closed.slice(0, 300);
  }
}

export async function close(id) {
  const p = S.open.find(x => x.id === id); if (!p) throw new Error('Not found');
  const q = await optionQuote(p.symbol, p.expiry, p.type, p.strike);
  sell(p, p.remaining, q.bid > 0 ? q.bid : q.mid, 'closed manually'); save();
}

async function tryFill(p, t) {
  const price = await stockPrice(p.symbol);
  const call = p.type === 'CALL';
  if (call ? price > p.chaseLimit : price < p.chaseLimit) { S.pending = S.pending.filter(x => x !== p); log(`${p.symbol}: skipped, stock ran past the limit ($${price.toFixed(2)})`); return; }
  if (!(call ? price >= p.trigger : price <= p.trigger)) return;
  const q = await optionQuote(p.symbol, p.expiry, p.type, p.strike);
  const ask = q.ask > 0 ? q.ask : q.mid, cost = ask * 100;
  const budget = equity() * S.settings.riskPct / 100;
  const n = Math.min(Math.floor(budget / cost), Math.floor(S.cash / (cost + FEE)));
  S.pending = S.pending.filter(x => x !== p);
  if (n < 1) { log(`${p.symbol}: skipped, 1 contract ($${cost.toFixed(0)}) is over your risk budget ($${budget.toFixed(0)})`); return; }
  S.cash -= n * cost + n * FEE;
  S.open.push({ id: p.id, symbol: p.symbol, type: p.type, strike: p.strike, expiry: p.expiry, contracts: n, remaining: n, entry: ask,
    entryTime: new Date().toISOString(), stockEntry: price, target: p.target, stop: p.stop, stopOpt: ask * 0.6, tp: false,
    realized: -n * FEE, mark: q.mid, stockNow: price, confidence: p.confidence,
    events: [{ t: new Date().toISOString(), m: `Bought ${n} @ $${ask.toFixed(2)} (stock $${price.toFixed(2)})` }] });
  log(`${p.symbol}: BOUGHT ${n} ${p.type} $${p.strike} @ $${ask.toFixed(2)}`);
}

async function manage(pos, t) {
  const [q, sp] = await Promise.all([optionQuote(pos.symbol, pos.expiry, pos.type, pos.strike), stockPrice(pos.symbol)]);
  pos.mark = q.mid; pos.stockNow = sp;
  const bid = q.bid > 0 ? q.bid : q.mid, call = pos.type === 'CALL', ed = exitDay(pos.expiry);
  if (t.date > ed || (t.date === ed && t.mins >= 870)) return sell(pos, pos.remaining, bid, 'time exit (Thursday 2:30 PM CT)');
  if (q.mid <= pos.stopOpt || (call ? sp <= pos.stop : sp >= pos.stop)) return sell(pos, pos.remaining, bid, pos.tp ? 'stop (breakeven/trailing)' : 'stop loss');
  if (call ? sp >= pos.target : sp <= pos.target) return sell(pos, pos.remaining, bid, 'stock target reached');
  if (!pos.tp && q.mid >= pos.entry * 1.5) {
    pos.tp = true; pos.stopOpt = Math.max(pos.stopOpt, pos.entry);
    if (pos.remaining >= 2) sell(pos, Math.floor(pos.remaining / 2), bid, 'take profit (+50%, sold half)');
    else log(`${pos.symbol}: +50%; stop moved to breakeven`);
  }
}

export async function tick(scan) {
  const t = et();
  if (!isOpen(t)) return;
  for (const p of [...S.pending]) {
    try {
      if (t.date >= exitDay(p.expiry)) { S.pending = S.pending.filter(x => x !== p); log(`${p.symbol}: order expired, never triggered`); continue; }
      if (t.mins >= 540 && t.mins < 870) await tryFill(p, t);
    } catch (e) { /* quote unavailable, retry next tick */ }
  }
  for (const pos of [...S.open]) { try { await manage(pos, t); } catch (e) { /* retry next tick */ } }
  if (S.settings.auto && ['Mon', 'Tue', 'Wed'].includes(t.wd) && t.mins >= 540 && t.mins < 630 && S.pending.length + S.open.length < S.settings.maxPositions) {
    try {
      const picks = (await scan()).filter(r => r.signal !== 'NEUTRAL' && r.confidence >= 70 && r.idea && r.timing).sort((a, b) => b.rankScore - a.rankScore);
      for (const r of picks) {
        if (S.pending.length + S.open.length >= S.settings.maxPositions) break;
        try { arm(r); } catch { /* already tracked */ }
      }
    } catch { /* scan failed */ }
  }
  save();
}

export function summary() {
  const c = S.closed, wins = c.filter(x => x.pnl > 0), losses = c.filter(x => x.pnl <= 0);
  const eq = equity();
  return {
    settings: S.settings, cash: r2(S.cash), equity: r2(eq), pnl: r2(eq - S.settings.balance), marketOpen: isOpen(et()),
    pending: S.pending, open: S.open.map(p => ({ ...p, unrealized: r2(p.remaining * ((p.mark ?? p.entry) - p.entry) * 100) })),
    closed: c.slice(0, 50), log: S.log.slice(0, 25),
    stats: { trades: c.length, winRate: c.length ? Math.round(100 * wins.length / c.length) : null, realized: r2(c.reduce((a, x) => a + x.pnl, 0)),
      avgWin: wins.length ? r2(wins.reduce((a, x) => a + x.pnl, 0) / wins.length) : null, avgLoss: losses.length ? r2(losses.reduce((a, x) => a + x.pnl, 0) / losses.length) : null },
  };
}
