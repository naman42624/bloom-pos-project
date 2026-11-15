// Rider km account: pure chain maths. No database access.
// Readings are the bike-meter notes taken when a rider arrives at the shop
// and when the rider leaves for home. See the rider km design doc.

const round1 = (n) => Math.round(n * 10) / 10;
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

// Shop-local date (YYYY-MM-DD) of a stored local timestamp, Date or string.
function localDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const { todayStr } = require('./time');
    return todayStr(v);
  }
  return String(v).slice(0, 10);
}

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round1((s[mid - 1] + s[mid]) / 2);
}

function usualHome(stretches) {
  const homes = stretches.filter((s) => s.kind === 'home').slice(-10).map((s) => s.km);
  return median(homes);
}

function buildChain(readings, answers, opts = {}) {
  const answerMap = new Map();
  for (const a of answers || []) answerMap.set(`${a.from_reading_id}:${a.to_reading_id}`, a);
  const override = opts.usualHomeKm != null ? Number(opts.usualHomeKm) : null;
  const stretches = [];
  let prev = null;
  let last = null;

  const push = (kind, from, to, km, reason) => {
    let ans = null;
    if (kind === 'gap') {
      const row = answerMap.get(`${from.id}:${to.id}`);
      if (row) ans = { answer: row.answer, work_km: row.work_km == null ? null : Number(row.work_km) };
    }
    stretches.push({ kind, fromId: from.id, toId: to.id, km: round1(km), endAt: to.read_at, answer: ans, reason: reason || null });
  };

  for (const r of readings || []) {
    last = r;
    if (r.kind === 'typed') {
      // A typed reading is its own paid stretch and breaks the chain.
      push('typed', r, r, num(r.typed_km) || 0, null);
      prev = null;
      continue;
    }
    const meter = num(r.meter);
    if (prev) {
      const km = meter - num(prev.meter);
      if (prev.kind === 'arrive' && r.kind === 'arrive') push('gap', prev, r, km, 'missed_leave');
      else if (prev.kind === 'leave' && r.kind === 'leave') push('gap', prev, r, km, 'missed_arrive');
      else if (prev.kind === 'arrive' && r.kind === 'leave') push('work', prev, r, km);
      else {
        const usual = override != null ? override : usualHome(stretches);
        const limit = usual != null ? usual * 2 : 30;
        if (km > limit) push('gap', prev, r, km, 'long_home');
        else push('home', prev, r, km);
      }
    }
    prev = r;
  }

  return {
    stretches,
    openDay: !!last && last.kind === 'arrive',
    usualHomeKm: override != null ? override : usualHome(stretches),
  };
}

function rateOn(rates, dateStr) {
  let best = null;
  for (const r of rates || []) {
    const eff = String(r.effective_from).slice(0, 10);
    if (eff <= dateStr && (!best || eff > best.eff)) best = { eff, rate: Number(r.rate) };
  }
  if (best) return best.rate;
  // Before the earliest rate: use the earliest one.
  const sorted = [...(rates || [])].sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  return sorted.length ? Number(sorted[0].rate) : 0;
}

function paidKmOf(s) {
  if (s.kind === 'work' || s.kind === 'typed') return s.km;
  if (s.kind === 'gap' && s.answer && s.answer.answer === 'typed') return s.answer.work_km || 0;
  return 0;
}

function priceStretches(stretches, rates, corrections) {
  const groups = new Map();
  let paidKm = 0;
  let amountPaise = 0;
  const add = (km, dateStr) => {
    if (!km) return;
    const rate = rateOn(rates, dateStr);
    const paise = Math.round(km * rate * 100);
    const g = groups.get(rate) || { rate, km: 0, amountPaise: 0 };
    g.km = round1(g.km + km);
    g.amountPaise += paise;
    groups.set(rate, g);
    paidKm += km;
    amountPaise += paise;
  };
  for (const s of stretches || []) add(paidKmOf(s), localDate(s.endAt));
  for (const c of corrections || []) add(Number(c.km), localDate(c.for_date || c.created_at));
  return {
    paidKm: round1(paidKm),
    amountPaise,
    byRate: [...groups.values()].sort((a, b) => a.rate - b.rate),
  };
}

function netPaise({ kmPaise = 0, petrolTakenPaise = 0, carriedInPaise = 0, supplyHeldPaise = 0, codHeldPaise = 0 }) {
  return kmPaise - petrolTakenPaise + carriedInPaise - supplyHeldPaise - codHeldPaise;
}

module.exports = { buildChain, usualHome, rateOn, priceStretches, netPaise };
