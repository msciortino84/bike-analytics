import { parseFit } from './fit.js';
import { analyzeRecords, pmc, CURVE_DURATIONS, POWER_ZONES, startOfDay, bestEfforts, normalizedPower, powerZones } from './metrics.js';
import { fetchAthlete, fetchActivities, fetchEvents, fetchPowerCurve, fetchWellness, fetchStreams, createWorkout } from './intervals.js';
import { wellnessStatus, suggestWorkout } from './advice.js';
import { structuredAdvice } from './coach.js';
import { renderCalendar, renderEventDetail } from './calendar.js';
import { fuelPlan, fuelHtml } from './fuel.js';

// ---------- Archivio locale (IndexedDB) ----------
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('bike-analytics', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('activities', { keyPath: 'id' });
    r.result.createObjectStore('kv');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const getAll = () => req(tx('activities').getAll());
const putAct = a => req(tx('activities', 'readwrite').put(a));
const delAct = id => req(tx('activities', 'readwrite').delete(id));
const kvGet = k => req(tx('kv').get(k));
const kvSet = (k, v) => req(tx('kv', 'readwrite').put(v, k));

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('settings')) || {}; } catch { return {}; }
}
// Le impostazioni vengono salvate in due posti (localStorage e IndexedDB):
// se il browser ne svuota uno, si recuperano dall'altro.
function saveSettings(s) {
  try { localStorage.setItem('settings', JSON.stringify(s)); } catch {}
  kvSet('settings', s).catch(() => {});
}
let settings = loadSettings();
if (!settings.apiKey) {
  const saved = await kvGet('settings').catch(() => null);
  if (saved?.apiKey) { settings = { ...saved, ...settings, apiKey: saved.apiKey, athleteId: settings.athleteId || saved.athleteId }; saveSettings(settings); }
}
// Chiede al browser di non cancellare i dati dell'app quando serve spazio.
navigator.storage?.persist?.().catch(() => {});

// ---------- Utility ----------
const $ = id => document.getElementById(id);
const status = msg => ($('status').textContent = msg || '');
const fmtDur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}'`; };
const fmtDate = t => new Date(t).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const charts = {};
function chart(id, cfg) {
  charts[id]?.destroy();
  // Senza asse esplicito Chart.js può mettere le serie sull'asse destro (y2): forziamo 'y'.
  cfg.data.datasets.forEach(d => { d.yAxisID ??= 'y'; });
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--line');
  charts[id] = new Chart($(id), { ...cfg, options: { responsive: true, maintainAspectRatio: false, animation: false, ...cfg.options } });
}

// ---------- Navigazione ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
});

