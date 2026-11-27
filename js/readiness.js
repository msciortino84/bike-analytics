// Indice di PRONTEZZA (0–100): quanto sei pronto oggi ad allenarti bene.
// Cinque pilastri confrontati con la TUA media personale; i pilastri senza dati non contano
// e il loro peso si ridistribuisce. Alcuni segnali molto negativi "tagliano" il punteggio.

const D = 864e5;
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = a => { const m = avg(a); return a.length > 1 ? Math.sqrt(avg(a.map(x => (x - m) ** 2))) : null; };
// interpolazione lineare a tratti: pts = [[x, y], ...] ordinati per x
const lerp = (x, pts) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
};

export const PILLARS = [
  { key: 'fresh', name: 'Freschezza', icon: '🔋', weight: 30, color: '#2f6fde' },
  { key: 'body', name: 'Recupero', icon: '❤️', weight: 30, color: '#d64545' },
  { key: 'sleep', name: 'Sonno', icon: '😴', weight: 20, color: '#7b3fbf' },
  { key: 'load', name: 'Equilibrio carico', icon: '📊', weight: 10, color: '#d98a00' },
  { key: 'quality', name: 'Qualità', icon: '🎯', weight: 10, color: '#1f9d55' },
];

export const LEVELS = [
  { min: 80, name: 'Pronto', color: '#1f9d55', advice: 'giornata adatta alla qualità' },
  { min: 60, name: 'Buono', color: '#2f6fde', advice: 'allenamento normale' },
  { min: 40, name: 'Attenzione', color: '#d98a00', advice: 'solo lavoro facile' },
  { min: 0, name: 'Recupera', color: '#d64545', advice: 'riposo o Z1' },
];
export const levelOf = s => LEVELS.find(l => s >= l.min);

/**
 * pmc: giorni { date, load, ctl, atl } (date = inizio giornata), fino a oggi
 * wellness: { date, hrv, restingHR, sleepSecs }
 * activities: uscite { date, tss, ifactor, movingTime, zones, indoor, decoupling }
 * day: inizio giornata da valutare (default oggi)
 */
