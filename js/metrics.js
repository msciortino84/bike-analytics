// Calcoli di allenamento: NP, IF, TSS, curva di potenza, zone, PMC (CTL/ATL/TSB).
export const CURVE_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

// Ricampiona i record a 1 secondo (riempie i buchi brevi con l'ultimo valore).
function perSecond(records, key) {
  const pts = records.filter(r => r.t != null);
  if (pts.length < 2) return [];
  const out = [];
  const t0 = pts[0].t;
  let j = 0;
  const tEnd = pts[pts.length - 1].t;
  for (let t = t0; t <= tEnd; t += 1000) {
    while (j + 1 < pts.length && pts[j + 1].t <= t) j++;
    const gap = t - pts[j].t;
    out.push(gap > 5000 ? 0 : pts[j][key] ?? 0);
  }
  return out;
}

export function normalizedPower(p) {
  if (p.length < 30) return null;
  let sum = 0, win = 0, acc = 0, n = 0;
  for (let i = 0; i < p.length; i++) {
    win += p[i];
    if (i >= 30) win -= p[i - 30];
    if (i >= 29) { acc += (win / 30) ** 4; n++; }
  }
  return Math.pow(acc / n, 0.25);
}

export function bestEfforts(p) {
  const res = {};
  for (const d of CURVE_DURATIONS) {
    if (p.length < d) continue;
    let s = 0, best = 0;
    for (let i = 0; i < p.length; i++) {
      s += p[i];
      if (i >= d) s -= p[i - d];
      if (i >= d - 1 && s > best) best = s;
    }
    res[d] = Math.round(best / d);
  }
  return res;
}

export const POWER_ZONES = [
  { name: 'Z1 Recupero', max: 0.55 }, { name: 'Z2 Endurance', max: 0.75 },
  { name: 'Z3 Tempo', max: 0.9 }, { name: 'Z4 Soglia', max: 1.05 },
  { name: 'Z5 VO2max', max: 1.2 }, { name: 'Z6 Anaerobico', max: 1.5 },
  { name: 'Z7 Neuromusc.', max: Infinity },
];

export function powerZones(p, ftp) {
  const z = new Array(POWER_ZONES.length).fill(0);
  if (!ftp) return z;
  for (const w of p) {
    if (w <= 0) continue;
    const r = w / ftp;
    z[POWER_ZONES.findIndex(zn => r <= zn.max)]++;
  }
  return z;
}

// Analisi completa di un'attività da FIT.
export function analyzeRecords(records, session, settings) {
  const p = perSecond(records, 'power');
  const hasPower = p.some(x => x > 0);
  const hrs = records.map(r => r.hr).filter(Boolean);
  const avgHr = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
  const movingTime = session?.movingTime ?? p.length;
  const np = hasPower ? normalizedPower(p) : null;
  const avgPower = hasPower ? p.reduce((a, b) => a + b, 0) / p.length : null;
  const ftp = settings.ftp;
  let tss = null, ifactor = null;
  if (np && ftp) {
    ifactor = np / ftp;
    tss = (movingTime * np * ifactor) / (ftp * 3600) * 100;
  } else if (avgHr && settings.lthr) {
    ifactor = avgHr / settings.lthr;
    tss = (movingTime / 3600) * ifactor * ifactor * 100; // hrTSS approssimato
  }
  const lastDist = [...records].reverse().find(r => r.dist != null)?.dist;
  let ascent = session?.ascent;
  if (ascent == null) {
    ascent = 0;
    let prev = null;
    for (const r of records) {
      if (r.alt == null) continue;
      if (prev != null && r.alt > prev) ascent += r.alt - prev;
      prev = r.alt;
    }
  }
  return {
    date: session?.start ?? records.find(r => r.t)?.t ?? Date.now(),
    movingTime, distance: session?.distance ?? lastDist ?? 0, ascent,
    avgPower: avgPower && Math.round(avgPower), np: np && Math.round(np),
    avgHr: avgHr && Math.round(avgHr), tss: tss && Math.round(tss),
    ifactor: ifactor && +ifactor.toFixed(2),
    curve: hasPower ? bestEfforts(p) : {},
    zones: hasPower ? powerZones(p, ftp) : [],
  };
}

// Performance Management Chart: CTL (42 gg), ATL (7 gg), TSB = CTL - ATL di ieri.
export function pmc(activities, days = 180) {
  const byDay = new Map();
  for (const a of activities) {
    const k = dayKey(a.date);
    byDay.set(k, (byDay.get(k) || 0) + (a.tss || 0));
  }
  const first = activities.length ? Math.min(...activities.map(a => a.date)) : Date.now();
  const start = startOfDay(first);
  const today = startOfDay(Date.now());
  let ctl = 0, atl = 0;
  const out = [];
  for (let t = start; t <= today; t += 86400000) {
    const load = byDay.get(dayKey(t)) || 0;
    const tsb = ctl - atl;
    ctl += (load - ctl) / 42;
    atl += (load - atl) / 7;
    out.push({ date: t, load, ctl, atl, tsb });
  }
  return out.slice(-days);
}

export function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