// ---------- Impostazioni ----------
function fillSettings() {
  for (const k of ['athleteId', 'apiKey', 'proxyUrl', 'ftp', 'lthr', 'weight']) $(k).value = settings[k] ?? '';
}
function storeLogin() {
  settings = { ...settings, athleteId: $('athleteId').value.trim(), apiKey: $('apiKey').value.trim(), proxyUrl: $('proxyUrl').value.trim() };
  saveSettings(settings);
}
// Invio del form: il browser lo vede come un accesso e propone di salvare la password.
$('loginForm').addEventListener('submit', e => {
  e.preventDefault();
  storeLogin();
  if (!settings.apiKey) { status('Inserisci la chiave API.'); return; }
  document.querySelector('[data-tab=dash]').click();
  $('syncBtn').click();
});
// Salvataggio automatico appena scrivi (anche quando il portachiavi compila i campi).
for (const k of ['athleteId', 'apiKey', 'proxyUrl']) $(k).addEventListener('change', storeLogin);
$('saveThresholds').onclick = () => {
  settings = { ...settings, ftp: +$('ftp').value || null, lthr: +$('lthr').value || null, weight: +$('weight').value || null };
  saveSettings(settings); status('Soglie salvate.'); render();
};
$('exportBtn').onclick = async () => {
  const blob = new Blob([JSON.stringify(await getAll())], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `bike-storico-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
};
$('clearBtn').onclick = async () => {
  if (!confirm('Cancellare tutte le attività salvate su questo dispositivo?')) return;
  await req(tx('activities', 'readwrite').clear()); render();
};

// ---------- Sincronizzazione intervals.icu ----------
let syncing = false;
$('syncBtn').onclick = () => sync();
async function sync({ auto = false } = {}) {
  if (syncing) return;
  if (!settings.apiKey) {
    if (!auto) { status('Inserisci la chiave API in Impostazioni.'); document.querySelector('[data-tab=set]').click(); }
    return;
  }
  syncing = true;
  $('syncBtn').disabled = true;
  try {
    status(auto ? 'Aggiornamento automatico da intervals…' : 'Sincronizzazione in corso…');
    curveCache.clear();
    const ath = await fetchAthlete(settings);
    settings = { ...settings, ftp: ath.ftp || settings.ftp, lthr: ath.lthr || settings.lthr, weight: ath.weight || settings.weight,
      hrZoneNames: ath.hrZoneNames || settings.hrZoneNames, hrZones: ath.hrZones || settings.hrZones };
    saveSettings(settings); fillSettings();
    const [acts, events, curve] = await Promise.all([fetchActivities(settings, 1100), fetchEvents(settings), fetchPowerCurve(settings)]);
    // Mantiene gli stream già scaricati per il dettaglio, così non vanno riscaricati.
    const prev = new Map((await getAll()).map(a => [a.id, a]));
    for (const a of acts) await putAct(prev.get(a.id)?.streams ? { ...a, streams: prev.get(a.id).streams } : a);
    await kvSet('events', events);
    await kvSet('curve', curve);
    await kvSet('wellness', await fetchWellness(settings, 1100).catch(() => []));
    await kvSet('lastSync', Date.now());
    status(`Aggiornato alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} · ${acts.length} uscite, ${events.length} eventi.`);
    render();
  } catch (e) {
    status(e instanceof TypeError
      ? (auto ? 'Offline: mostro i dati salvati.' : 'Connessione bloccata dal browser (CORS) o rete assente. Serve il proxy: vedi README.')
      : e.message);
  } finally {
    syncing = false;
    $('syncBtn').disabled = false;
  }
}

// Sincronizzazione automatica: all'apertura e quando l'app torna in primo piano (es. iPhone),
// se l'ultimo aggiornamento ha più di 10 minuti.
async function autoSync() {
  const lastSync = (await kvGet('lastSync')) || 0;
  if (navigator.onLine !== false && Date.now() - lastSync > 10 * 60 * 1000) sync({ auto: true });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoSync(); });

// ---------- Caricamento file ----------
async function importFiles(files) {
  let ok = 0;
  for (const f of files) {
    try {
      if (/\.fit$/i.test(f.name)) {
        const { records, session } = parseFit(await f.arrayBuffer());
        const a = analyzeRecords(records, session, settings);
        const t0 = records.find(r => r.t)?.t ?? 0;
        const rs = records.filter(r => r.t);
        const streams = {
          time: rs.map(r => Math.round((r.t - t0) / 1000)), power: rs.map(r => r.power), hr: rs.map(r => r.hr),
          alt: rs.map(r => r.alt), dist: rs.map(r => r.dist), cad: rs.map(r => r.cad),
          lat: rs.map(r => r.lat), lng: rs.map(r => r.lng), v: 2,
        };
        await putAct({ ...a, id: 'fit-' + a.date, source: 'fit', name: f.name.replace(/\.fit$/i, ''), streams });
        ok++;
      } else if (/\.json$/i.test(f.name)) {
        const data = JSON.parse(await f.text());
        for (const a of Array.isArray(data) ? data : [data]) { await putAct(normalizeJson(a)); ok++; }
      }
    } catch (e) { status(`Errore in ${f.name}: ${e.message}`); }
  }
  if (ok) status(`Importate ${ok} attività.`);
  render();
}
// Accetta sia l'export di questa app sia oggetti stile Strava/intervals.
function normalizeJson(a) {
  if (a.id && a.date && 'tss' in a) return a;
  const date = new Date(a.start_date_local || a.start_date || a.date).getTime();
  const np = a.weighted_average_watts ?? a.icu_weighted_avg_watts ?? null;
  const movingTime = a.moving_time ?? a.elapsed_time ?? 0;
  let tss = a.icu_training_load ?? a.tss ?? null;
  if (tss == null && np && settings.ftp) tss = Math.round(movingTime * np * (np / settings.ftp) / (settings.ftp * 36));
  return {
    id: 'json-' + (a.id ?? date), source: 'json', name: a.name || 'Uscita', date, movingTime,
    distance: a.distance ?? 0, ascent: a.total_elevation_gain ?? 0,
    avgPower: a.average_watts ?? a.icu_average_watts ?? null, np, avgHr: a.average_heartrate ?? null,
    tss, ifactor: np && settings.ftp ? +(np / settings.ftp).toFixed(2) : null, curve: {}, zones: [],
  };
}
$('fileInput').onchange = e => importFiles([...e.target.files]);
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); importFiles([...e.dataTransfer.files]); };

// ---------- Tema chiaro / scuro / automatico ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#111418' : '#f4f5f7');
}
const savedTheme = (() => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } })();
applyTheme(savedTheme);
document.querySelectorAll('input[name=theme]').forEach(r => {
  r.checked = r.value === savedTheme;
  r.onchange = () => {
    try { localStorage.setItem('theme', r.value); } catch {}
    applyTheme(r.value);
    render(); // i grafici prendono i colori del tema al momento del disegno
  };
});
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  applyTheme((() => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } })());
  render();
});

// Ordine del calendario (Impostazioni)
document.querySelectorAll('input[name=calOrder]').forEach(r => {
  r.checked = r.value === (settings.calOrder || 'asc');
  r.onchange = () => { settings = { ...settings, calOrder: r.value }; saveSettings(settings); render(); };
});

// ---------- Schede attività ----------
const ZONE_COLORS = ['#8891a0', '#2f6fde', '#1f9d55', '#d98a00', '#e0662b', '#d64545', '#7b3fbf'];
const cleanName = n => String(n || '').replace(/^(MyWhoosh\s*-\s*)?\d{4}-\d{2}-\d{2}\s*-?\s*/, (m, p) => (p ? 'MyWhoosh · ' : ''));

function activityCards(list, all, R) {
  // Media delle 20 uscite precedenti: base per le frecce ▲▼
  const asc = [...all].sort((a, b) => a.date - b.date);
  const base = new Map();
  const KEYS = ['movingTime', 'distance', 'ascent', 'tss', 'np', 'avgHr'];
  for (let i = 0; i < asc.length; i++) {
    const prev = asc.slice(Math.max(0, i - 20), i);
    const avg = {};
    for (const k of KEYS) { const v = prev.map(a => a[k]).filter(x => x > 0); avg[k] = v.length >= 5 ? v.reduce((s, x) => s + x, 0) / v.length : null; }
    base.set(asc[i].id, avg);
  }
  // Record: il migliore dell'anno solare e degli ultimi 90 giorni
  const badges = new Map();
  const award = (pool, key, text) => {
    const top = pool.filter(a => a[key] > 0).reduce((m, a) => (!m || a[key] > m[key] ? a : m), null);
    if (top) (badges.get(top.id) || badges.set(top.id, []).get(top.id)).push(text);
  };
  // I record seguono il periodo scelto nella dashboard (Dal/Al)
  const pool = all.filter(a => a.date >= R.from && a.date < R.to + 864e5);
  const per = { '4w': '4 sett', '3m': '3 mesi', '6m': '6 mesi', '1y': '12 mesi', ytd: String(new Date().getFullYear()), all: 'di sempre' }[range.preset] || 'periodo';
  if (pool.length > 1) {
    award(pool, 'distance', ['📏', 'km', `Uscita più lunga · ${per}`]);
    award(pool, 'ascent', ['⛰️', 'D+', `Più dislivello · ${per}`]);
    award(pool, 'movingTime', ['⏱️', 'ore', `Più tempo in sella · ${per}`]);
    award(pool, 'tss', ['🔥', 'TSS', `Carico più alto · ${per}`]);
    award(pool, 'np', ['⚡', 'NP', `NP più alta · ${per}`]);
  }

  const arrow = (v, b, unit = '') => {
    if (!v || !b) return '';
    const d = (v - b) / b;
    if (Math.abs(d) < 0.15) return '';
    return `<i class="${d > 0 ? 'up' : 'down'}" title="${d > 0 ? '+' : ''}${Math.round(d * 100)}% rispetto alla media delle ultime 20 uscite${unit}">${d > 0 ? '▲' : '▼'}</i>`;
  };
  let html = '', curMonth = '';
  const monthStats = {};
  for (const a of list) {
    const k = new Date(a.date).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    (monthStats[k] ||= { n: 0, km: 0, h: 0 }); monthStats[k].n++; monthStats[k].km += (a.distance || 0) / 1000; monthStats[k].h += a.movingTime || 0;
  }
  for (const a of list) {
    const m = new Date(a.date).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    if (m !== curMonth) {
      if (curMonth) html += '</div>';
      const st = monthStats[m];
      html += `<div class="act-month"><b>${m}</b><span>${st.n} uscite · ${Math.round(st.km)} km · ${fmtDur(st.h)}</span></div><div class="act-grid">`;
      curMonth = m;
    }
    const b = base.get(a.id) || {};
    const zt = (a.zones || []).reduce((s, x) => s + x, 0);
    const metric = (label, val, key, cls) => val ? `<div class="am ${cls}"><b>${val}${arrow(a[key], b[key])}</b><span>${label}</span></div>` : '';
    const bd = badges.get(a.id) || [];
    const d = new Date(a.date);
    html += `<div class="act-card click${bd.length ? ' star' : ''}" data-open="${a.id}">
      <div class="ac-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('it-IT', { weekday: 'short' })}</span></div>
      <div class="ac-body">
        <div class="ac-title">${esc(cleanName(a.name))}<button class="ac-del" data-del="${a.id}" title="Elimina dallo storico locale" aria-label="Elimina">✕</button></div>
        ${bd.length ? `<div class="ac-badges">${bd.map(([ic, w, t]) => `<span class="tip" data-tip="${t}">${ic} ${w}</span>`).join('')}</div>` : ''}
        <div class="ac-metrics">
          ${metric('durata', fmtDur(a.movingTime), 'movingTime', 'c-time')}
          ${metric('km', (a.distance / 1000).toFixed(1), 'distance', 'c-time')}
          ${metric('D+', a.ascent ? Math.round(a.ascent) + ' m' : '', 'ascent', 'c-time')}
          ${metric('TSS', a.tss, 'tss', 'c-load')}
          ${metric('NP', a.np ? a.np + ' W' : '', 'np', 'c-power')}
          ${metric('FC', a.avgHr ? a.avgHr + ' bpm' : '', 'avgHr', 'c-hr')}
        </div>
        ${zt ? `<div class="ac-zones" title="Tempo nelle zone di potenza">${a.zones.map((s, i) => s ? `<i style="flex:${s};background:${ZONE_COLORS[i]}"></i>` : '').join('')}</div>` : ''}
      </div>
    </div>`;
  }
  return html + '</div>';
}

// ---------- Grafici a disco ----------
const HR_COLORS = ['#8891a0', '#2f6fde', '#1f9d55', '#e2b008', '#e0662b', '#d64545', '#7b3fbf'];
const RADAR_SECS = [15, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600];
const RADAR_GROUPS = [ // archi colorati esterni, come i "livelli di potenza"
  { from: 0, to: 2, color: '#1f6fd6', name: 'Sprint' },
  { from: 3, to: 6, color: '#4ea52a', name: 'VO2max' },
  { from: 7, to: 11, color: '#f07a2d', name: 'Soglia' },
];
const secLbl = s => (s < 60 ? `${s}s` : `${s / 60} m`);
const radarArcs = {
  id: 'radarArcs',
  afterDatasetsDraw(c) { // prima del tooltip, così il fumetto resta sopra gli archi
    const sc = c.scales.r, n = c.data.labels.length;
    if (!sc || !c.options.plugins.radarArcs?.groups) return;
    const { ctx } = c, step = (Math.PI * 2) / n, r = sc.drawingArea + 14;
    for (const g of c.options.plugins.radarArcs.groups) {
      const a0 = sc.getIndexAngle(g.from) - Math.PI / 2 - step / 2 + 0.02;
      const a1 = sc.getIndexAngle(g.to) - Math.PI / 2 + step / 2 - 0.02;
      ctx.save(); ctx.beginPath(); ctx.arc(sc.xCenter, sc.yCenter, r, a0, a1);
      ctx.strokeStyle = g.color; ctx.lineWidth = 12; ctx.lineCap = 'butt'; ctx.stroke(); ctx.restore();
    }
  },
};

async function drawRadars(R, ra, acts) {
  // Potenza: periodo vs di sempre, ogni asse in % del tuo record assoluto per quella durata
  let allC = null, perC = null;
  if (settings.apiKey) {
    if (!curveCache.has('all')) curveCache.set('all', fetchPowerCurve(settings, 'all').catch(() => ({})));
    [allC, perC] = await Promise.all([curveCache.get('all'), curveForRange(R)]);
  }
  const best = (c, s) => (c?.[s] || 0);
  const allV = RADAR_SECS.map(s => Math.max(best(allC, s), ...acts.map(a => a.curve?.[s] || 0)));
  const perV = RADAR_SECS.map(s => Math.max(best(perC, s), ...ra.map(a => a.curve?.[s] || 0)));
  const pct = (v, i) => (allV[i] ? Math.round(v / allV[i] * 100) : 0);
  chart('radarPower', {
    type: 'radar',
    data: { labels: RADAR_SECS.map(secLbl), datasets: [
      { label: 'Di sempre', data: allV.map(pct), backgroundColor: '#9b5de5cc', borderColor: '#7b3fbf', borderWidth: 1, pointRadius: 0, order: 2 },
      { label: 'Periodo', data: perV.map(pct), backgroundColor: '#f6a8deee', borderColor: '#d96ac0', borderWidth: 1, pointRadius: 2, pointBackgroundColor: '#fff', order: 1 }, // order basso = disegnato sopra
    ] },
    options: {
      layout: { padding: 6 },
      scales: { r: { min: 0, max: 100, ticks: { display: false, stepCount: 5 }, angleLines: { color: css('--line') }, grid: { color: css('--line') },
        pointLabels: { padding: 22, font: { size: 11, weight: '600' }, color: css('--text'),
          callback: (l, i) => [l, perV[i] ? `${perV[i]} W` : '–'] } } },
      plugins: {
        radarArcs: { groups: RADAR_GROUPS },
        tooltip: { callbacks: { label: t => `${t.dataset.label}: ${t.datasetIndex ? perV[t.dataIndex] : allV[t.dataIndex]} W (${t.raw}% del record)` } },
      },
    },
    plugins: [radarArcs],
  });

  // Cuore: ore per zona nel periodo vs il periodo precedente della stessa durata
  const len = R.to - R.from + 864e5;
  const prev = acts.filter(a => a.date >= R.from - len && a.date < R.from);
  const zoneHours = list => {
    const z = [];
    list.forEach(a => (a.hrZones || []).forEach((s, i) => (z[i] = (z[i] || 0) + s)));
    return z.map(x => +(x / 3600).toFixed(1));
  };
  const zc = zoneHours(ra), zp = zoneHours(prev);
  const nZ = Math.max(zc.length, zp.length, 5);
  const names = settings.hrZoneNames || [];
  const lims = settings.hrZones || [];
  const IT = { Recovery: 'Recupero', Aerobic: 'Aerobico', Tempo: 'Tempo', SubThreshold: 'Sotto soglia', SuperThreshold: 'Sopra soglia', 'Aerobic Capacity': 'Cap. aerobica', Anaerobic: 'Anaerobico' };
  const tot = zc.reduce((s, x) => s + (x || 0), 0) || 1;
  chart('radarHr', {
    type: 'radar',
    data: { labels: Array.from({ length: nZ }, (_, i) => `Z${i + 1} ${IT[names[i]] || names[i] || ''}`.trim()), datasets: [
      { order: 2, label: 'Periodo precedente', data: Array.from({ length: nZ }, (_, i) => Math.sqrt(zp[i] || 0)), backgroundColor: '#8891a044', borderColor: '#8891a0', borderWidth: 1, borderDash: [4, 3], pointRadius: 0 },
      { label: 'Periodo', data: Array.from({ length: nZ }, (_, i) => Math.sqrt(zc[i] || 0)), backgroundColor: '#ef6b6b99', borderColor: '#d64545', borderWidth: 1.5,
        pointRadius: 5, pointBorderColor: '#fff', pointBorderWidth: 1.5, pointBackgroundColor: HR_COLORS.slice(0, nZ) },
    ] },
    options: {
      layout: { padding: 6 },
      scales: { r: { min: 0, ticks: { display: false }, angleLines: { color: css('--line') }, grid: { color: css('--line') },
        pointLabels: { padding: 24, font: { size: 11, weight: '700' }, color: c => HR_COLORS[c.index] || css('--text'),
          // Su telefono solo sigla e ore, il nome della fascia resta nel fumetto
          callback: (l, i) => (innerWidth < 700 ? [`Z${i + 1}`, `${zc[i] || 0} h`] : [l, `${zc[i] || 0} h · ${Math.round((zc[i] || 0) / tot * 100)}%`]) } } },
      // Raggio = radice delle ore: la Z1 (molte ore) non schiaccia le zone alte
      plugins: {
        // Un arco colorato per ogni fascia cardiaca
        radarArcs: { groups: Array.from({ length: nZ }, (_, i) => ({ from: i, to: i, color: HR_COLORS[i] })) },
        tooltip: { callbacks: { title: t => t[0].label, label: t => `${t.dataset.label}: ${(t.datasetIndex ? zc : zp)[t.dataIndex] || 0} h${lims[t.dataIndex] ? ` (fino a ${lims[t.dataIndex]} bpm)` : ''}` } },
      },
    },
    plugins: [radarArcs],
  });
}

// ---------- Progresso annuale ----------
function yearProgress(acts) {
  const now = new Date(), y = now.getFullYear();
  const startY = new Date(y, 0, 1).getTime(), startPrev = new Date(y - 1, 0, 1).getTime();
  const dayOfYear = Math.floor((startOfDay(now.getTime()) - startY) / 864e5) + 1;
  const sameDayPrev = startPrev + dayOfYear * 864e5; // stessa data dell'anno scorso
  const tot = list => ({ km: list.reduce((s, a) => s + (a.distance || 0), 0) / 1000, h: list.reduce((s, a) => s + (a.movingTime || 0), 0),
    up: list.reduce((s, a) => s + (a.ascent || 0), 0), n: list.length, tss: list.reduce((s, a) => s + (a.tss || 0), 0) });
  const cur = tot(acts.filter(a => a.date >= startY));
  const prevYtd = tot(acts.filter(a => a.date >= startPrev && a.date < sameDayPrev));
  const prevAll = tot(acts.filter(a => a.date >= startPrev && a.date < startY));
  const goal = settings.yearGoal || Math.round(prevAll.km / 100) * 100 || 5000;
  const daysInYear = (new Date(y + 1, 0, 1) - startY) / 864e5;
  const pace = goal * dayOfYear / daysInYear;
  const diff = cur.km - pace;
  const pct = x => Math.min(100, (x / goal) * 100);
  const delta = (a, b, fmt) => {
    if (!b) return '';
    const d = (a - b) / b;
    return `<span class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(d * 100))}%</span><small>${y - 1}: ${fmt(b)}</small>`;
  };
  const fmtKm = v => `${Math.round(v).toLocaleString('it-IT')} km`;
  const fmtUp = v => `${Math.round(v).toLocaleString('it-IT')} m`;
  $('yearCard').innerHTML = `
    <div class="yp-head"><h2>Quest'anno · ${y}</h2>
      <button class="yp-goal" id="ypGoal" title="Cambia obiettivo">🎯 obiettivo ${goal.toLocaleString('it-IT')} km</button></div>
    <div class="yp-main"><b>${cur.km.toLocaleString('it-IT', { maximumFractionDigits: 1 })} km</b><span>/ ${goal.toLocaleString('it-IT')} km</span></div>
    <div class="yp-bar">
      <div class="yp-prev" style="width:${pct(prevYtd.km)}%" title="${y - 1} alla stessa data: ${fmtKm(prevYtd.km)}"></div>
      <div class="yp-fill" style="width:${pct(cur.km)}%"></div>
      <div class="yp-today" style="left:${pct(pace)}%"><span>OGGI</span></div>
    </div>
    <div class="yp-pace ${diff >= 0 ? 'pos' : 'neg'}">${Math.abs(diff).toLocaleString('it-IT', { maximumFractionDigits: 1 })} km ${diff >= 0 ? 'in più' : 'in meno'} rispetto al passo</div>
    <div class="yp-cmp">
      <div><span>Km</span><b>${fmtKm(cur.km)}</b>${delta(cur.km, prevYtd.km, fmtKm)}</div>
      <div><span>Ore</span><b>${fmtDur(cur.h)}</b>${delta(cur.h, prevYtd.h, fmtDur)}</div>
      <div><span>Dislivello</span><b>${fmtUp(cur.up)}</b>${delta(cur.up, prevYtd.up, fmtUp)}</div>
      <div><span>Uscite</span><b>${cur.n}</b>${delta(cur.n, prevYtd.n, v => v)}</div>
    </div>
    <div class="hint">Confronto con il ${y - 1} alla stessa data (${new Date(sameDayPrev - 864e5).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}). La barra chiara è dove eri l'anno scorso.</div>
    <div class="chart small"><canvas id="ypChart"></canvas></div>`;
  $('ypGoal').onclick = () => {
    const v = prompt('Obiettivo km per quest\'anno:', goal);
    if (v && +v > 0) { settings = { ...settings, yearGoal: Math.round(+v) }; saveSettings(settings); render(); }
  };
  // Km progressivi giorno per giorno: quest'anno vs anno scorso
  const cum = (from, days) => {
    const byDay = new Array(days).fill(0);
    for (const a of acts) { const i = Math.floor((startOfDay(a.date) - from) / 864e5); if (i >= 0 && i < days) byDay[i] += (a.distance || 0) / 1000; }
    let s = 0; return byDay.map(v => Math.round((s += v)));
  };
  const prevDays = Math.round((startY - startPrev) / 864e5);
  const labels = Array.from({ length: prevDays }, (_, i) => new Date(startY + i * 864e5).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }));
  const curCum = cum(startY, dayOfYear);
  chart('ypChart', {
    type: 'line',
    data: { labels, datasets: [
      { label: String(y), data: curCum, borderColor: '#2bb5c4', backgroundColor: '#2bb5c422', fill: true, pointRadius: 0, borderWidth: 2.5 },
      { label: String(y - 1), data: cum(startPrev, prevDays), borderColor: '#8891a0', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 },
      { label: 'Passo obiettivo', data: labels.map((_, i) => Math.round(goal * (i + 1) / daysInYear)), borderColor: '#d98a0088', pointRadius: 0, borderWidth: 1 },
    ] },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 12 } } } },
  });
}

// ---------- Intervallo di date della dashboard ----------
const PRESETS = { '4w': 28, '3m': 91, '6m': 182, '1y': 365, ytd: 'ytd', all: 'all' };
const isoDay = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let range = (() => { try { return JSON.parse(localStorage.getItem('range')) || { preset: '3m' }; } catch { return { preset: '3m' }; } })();
let firstActDate = null;

function getRange() {
  const today = startOfDay(Date.now());
  const pr = PRESETS[range.preset];
  if (pr === 'ytd') return { from: new Date(new Date().getFullYear(), 0, 1).getTime(), to: today };
  if (pr === 'all') return { from: firstActDate ?? today - 365 * 864e5, to: today };
  if (pr) return { from: today - (pr - 1) * 864e5, to: today };
  const from = startOfDay(new Date(range.from + 'T12:00').getTime()), to = startOfDay(new Date(range.to + 'T12:00').getTime());
  return from <= to ? { from, to } : { from: to, to: from };
}
function setRange(r) {
  range = r;
  try { localStorage.setItem('range', JSON.stringify(r)); } catch {}
  syncRangeUi();
  render();
}
function syncRangeUi() {
  const R = getRange();
  $('rangeFrom').value = isoDay(R.from);
  $('rangeTo').value = isoDay(R.to);
  document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('on', b.dataset.range === range.preset));
}
document.querySelectorAll('[data-range]').forEach(b => b.onclick = () => setRange({ preset: b.dataset.range }));
for (const id of ['rangeFrom', 'rangeTo']) $(id).addEventListener('change', () => {
  if ($('rangeFrom').value && $('rangeTo').value) setRange({ preset: null, from: $('rangeFrom').value, to: $('rangeTo').value });
});

// Barra date: quando resta attaccata in alto diventa compatta (solo telefono, via CSS)
new IntersectionObserver(([e]) => {
  $('rangeBar').classList.toggle('stuck', !e.isIntersecting);
  if (e.isIntersecting) $('rangeBar').classList.remove('open');
}).observe($('rangeSentinel'));
$('rangeInfo').onclick = () => { if ($('rangeBar').classList.contains('stuck')) $('rangeBar').classList.toggle('open'); };

// Curva di potenza di intervals per l'intervallo scelto (in memoria per la sessione)
const curveCache = new Map();
async function curveForRange(R) {
  if (!settings.apiKey) return null;
  const key = `r.${isoDay(R.from)}.${isoDay(R.to)}`;
  if (!curveCache.has(key)) curveCache.set(key, fetchPowerCurve(settings, key).catch(() => ({})));
  return curveCache.get(key);
}

// ---------- Rendering ----------
async function render() {
  const acts = (await getAll()).sort((a, b) => b.date - a.date);
  firstActDate = acts.length ? startOfDay(acts[acts.length - 1].date) : null;
  syncRangeUi();
  const events = (await kvGet('events')) || [];
  const icuCurve = (await kvGet('curve')) || {};
  // Se ci sono i valori ufficiali di intervals (che includono tutti gli sport) usiamo quelli,
  // altrimenti li calcoliamo dalle uscite salvate.
  const wellness = (await kvGet('wellness')) || [];
  let p = pmc(acts, Infinity);
  if (wellness.length) {
    const ofDay = new Map(wellness.map(w => [startOfDay(w.date), w]));
    p = p.map(d => {
      const w = ofDay.get(d.date);
      return w?.ctl != null && w.atl != null ? { ...d, ctl: w.ctl, atl: w.atl, tsb: w.ctl - w.atl } : d;
    });
  }
  const last = p[p.length - 1] || { ctl: 0, atl: 0 };
  const wstat = wellnessStatus(wellness);

  // Allenamento del giorno
  const wo = suggestWorkout(p, acts, events, wstat);
  const plannedToday = events.find(e => e.category === 'WORKOUT' && startOfDay(e.date) === startOfDay(Date.now()));
  if (!acts.length) {
    $('workout').innerHTML = `<h2>Benvenuto</h2>
      <div>Per iniziare vai in <b>Impostazioni</b>, inserisci ID atleta e chiave di intervals.icu e premi <b>Accedi e sincronizza</b>.
      In alternativa carica i tuoi file .fit nella scheda Attività.</div>
      <button class="primary" onclick="document.querySelector('[data-tab=set]').click()">Vai alle impostazioni</button>`;
  } else $('workout').innerHTML = `
    <details class="wo-box">
      <summary>
        <span class="wo-k">Oggi</span>
        <span class="wo-n">${esc(wo.name)}${wo.minutes ? ` <span class="tag">${wo.minutes}'</span>` : ''}</span>
        <span class="wo-why">${esc(wo.reasons.join(', '))}</span>
        <span class="kb-more">Dettagli</span>
      </summary>
      <div class="wo-body">
        <div>${esc(wo.text)}</div>
        ${plannedToday ? `<div class="hint">In calendario oggi hai già: <b>${esc(cleanName(plannedToday.name))}</b>.</div>` : ''}
        ${wo.description ? `<pre>${esc(wo.description)}</pre>` : ''}
        ${wo.description && settings.apiKey ? `<button id="addWo" class="primary">Aggiungi al calendario di oggi su intervals</button>` : ''}
      </div>
    </details>`;
  if ($('addWo')) $('addWo').onclick = async () => {
    if (!confirm(`Aggiungere "${wo.name}" al tuo calendario intervals.icu di oggi?`)) return;
    try {
      await createWorkout(settings, { date: Date.now(), name: wo.name, description: wo.description });
      status(`"${wo.name}" aggiunto al calendario intervals. Si sincronizza su Garmin come allenamento strutturato.`);
      $('addWo').disabled = true;
    } catch (e) { status(e.message); }
  };

  // ---- Da qui in giù tutto segue l'intervallo Dal/Al scelto ----
  const R = getRange();
  const inR = t => t >= R.from && t < R.to + 864e5;
  const ra = acts.filter(a => inR(a.date));
  const pR = p.filter(d => inR(d.date));
  const end = pR[pR.length - 1] || { ctl: 0, atl: 0 };
  $('rangeInfo').textContent = `${ra.length} uscite · ${fmtDate(R.from)} → ${fmtDate(R.to)}`;

  // Wellness
  const wl = wellness.filter(w => inR(w.date)).sort((a, b) => a.date - b.date);
  $('wellCard').hidden = !wl.some(w => w.hrv || w.sleepSecs || w.restingHR);
  if (!$('wellCard').hidden) chart('wellChart', {
    type: 'line',
    data: { labels: wl.map(w => new Date(w.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })), datasets: [
      { label: 'HRV (ms)', data: wl.map(w => w.hrv), borderColor: '#1f9d55', spanGaps: true, pointRadius: 0, tension: .3 },
      { label: 'Media HRV 60 gg', data: wl.map(() => wstat.hrvBase), borderColor: '#1f9d5566', borderDash: [4, 4], pointRadius: 0 },
      { label: 'Sonno (h)', type: 'bar', data: wl.map(w => w.sleepSecs ? +(w.sleepSecs / 3600).toFixed(1) : null), backgroundColor: '#5b8ff055', yAxisID: 'y2' },
      { label: 'FC riposo', data: wl.map(w => w.restingHR), borderColor: '#d64545', spanGaps: true, pointRadius: 0, tension: .3, borderWidth: 1.5 },
    ] },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y2: { position: 'right', grid: { display: false }, min: 0, max: 12 } } },
  });

  // KPI: fitness/fatica/forma alla fine del periodo, totali del periodo
  const sum = (arr, k) => arr.reduce((s, a) => s + (a[k] || 0), 0);
  const wkg = settings.ftp && settings.weight ? (settings.ftp / settings.weight).toFixed(2) : null;
  const endLbl = R.to >= startOfDay(Date.now()) ? '' : ` al ${new Date(R.to).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`;
  $('kpis').innerHTML = [
    ['Fitness (CTL)' + endLbl, end.ctl.toFixed(0), 'fit'], ['Fatica (ATL)' + endLbl, end.atl.toFixed(0), 'fat'],
    ['Forma (TSB)' + endLbl, (end.ctl - end.atl).toFixed(0), 'form'], ['TSS periodo', sum(ra, 'tss').toFixed(0), 'load'],
    ['Ore periodo', fmtDur(sum(ra, 'movingTime')), 'time'], ['Km periodo', (sum(ra, 'distance') / 1000).toFixed(0), 'time'],
    ['Dislivello periodo', `${Math.round(sum(ra, 'ascent')).toLocaleString('it-IT')} m`, 'time'],
    ['FTP' + (wkg ? ` · ${wkg} W/kg` : ''), settings.ftp ? `${settings.ftp} W` : '–', 'power'],
  ].map(kpi).join('');
  const weekStart = startOfDay(R.to) - ((new Date(R.to).getDay() + 6) % 7) * 864e5;

  // Consigli
  // Raggruppati per area; i primi due gruppi aperti, gli altri richiudibili
  $('advice').innerHTML = structuredAdvice(acts.length ? p : [], acts, events, wstat).map((g, gi) => `
    <details class="adv-group"${gi < 2 ? ' open' : ''}><summary>${g.icon || ''} ${g.title}
      <span class="adv-dots">${g.items.map(t => `<i class="${t.level}"></i>`).join('')}</span></summary>
      <ul class="advice">${g.items.map(t => `<li class="${t.level}">${t.text}</li>`).join('')}</ul></details>`).join('');

  // PMC
  chart('pmcChart', {
    type: 'line',
    data: {
      labels: pR.map(d => new Date(d.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', ...(R.to - R.from > 300 * 864e5 ? { year: '2-digit' } : {}) })),
      datasets: [
        { label: 'Fitness', data: pR.map(d => d.ctl), borderColor: '#2f6fde', backgroundColor: '#2f6fde22', fill: true, pointRadius: 0, tension: .3 },
        { label: 'Fatica', data: pR.map(d => d.atl), borderColor: '#c2185b', pointRadius: 0, tension: .3, borderWidth: 1.5 },
        { label: 'Forma', data: pR.map(d => d.tsb), borderColor: '#d98a00', pointRadius: 0, tension: .3, borderWidth: 1.5 },
        { label: 'TSS', type: 'bar', data: pR.map(d => d.load), backgroundColor: '#8891a055', yAxisID: 'y2' },
      ],
    },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y2: { position: 'right', grid: { display: false } } } },
  });

  // Settimanale: tutte le settimane del periodo
  const weeks = [];
  const nWeeks = Math.max(1, Math.ceil((weekStart - startOfDay(R.from)) / (7 * 864e5)) + 1);
  for (let i = nWeeks - 1; i >= 0; i--) {
    const s = weekStart - i * 7 * 864e5, e = s + 7 * 864e5;
    const w = ra.filter(a => a.date >= s && a.date < e);
    weeks.push({ label: new Date(s).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }), tss: sum(w, 'tss'), h: sum(w, 'movingTime') / 3600 });
  }
  chart('weekChart', {
    type: 'bar',
    data: { labels: weeks.map(w => w.label), datasets: [
      { label: 'TSS', data: weeks.map(w => Math.round(w.tss)), backgroundColor: '#2f6fde' },
      { label: 'Ore', type: 'line', data: weeks.map(w => +w.h.toFixed(1)), borderColor: '#d98a00', yAxisID: 'y2' },
    ] },
    options: { scales: { y2: { position: 'right', grid: { display: false } } } },
  });

  // Mensile: ogni mese dell'anno dell'Al confrontato con lo stesso mese dell'anno prima (barre sovrapposte)
  const yC = new Date(R.to).getFullYear(), yP = yC - 1;
  const monthKm = y => Array.from({ length: 12 }, (_, mi) => {
    const s0 = new Date(y, mi, 1).getTime(), e0 = new Date(y, mi + 1, 1).getTime();
    const m = acts.filter(a => a.date >= s0 && a.date < e0);
    return { km: sum(m, 'distance') / 1000, up: sum(m, 'ascent'), h: sum(m, 'movingTime') / 3600 };
  });
  const mC = monthKm(yC), mP = monthKm(yP);
  const nowM = new Date().getFullYear() === yC ? new Date().getMonth() : 11;
  $('monthTitle').textContent = `Volume mensile · ${yC} vs ${yP}`;
  // Unità scelta direttamente nella scheda: km, ore o dislivello
  const mu = (() => { try { return localStorage.getItem('monthUnit') || 'km'; } catch { return 'km'; } })();
  document.querySelectorAll('#monthUnit button').forEach(b => {
    b.classList.toggle('on', b.dataset.u === mu);
    b.onclick = () => { try { localStorage.setItem('monthUnit', b.dataset.u); } catch {} render(); };
  });
  chart('monthChart', {
    type: 'bar',
    data: { labels: Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString('it-IT', { month: 'short' })), datasets: [
      { label: String(yP), data: mP.map(m => Math.round(m[mu])), backgroundColor: '#8891a055', borderColor: '#8891a0', borderWidth: 1, barPercentage: .9, categoryPercentage: .9, order: 2 },
      { label: String(yC), data: mC.map((m, i) => (i <= nowM ? Math.round(m[mu]) : null)), backgroundColor: '#1f9d55', barPercentage: .55, categoryPercentage: .9, order: 1 },
    ] },
    options: {
      scales: { x: { stacked: false }, y: { title: { display: true, text: { km: 'km', h: 'ore', up: 'metri D+' }[mu] } } },
      // Barre una sopra l'altra invece che affiancate
      datasets: { bar: { grouped: false } },
      plugins: { tooltip: { callbacks: { afterBody: items => {
        const i = items[0].dataIndex, c = mC[i], q = mP[i];
        if (!q[mu]) return `${yC}: ${Math.round(c.h)} h · ${Math.round(c.up)} m D+`;
        const d = q[mu] ? Math.round((c[mu] - q[mu]) / q[mu] * 100) : 0;
        return [`Differenza: ${d >= 0 ? '+' : ''}${d}%`, `${yC}: ${Math.round(c.h)} h · ${Math.round(c.up).toLocaleString('it-IT')} m D+`, `${yP}: ${Math.round(q.h)} h · ${Math.round(q.up).toLocaleString('it-IT')} m D+`];
      } } } },
    },
  });

  // Curva di potenza del periodo: da intervals (scaricata per l'intervallo scelto) + file FIT caricati
  const rangeCurve = await curveForRange(R);
  const curve = {};
  for (const d of CURVE_DURATIONS) {
    let best = rangeCurve?.[d] || 0;
    for (const a of ra) if (a.curve?.[d] > best) best = a.curve[d];
    if (best) curve[d] = best;
  }
  const lbl = s => (s < 60 ? `${s}s` : `${s / 60}'`);
  chart('curveChart', {
    type: 'line',
    data: { labels: Object.keys(curve).map(Number).map(lbl), datasets: [{ label: 'Watt', data: Object.values(curve), borderColor: '#7b3fbf', backgroundColor: '#7b3fbf22', fill: true, tension: .3 }] },
    options: { plugins: { legend: { display: false } } },
  });

  // Zone
  const z = new Array(POWER_ZONES.length).fill(0);
  ra.forEach(a => (a.zones || []).forEach((s, i) => (z[i] += s)));
  chart('zoneChart', {
    type: 'bar',
    data: { labels: POWER_ZONES.map(x => x.name), datasets: [{ label: 'Ore', data: z.map(s => +(s / 3600).toFixed(1)),
      backgroundColor: ['#8891a0', '#2f6fde', '#1f9d55', '#d98a00', '#e0662b', '#d64545', '#7b3fbf'] }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { y: { reverse: true } } } // Z1 in basso, Z7 in alto,
  });

  // Grafici a disco: livelli di potenza e zone cardiache del periodo
  drawRadars(R, ra, acts);

  // Progresso annuale (sempre sull'anno solare, indipendente dal periodo)
  $('yearCard').hidden = !acts.length;
  if (acts.length) yearProgress(acts);

  // Storico
  $('actList').innerHTML = acts.length ? activityCards(acts.slice(0, 300), acts, R) : '<p class="hint">Nessuna attività. Sincronizza da intervals.icu o carica un file.</p>';
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    if (confirm('Eliminare questa attività dallo storico locale?')) { await delAct(b.dataset.del); render(); }
  });
  document.querySelectorAll('[data-open]').forEach(r => r.onclick = () => openDetail(acts.find(a => a.id === r.dataset.open)));
  document.querySelectorAll('.ac-badges .tip').forEach(b => b.onclick = e => {
    e.stopPropagation();
    document.querySelectorAll('.tip.tip-on').forEach(x => x !== b && x.classList.remove('tip-on'));
    b.classList.toggle('tip-on');
  });

  // Calendario
  drawCalendar(acts, events);
}