export function computeReadiness({ pmc, wellness, activities, day }) {
  const idx = day == null ? pmc.length - 1 : pmc.findIndex(d => d.date === day);
  if (idx < 7) return null;
  const t = pmc[idx].date;
  const until = t + D; // dati disponibili fino alla fine di quel giorno
  const acts = activities.filter(a => a.date < until);
  const well = wellness.filter(w => w.date <= t).sort((a, b) => a.date - b.date);
  const res = {};
  const notes = {};
  const caps = [];

  // ---------- 🔋 Freschezza: forma (TSB) e rapporto fatica/fitness ----------
  // Stessa forma mostrata nei riquadri della dashboard (valori di intervals del giorno)
  const cur = pmc[idx];
  const tsb = cur.ctl - cur.atl;
  const acwr = cur.ctl > 0 ? cur.atl / cur.ctl : 1;
  let fresh = lerp(tsb, [[-40, 5], [-30, 20], [-20, 40], [-10, 65], [0, 85], [10, 100], [25, 95], [40, 75]]);
  if (acwr > 1.5) fresh -= 20; else if (acwr > 1.3) fresh -= 8;
  // Indoor: a parità di TSS il cuore lavora di più (caldo, nessuna pausa)
  const indoorHard = acts.filter(a => a.indoor && a.date >= t - 2 * D && (a.tss || 0) >= 60).length;
  if (indoorHard) fresh -= 4 * indoorHard;
  res.fresh = clamp(fresh);
  notes.fresh = `Forma ${Math.round(tsb)} · ACWR ${acwr.toFixed(2)}${indoorHard ? ` · ${indoorHard} indoor intens${indoorHard > 1 ? 'i' : 'o'} in 48 h` : ''}`;
  if (tsb < -35) caps.push({ cap: 40, why: `forma molto negativa (${Math.round(tsb)})` });
  if (acwr > 1.8) caps.push({ cap: 45, why: `carico recente quasi doppio della fitness (ACWR ${acwr.toFixed(2)})` });

  // ---------- ❤️ Recupero fisiologico: HRV e FC a riposo rispetto alla tua media ----------
  const last = well.filter(w => w.date >= t - D);
  const todayW = last[last.length - 1] || null;
  // Valori plausibili: la FC "a riposo" sopra 90 bpm non è una misura a riposo (dati vecchi senza orologio di notte)
  const ok = (k, v) => v > 0 && (k !== 'restingHR' || (v >= 30 && v <= 90));
  const base = (k, days) => well.filter(w => w.date >= t - days * D && ok(k, w[k])).map(w => w[k]);
  const parts = [], bodyNotes = [];
  // HRV: l'Apple Watch misura l'SDNN, che oscilla molto da una notte all'altra. Come negli studi
  // (Plews et al.) si usa la MEDIA MOBILE DI 7 GIORNI del logaritmo, confrontata con la tua media
  // di 60 giorni: dentro ±0,5 deviazioni standard sei nella tua norma. La notte singola pesa poco.
  const hb = well.filter(w => w.date >= t - 60 * D && ok('hrv', w.hrv)).map(w => Math.log(w.hrv));
  const h7 = well.filter(w => w.date > t - 7 * D && ok('hrv', w.hrv)).map(w => Math.log(w.hrv));
  if (hb.length >= 7 && h7.length >= 3) {
    const mB = avg(hb), sB = sd(hb) || 0.1, m7 = avg(h7);
    const z = (m7 - mB) / sB;
    let sc = clamp(70 + z * 20); // nella fascia normale (±0,5) → 60–80
    const dev = Math.exp(m7 - mB) - 1;
    bodyNotes.push(`HRV 7 gg ${Math.round(Math.exp(m7))} (${dev >= 0 ? '+' : ''}${Math.round(dev * 100)}%${Math.abs(z) <= 0.5 ? ', nella norma' : z < 0 ? ', sotto la norma' : ', sopra la norma'})`);
    // Notte singola molto sotto la propria media di 7 giorni: solo un piccolo segnale
    if (todayW && ok('hrv', todayW.hrv) && Math.log(todayW.hrv) < m7 - sB) { sc -= 5; bodyNotes.push(`stanotte HRV bassa (${Math.round(todayW.hrv)})`); }
    parts.push(clamp(sc));
    // Taglio solo se il calo è confermato dalla media dei 7 giorni
    if (z < -1.5) caps.push({ cap: 45, why: `HRV media 7 gg ${Math.round(-dev * 100)}% sotto la tua norma` });
  }
  // FC a riposo: anche qui media di 7 giorni contro la media di 60
  const rb = base('restingHR', 60);
  const r7 = well.filter(w => w.date > t - 7 * D && ok('restingHR', w.restingHR)).map(w => w.restingHR);
  if (rb.length >= 7 && r7.length >= 3) {
    const d = avg(r7) - avg(rb);
    parts.push(clamp(80 - d * 8));
    bodyNotes.push(`FC riposo 7 gg ${Math.round(avg(r7))} (${d >= 0 ? '+' : ''}${d.toFixed(1)})`);
  }
  res.body = parts.length ? avg(parts) : null;
  notes.body = bodyNotes.join(' · ') || 'Nessun dato di HRV o FC a riposo recente';

  // ---------- 😴 Sonno: stanotte e media delle ultime 3 notti ----------
  const sl = h => clamp((h - 4) / (7.5 - 4) * 100);
  const sleeps = well.filter(w => w.date > t - 3 * D && w.sleepSecs > 0);
  if (todayW?.sleepSecs) {
    const h = todayW.sleepSecs / 3600, h3 = avg(sleeps.map(w => w.sleepSecs / 3600)) || h;
    res.sleep = 0.6 * sl(h) + 0.4 * sl(h3);
    notes.sleep = `Stanotte ${h.toFixed(1)} h · media 3 notti ${h3.toFixed(1)} h`;
    if (h < 5) caps.push({ cap: 50, why: `solo ${h.toFixed(1)} h di sonno` });
  } else { res.sleep = null; notes.sleep = 'Nessun dato di sonno per stanotte'; }

  // ---------- 📊 Equilibrio del carico ----------
  const loads = n => pmc.slice(Math.max(0, idx - n + 1), idx + 1).map(d => d.load || 0);
  let load = 100; const loadNotes = [];
  const ramp = pmc[idx].ctl - pmc[Math.max(0, idx - 7)].ctl;
  if (ramp > 8) { load -= 35; loadNotes.push(`fitness +${ramp.toFixed(1)} in 7 gg`); } else if (ramp > 5) { load -= 15; loadNotes.push(`fitness +${ramp.toFixed(1)} in 7 gg`); }
  const l7 = loads(7), m7 = avg(l7), s7 = sd(l7);
  const mono = s7 ? m7 / s7 : 0;
  if (mono > 2) { load -= 20; loadNotes.push(`monotonia ${mono.toFixed(1)}`); } else if (mono > 1.5) load -= 8;
  let streak = 0;
  for (let i = idx; i >= 0 && (pmc[i].load || 0) > 0; i--) streak++;
  if (streak >= 6) { load -= 20; loadNotes.push(`${streak} giorni senza riposo`); } else if (streak >= 4) load -= 5;
  const wk = l7.reduce((s, x) => s + x, 0);
  const prev4 = [1, 2, 3, 4].map(k => loads(7 * (k + 1)).slice(0, 7).reduce((s, x) => s + x, 0));
  const a4 = avg(prev4);
  if (a4 && wk > a4 * 1.5) { load -= 15; loadNotes.push(`settimana +${Math.round((wk / a4 - 1) * 100)}%`); }
  res.load = clamp(load);
  notes.load = loadNotes.join(' · ') || 'Carico sostenibile';

  // ---------- 🎯 Qualità dell'allenamento ----------
  const recent = acts.filter(a => a.date >= t - 28 * D);
  if (recent.length >= 3) {
    let q = 100; const qn = [];
    const z = [0, 0, 0, 0, 0, 0, 0];
    recent.forEach(a => (a.zones || []).forEach((s, i) => (z[i] += s)));
    const zt = z.reduce((s, x) => s + x, 0);
    if (zt) {
      const mid = (z[2] + z[3]) / zt;
      q -= Math.max(0, mid - 0.25) * 150; // troppo tempo in "zona grigia"
      qn.push(`${Math.round(mid * 100)}% in Z3–Z4`);
    }
    const ind = recent.filter(a => a.indoor).length / recent.length;
    if (recent.length >= 4 && (ind > 0.9 || ind < 0.1)) q -= 10;
    qn.push(`${Math.round(ind * 100)}% indoor`);
    // Disaccoppiamento delle uscite di fondo (costanti, oltre 1 ora): sotto il 5% = buona resistenza
    const steady = recent.filter(a => a.decoupling != null && (a.movingTime || 0) >= 3600 && (a.ifactor ?? 1) < 0.8);
    const dec = avg(steady.map(a => Math.abs(a.decoupling)));
    if (dec != null) { if (dec > 8) q -= 20; else if (dec > 5) q -= 10; qn.push(`disaccoppiamento ${dec.toFixed(1)}%`); }
    const hard = acts.filter(a => a.date >= t - 7 * D && (a.ifactor ?? 0) >= 0.85).length;
    if (hard === 0) q -= 10; else if (hard >= 3) q -= 15;
    res.quality = clamp(q);
    notes.quality = qn.join(' · ');
  } else { res.quality = null; notes.quality = 'Poche uscite recenti'; }

  // ---------- Punteggio finale ----------
  const avail = PILLARS.filter(p => res[p.key] != null);
  const wsum = avail.reduce((s, p) => s + p.weight, 0);
  let score = avail.reduce((s, p) => s + res[p.key] * p.weight, 0) / wsum;
  const raw = score;
  const cap = caps.length ? Math.min(...caps.map(c => c.cap)) : 100;
  score = Math.round(Math.min(score, cap));

  const pillars = PILLARS.map(p => ({ ...p, score: res[p.key] == null ? null : Math.round(res[p.key]), note: notes[p.key] }));
  const weakest = pillars.filter(p => p.score != null).sort((a, b) => a.score - b.score)[0];
  const lvl = levelOf(score);
  let sentence = `${lvl.name}: ${lvl.advice}.`;
  if (cap < raw) sentence += ` Limitato da ${caps.find(c => c.cap === cap).why}.`;
  else if (weakest && weakest.score < 60) sentence += ` Punto debole: ${weakest.name.toLowerCase()} (${weakest.note}).`;

  // Contributo di ogni pilastro al punteggio (pesi ridistribuiti): la somma fa il punteggio prima dei limiti
  const contrib = Object.fromEntries(PILLARS.map(p => [p.key, res[p.key] == null ? 0 : res[p.key] * p.weight / wsum]));
  return { date: t, score, raw: Math.round(raw), level: lvl, pillars, caps, coverage: avail.length, sentence, contrib };
}

// Andamento degli ultimi `days` giorni
export function readinessHistory(args, days = 30) {
  const out = [];
  for (let i = Math.max(7, args.pmc.length - days); i < args.pmc.length; i++) {
    const r = computeReadiness({ ...args, day: args.pmc[i].date });
    if (r) out.push({ date: r.date, score: r.score, contrib: r.contrib });
  }
  return out;
}