let calMonth = new Date(); calMonth.setDate(1);
function drawCalendar(acts, events) {
  renderCalendar($('calView'), { month: calMonth, acts, events, reverse: settings.calOrder === 'desc' });
  $('calView').querySelectorAll('[data-cal]').forEach(b => b.onclick = () => {
    const step = +b.dataset.cal;
    if (step === 0) { calMonth = new Date(); calMonth.setDate(1); }
    else calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + step, 1);
    drawCalendar(acts, events);
  });
  $('calView').querySelectorAll('[data-ev]').forEach(b => b.onclick = () => {
    const ev = events.find(e => String(e.id) === b.dataset.ev);
    if (!matchMedia('(max-width: 700px)').matches) return renderEventDetail($('calDetail'), ev, settings);
    // Telefono: il dettaglio si apre sul posto, sotto l'allenamento toccato; ritoccando si chiude
    const open = b.nextElementSibling?.classList.contains('cal-inline');
    $('calView').querySelectorAll('.cal-inline').forEach(x => x.remove());
    $('calView').querySelectorAll('.cal-ev.sel').forEach(x => x.classList.remove('sel'));
    if (open) return;
    const box = document.createElement('div');
    box.className = 'cal-inline';
    b.after(box);
    b.classList.add('sel');
    renderEventDetail(box, ev, settings);
  });
  $('calView').querySelectorAll('[data-open]').forEach(b => b.onclick = () => openDetail(acts.find(a => a.id === b.dataset.open)));
}
// ---------- Dettaglio uscita ----------
// Il dettaglio ricorda da dove è stato aperto (attività, calendario o dashboard) e la posizione di scorrimento.
const TAB_NAMES = { acts: 'Storico', cal: 'Calendario', dash: 'Dashboard' };
let backTo = { tab: 'acts', scroll: 0 };
function showTab(name) {
  if (name === 'detail') {
    const cur = document.querySelector('.tab.active')?.id.replace('tab-', '');
    if (cur && cur !== 'detail') backTo = { tab: cur, scroll: window.scrollY };
    $('backBtn').textContent = '← ' + (TAB_NAMES[backTo.tab] || 'Indietro');
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  window.scrollTo(0, 0);
}
$('backBtn').onclick = () => { showTab(backTo.tab); window.scrollTo(0, backTo.scroll); };

// Km in salita/piano/discesa, velocità max e minima in movimento, quote max/min, dagli stream dell'uscita.
function terrainStats(s) {
  const out = {};
  const t = s.time || [], d = s.dist || [], al = s.alt || [];
  if (d.length > 10 && al.some(v => v != null)) {
    // Confronta quota e distanza ogni ~100 m: pendenza > +1,5% salita, < -1,5% discesa
    let up = 0, down = 0, flat = 0, i0 = 0;
    for (let i = 1; i < d.length; i++) {
      if (d[i] == null || al[i] == null || d[i0] == null || al[i0] == null) { i0 = i; continue; }
      const dd = d[i] - d[i0];
      if (dd < 100) continue;
      const g = (al[i] - al[i0]) / dd;
      if (g > 0.015) up += dd; else if (g < -0.015) down += dd; else flat += dd;
      i0 = i;
    }
    out.tipKm = `↗ ${(up / 1000).toFixed(1)} · → ${(flat / 1000).toFixed(1)} · ↘ ${(down / 1000).toFixed(1)} km`;
  }
  if (d.length > 10 && t.length === d.length) {
    // Velocità su finestre di 5 s; la minima considera solo i tratti in movimento (> 3 km/h)
    const sp = [];
    for (let i = 5; i < d.length; i++) {
      const dt = t[i] - t[i - 5];
      if (dt > 0 && dt <= 10 && d[i] != null && d[i - 5] != null) sp.push((d[i] - d[i - 5]) / dt * 3.6);
    }
    const mov = sp.filter(v => v > 3 && v < 120).sort((x, y) => x - y);
    if (mov.length) {
      const q = p => mov[Math.min(mov.length - 1, Math.floor(mov.length * p))];
      out.tipSpeed = `▲ ${mov[mov.length - 1].toFixed(1)} · ▼ ${q(0.02).toFixed(1)} km/h`;
    }
  }
  const alts = al.filter(v => v != null);
  if (alts.length) {
    let mx = -Infinity, mn = Infinity;
    for (const v of alts) { if (v > mx) mx = v; if (v < mn) mn = v; }
    out.tipAlt = `▲ ${Math.round(mx)} m · ▼ ${Math.round(mn)} m`;
  }
  return out;
}

// Mappa Leaflet con il percorso colorato per intensità, partenza/arrivo e momenti chiave.
let map = null;
function drawMap(s, keys, startTime) {
  mapScrub = () => {};
  const card = $('dMapCard');
  const pts = [];
  const lat = s.lat || [], lng = s.lng || [];
  for (let i = 0; i < lat.length; i++) if (lat[i] && lng[i]) pts.push([lat[i], lng[i], i]);
  card.hidden = pts.length < 2 || typeof L === 'undefined';
  if (card.hidden) return;
  if (map) { map.remove(); map = null; }
  map = L.map('dMap', { scrollWheelZoom: false, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  // Al massimo ~1500 punti: leggero anche su telefono
  const every = Math.max(1, Math.floor(pts.length / 1500));
  const line = pts.filter((_, i) => i % every === 0).map(p => [p[0], p[1]]);
  L.polyline(line, { color: '#ffffff', weight: 7, opacity: .9 }).addTo(map);
  L.polyline(line, { color: '#7b3fbf', weight: 4 }).addTo(map);
  const dot = (p, color, title) => L.circleMarker([p[0], p[1]], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).bindTooltip(title).addTo(map);
  dot(pts[0], '#1f9d55', 'Partenza');
  dot(pts[pts.length - 1], '#d64545', 'Arrivo');
  // Numeri dei momenti chiave anche sulla mappa
  for (const k of keys || []) {
    const sec = Math.round(k.sec);
    const p = pts.reduce((best, q) => (Math.abs((s.time[q[2]] ?? q[2]) - sec) < Math.abs((s.time[best[2]] ?? best[2]) - sec) ? q : best), pts[0]);
    L.marker([p[0], p[1]], { icon: L.divIcon({ className: 'map-pin', html: `<span>${k.n}</span>`, iconSize: [22, 22] }) })
      .bindTooltip(`${k.title} · ${k.value}`).addTo(map);
  }
  map.fitBounds(L.latLngBounds(line), { padding: [20, 20] });
  setTimeout(() => map && map.invalidateSize(), 50);

  // Pallino che segue il cursore sul grafico potenza/battito
  const runner = L.circleMarker(pts[0], { radius: 8, color: '#fff', weight: 3, fillColor: '#2bb5c4', fillOpacity: 1, interactive: false });
  runner.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -10], className: 'run-tip' });
  const times = s.time;
  mapScrub = sec => {
    if (!map) return;
    if (sec == null) { runner.remove(); return; }
    // ricerca binaria del campione più vicino a quel secondo
    let lo = 0, hi = times.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < sec) lo = mid + 1; else hi = mid; }
    let j = lo;
    for (let d = 0; d < 30 && !(lat[j] && lng[j]); d++) j = lo + (d % 2 ? -(d >> 1) - 1 : (d >> 1) + 1);
    if (!(lat[j] && lng[j])) return;
    const clock = new Date(startTime + times[lo] * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const km = s.dist?.[lo] != null ? ` · ${(s.dist[lo] / 1000).toFixed(1)} km` : '';
    runner.setLatLng([lat[j], lng[j]]);
    runner.setTooltipContent(`<b>${clock}</b> · ${fmtDur(times[lo])} dalla partenza${km}`);
    if (!map.hasLayer(runner)) runner.addTo(map).openTooltip();
  };
}
let mapScrub = () => {};

// Riporta uno stream a 1 valore al secondo.
function resample(time, values) {
  if (!time.length) return [];
  const out = new Array(time[time.length - 1] + 1).fill(0);
  let j = 0;
  for (let t = 0; t < out.length; t++) {
    while (j + 1 < time.length && time[j + 1] <= t) j++;
    out[t] = t - time[j] > 5 ? 0 : values[j] ?? 0;
  }
  return out;
}
// Media mobile centrata su `win` secondi. Con skipZero ignora i valori mancanti (0/null).
function rolling(arr, win, skipZero = false) {
  const out = new Array(arr.length);
  let sum = 0, cnt = 0;
  const half = Math.floor(win / 2);
  const ok = v => v != null && !(skipZero && !v);
  for (let i = 0; i < Math.min(half, arr.length); i++) if (ok(arr[i])) { sum += arr[i]; cnt++; }
  for (let i = 0; i < arr.length; i++) {
    const add = i + half, rem = i - half - 1;
    if (add < arr.length && ok(arr[add])) { sum += arr[add]; cnt++; }
    if (rem >= 0 && ok(arr[rem])) { sum -= arr[rem]; cnt--; }
    out[i] = cnt ? sum / cnt : null;
  }
  return out;
}
// Finestra di d secondi con la media più alta.
function bestWindow(p, d) {
  let s = 0, best = -1, start = 0;
  for (let i = 0; i < p.length; i++) {
    s += p[i];
    if (i >= d) s -= p[i - d];
    if (i >= d - 1 && s > best) { best = s; start = i - d + 1; }
  }
  return { start, avg: best / d };
}
// Tratto con il maggior guadagno di quota (tollera piccole discese fino a 15 m).
function biggestClimb(alt) {
  let best = null, lo = 0, hi = 0;
  for (let i = 1; i < alt.length; i++) {
    if (alt[i] == null) continue;
    if (alt[lo] == null || alt[i] < alt[lo] && alt[hi] - alt[i] > 15) { lo = hi = i; continue; }
    if (alt[i] >= alt[hi]) {
      hi = i;
      const gain = alt[hi] - alt[lo];
      if (!best || gain > best.gain) best = { from: lo, to: hi, gain };
    } else if (alt[hi] - alt[i] > 15) { lo = hi = i; }
  }
  return best;
}
// Riduce a ~n punti facendo la media, per grafici leggeri anche su telefono.
function downsample(arr, n = 600) {
  if (arr.length <= n) return arr;
  const step = arr.length / n, out = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * step), e = Math.floor((i + 1) * step);
    let sum = 0, c = 0;
    for (let k = s; k < e; k++) if (arr[k] != null) { sum += arr[k]; c++; }
    out.push(c ? sum / c : null);
  }
  return out;
}

async function openDetail(a) {
  if (!a) return;
  showTab('detail');
  $('dTitle').textContent = `${a.name} · ${fmtDate(a.date)}`;
  $('dBest').innerHTML = '<p class="hint">Caricamento…</p>';
  $('dFuel').hidden = true;
  let s = a.streams;
  // v2 = stream con coordinate GPS: quelli salvati prima vanno riscaricati una volta
  if (a.source === 'intervals' && (!s || s.v !== 2)) {
    try {
      s = await fetchStreams(settings, a.id);
      await putAct({ ...a, streams: s }); // salvato: la prossima volta si apre subito, anche offline
    } catch (e) { $('dBest').innerHTML = `<p class="hint">Impossibile scaricare i dati: ${esc(e.message)}</p>`; return; }
  }
  if (!s || !s.time?.length) { $('dBest').innerHTML = '<p class="hint">Nessun dato secondo per secondo per questa attività.</p>'; return; }

  const power = resample(s.time, s.power || []);
  const hasPower = power.some(x => x > 0);
  const np = hasPower ? Math.round(normalizedPower(power)) : a.np;
  const hrs = (s.hr || []).filter(Boolean);
  const cads = (s.cad || []).filter(Boolean);
  // Tempo totale vs in movimento → pause; secondi con cadenza 0 (registrazione attiva) → senza pedalare
  const elapsed = s.time[s.time.length - 1] || a.movingTime;
  const pause = Math.max(0, elapsed - (a.movingTime || elapsed));
  let coast = 0, pedal = 0;
  if (s.cad?.length) for (let i = 1; i < s.time.length; i++) {
    const dt = s.time[i] - s.time[i - 1];
    if (dt > 5) continue; // buco di registrazione = pausa, già conteggiata
    if (s.cad[i]) pedal += dt; else coast += dt;
  }
  const pct = (x, t) => t ? ` (${Math.round(x / t * 100)}%)` : '';
  const tipDur = `⏱ ${fmtDur(elapsed)} · ⏸ ${fmtDur(pause)}${pct(pause, elapsed)}`;
  const terrain = terrainStats(s);
  const tipCad = s.cad?.length ? `⟳ ${fmtDur(pedal)} · ⏸ ${fmtDur(coast)}${pct(coast, pedal + coast)}` : null;
  const maxHr = hrs.length ? Math.max(...hrs) : null;
  const maxP = hasPower ? Math.max(...power) : null;
  const kj = hasPower ? Math.round(power.reduce((x, y) => x + y, 0) / 1000) : null;
  const vi = hasPower && a.avgPower ? (np / a.avgPower).toFixed(2) : null;
  const speed = a.movingTime ? (a.distance / a.movingTime) * 3.6 : 0;
  $('dKpis').innerHTML = [
    // Ordinati per categoria: percorso, carico, potenza, battito, cadenza
    ['Durata', fmtDur(a.movingTime), 'time', tipDur], ['Distanza', `${(a.distance / 1000).toFixed(1)} km`, 'time', terrain.tipKm],
    ['Dislivello', `${Math.round(a.ascent || 0)} m`, 'time', terrain.tipAlt], ['Velocità media', `${speed.toFixed(1)} km/h`, 'time', terrain.tipSpeed],
    ['TSS', a.tss ?? '–', 'load'], ['IF', a.ifactor ?? '–', 'load'],
    ['Potenza media', a.avgPower ? `${a.avgPower} W` : '–', 'power'], ['NP', np ? `${np} W` : '–', 'power'],
    ['Potenza max', maxP ? `${maxP} W` : '–', 'power'], ...(vi ? [['Variabilità (VI)', vi, 'power']] : []),
    ['FC media / max', a.avgHr ? `${a.avgHr} / ${maxHr}` : '–', 'hr'],
    ['Cadenza media', cads.length ? Math.round(cads.reduce((x, y) => x + y, 0) / cads.length) + ' rpm' : '–', 'cad', tipCad],
  ].map(kpi).join('');

  // Integrazione consigliata per durata e intensità di questa uscita
  const fuel = fuelPlan({ secs: a.movingTime, ifactor: a.ifactor || (np && settings.ftp ? np / settings.ftp : null), weight: settings.weight, kj });
  $('dFuel').hidden = !fuel;
  $('dFuelBody').innerHTML = fuelHtml(fuel);

  // Grafico potenza + battito nel tempo, smussato, con i momenti chiave numerati
  const hrSec = resample(s.time, s.hr || []);
  // Smussamento proporzionato alla durata: 30″ per un'uscita breve, fino a 2′ per le lunghe.
  const win = Math.round(Math.min(120, Math.max(30, power.length / 120)));
  const pSmooth = rolling(power, win);
  const hSmooth = rolling(hrSec, Math.round(win / 2), true); // il battito è già più regolare
  const N = 200;
  const pw = downsample(pSmooth, N);
  const hr = downsample(hSmooth, N);
  const step = power.length / pw.length;
  const labels = pw.map((_, i) => fmtDur(i * step));
  const at = sec => Math.min(N - 1, Math.round(sec / step));

  const keys = [];
  if (hasPower) {
    const add = (d, title) => {
      if (power.length < d * 1.5) return;
      const { start, avg } = bestWindow(power, d);
      keys.push({ series: 'p', sec: start + d / 2, title, value: `${Math.round(avg)} W`, from: start, to: start + d });
    };
    add(5, 'Sprint (5″)');
    add(60, 'Miglior 1′');
    add(300, 'Miglior 5′');
    add(1200, 'Miglior 20′');
  }
  if (hrs.length) {
    let im = 0;
    hSmooth.forEach((v, i) => { if (v > hSmooth[im]) im = i; });
    keys.push({ series: 'h', sec: im, title: 'Battito massimo', value: `${maxHr} bpm` });
  }
  // Salita più lunga: tratto continuo con il maggior guadagno di quota
  const altSec = resample(s.time, s.alt || []);
  if (altSec.some(Boolean)) {
    const climb = biggestClimb(rolling(altSec, 30, true));
    if (climb && climb.gain > 80) {
      const len = climb.to - climb.from;
      const wAvg = hasPower ? power.slice(climb.from, climb.to).reduce((x, y) => x + y, 0) / len : null;
      keys.push({ series: 'p', sec: (climb.from + climb.to) / 2, title: 'Salita principale',
        value: `+${Math.round(climb.gain)} m in ${fmtDur(len)}${wAvg ? ` · ${Math.round(wAvg)} W` : ''}`, from: climb.from, to: climb.to });
    }
  }
  keys.sort((a, b) => a.sec - b.sec).forEach((k, i) => (k.n = i + 1));

  const altS = downsample(rolling(altSec, 30, true), N);
  const altVals = altS.filter(v => v != null);
  const altMin = altVals.length ? Math.min(...altVals) : 0, altMax = altVals.length ? Math.max(...altVals) : 1;

  // Evidenzia sulla potenza i tratti dei migliori sforzi
  const highlight = pw.map((_, i) => (keys.some(k => k.from != null && k.from <= i * step && i * step <= k.to) ? pw[i] : null));
  const pal = { p: '#7b3fbf', h: '#d64545' };
  chart('dPowerChart', {
    type: 'line',
    data: { labels, datasets: [
      // Altimetria in sottofondo, su un asse nascosto (order alto = disegnata dietro)
      ...(altS.some(v => v != null) ? [{ label: 'Altimetria', data: altS.map(v => v != null ? Math.round(v) : null), yAxisID: 'y3', order: 10,
        borderColor: '#8891a066', backgroundColor: '#8891a01f', fill: 'start', pointRadius: 0, borderWidth: 1, tension: .4, spanGaps: true }] : []),
      ...(hasPower ? [
        { label: `Potenza (W, media ${win < 60 ? win + '″' : Math.round(win / 60) + '′'})`, data: pw.map(x => x != null ? Math.round(x) : null), borderColor: '#7b3fbf', backgroundColor: '#7b3fbf1c', fill: true, pointRadius: 0, borderWidth: 2, tension: .4, cubicInterpolationMode: 'monotone' },
        { label: 'Tratti migliori', data: highlight, borderColor: 'transparent', backgroundColor: '#7b3fbf55', fill: 'origin', pointRadius: 0, tension: .4, spanGaps: false },
      ] : []),
      { label: 'Battito (bpm)', data: hr.map(x => x ? Math.round(x) : null), borderColor: '#d64545', pointRadius: 0, borderWidth: 2, tension: .4, cubicInterpolationMode: 'monotone', spanGaps: true, yAxisID: 'y2' },
      ...(hasPower && settings.ftp ? [{ label: 'FTP', data: pw.map(() => settings.ftp), borderColor: '#8891a0', borderDash: [5, 5], pointRadius: 0, borderWidth: 1 }] : []),
    ] },
    options: {
      layout: { padding: { top: 8 } },
      // Scorrendo sul grafico (mouse o dito) il pallino si muove sulla mappa
      onHover: (e, _els, c) => {
        if (e.type === 'mouseout') return mapScrub(null);
        const i = Math.round(c.scales.x.getValueForPixel(e.x));
        if (i >= 0 && i < N) mapScrub(i * step);
      },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { filter: l => l.text !== 'Tratti migliori' } },
        tooltip: { filter: t => t.dataset.label !== 'Tratti migliori' },
      },
      // Spazio libero in alto per i segnaposto numerati
      scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true, grace: '35%' }, y2: { position: 'right', grid: { display: false }, grace: '35%' },
        // L'altimetria occupa al massimo i 2/3 inferiori, per non coprire le curve
        y3: { display: false, min: altMin, max: altMin + (altMax - altMin) * 1.6 || 1 } },
    },
    plugins: [{
      // Segnaposto numerati in alto, impilati se vicini, con linea tratteggiata fino alla curva
      id: 'keyPins',
      afterDatasetsDraw(c) {
        const { ctx, chartArea: area, scales } = c;
        const R = 10, rows = [];
        for (const k of keys) {
          const i = at(k.sec);
          const v = k.series === 'p' ? pw[i] : hr[i];
          if (v == null) continue;
          const x = scales.x.getPixelForValue(i);
          const y = (k.series === 'p' ? scales.y : scales.y2).getPixelForValue(v);
          let row = 0;
          while ((rows[row] || []).some(px => Math.abs(px - x) < R * 2 + 4)) row++;
          (rows[row] ||= []).push(x);
          const py = area.top + R + 2 + row * (R * 2 + 4);
          ctx.save();
          ctx.strokeStyle = pal[k.series]; ctx.globalAlpha = .6; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, py + R); ctx.lineTo(x, y); ctx.stroke();
          ctx.globalAlpha = 1; ctx.setLineDash([]);
          ctx.fillStyle = pal[k.series];
          ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = css('--card') || '#fff'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.arc(x, py, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = pal[k.series]; ctx.font = 'bold 11px system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(k.n, x, py + .5);
          ctx.restore();
        }
      },
    }],
  });
  // Momenti chiave in un'area richiudibile: chiusa mostra solo un'anteprima dei numeri
  $('dKeys').innerHTML = keys.length ? `<details class="keys-box">
    <summary><span class="kb-nums">${keys.map(k => `<span class="num" style="--c:${pal[k.series]}">${k.n}</span>`).join('')}</span>
      <span class="kb-t">${keys.length} momenti chiave</span><span class="kb-more">Mostra dettagli</span></summary>
    <div class="keys">${keys.map(k => `
    <div class="key"><span class="num" style="--c:${pal[k.series]}">${k.n}</span>
      <div><b>${k.title}</b> · ${k.value}<div class="s">a ${fmtDur(k.sec)}</div></div></div>`).join('')}</div></details>` : '';

  // Mappa del percorso
  drawMap(s, keys, a.date);

  // Migliori sforzi, con confronto ai record degli ultimi 90 giorni
  const lbl = d => (d < 60 ? `${d}s` : `${d / 60}'`);
  if (hasPower) {
    const be = bestEfforts(power);
    const icuCurve = (await kvGet('curve')) || {};
    $('dBest').innerHTML = '<div class="best">' + Object.entries(be).map(([d, w]) => {
      const rec = icuCurve[d];
      const pct = rec ? Math.round((w / rec) * 100) : null;
      const wkg = settings.weight ? ` · ${(w / settings.weight).toFixed(1)} W/kg` : '';
      // Colore della zona di potenza in cui cade lo sforzo (rispetto alla FTP)
      const zi = settings.ftp ? POWER_ZONES.findIndex(z => w / settings.ftp <= z.max) : -1;
      const zc = zi >= 0 ? ZONE_COLORS[zi] : null;
      return `<div${zc ? ` class="zoned" style="--z:${zc}" title="${POWER_ZONES[zi].name}"` : ''}><span>${lbl(+d)}</span><b>${w} W</b>${zc ? `<em>${POWER_ZONES[zi].name.split(' ')[0]}</em>` : ''}<span>${wkg.slice(3)}${pct ? `<br>${pct >= 100 ? '🏆 record 90 gg' : pct + '% del record'}` : ''}</span></div>`;
    }).join('') + '</div>';
    const z = powerZones(power, settings.ftp);
    chart('dZoneChart', {
      type: 'bar',
      data: { labels: POWER_ZONES.map(x => x.name), datasets: [{ label: 'Minuti', data: z.map(x => Math.round(x / 60)),
        backgroundColor: ['#8891a0', '#2f6fde', '#1f9d55', '#d98a00', '#e0662b', '#d64545', '#7b3fbf'] }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { y: { reverse: true } } } // Z1 in basso, Z7 in alto,
    });
  } else {
    $('dBest').innerHTML = '<p class="hint">Nessun dato di potenza.</p>';
    charts.dZoneChart?.destroy();
  }
}

// Riquadro dato; con `tip` mostra un fumetto al passaggio del mouse o al tocco (telefono)
const kpi = ([l, v, cat, tip]) => `<div class="kpi${cat ? ' c-' + cat : ''}${tip ? ' has-tip' : ''}"${tip ? ` tabindex="0" data-tip="${esc(tip)}"` : ''}>
  <div class="v">${v}</div><div class="l">${l}${tip ? ' <span class="i">ⓘ</span>' : ''}</div></div>`;
document.addEventListener('click', e => {
  const k = e.target.closest('.has-tip');
  document.querySelectorAll('.has-tip.tip-on').forEach(x => x !== k && x.classList.remove('tip-on'));
  if (k) k.classList.toggle('tip-on');
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

fillSettings();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
kvGet('lastSync').then(t => t && status('Ultima sincronizzazione: ' + new Date(t).toLocaleString('it-IT'))).then(autoSync);
