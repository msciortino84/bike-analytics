import { parseFit } from './fit.js';
import { analyzeRecords, pmc, CURVE_DURATIONS, POWER_ZONES, startOfDay } from './metrics.js';
import { fetchAthlete, fetchActivities, fetchEvents, fetchPowerCurve, fetchWellness } from './intervals.js';
import { buildAdvice } from './advice.js';

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
function saveSettings(s) { try { localStorage.setItem('settings', JSON.stringify(s)); } catch {} }
let settings = loadSettings();

// ---------- Utility ----------
const $ = id => document.getElementById(id);
const status = msg => ($('status').textContent = msg || '');
const fmtDur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}'`; };
const fmtDate = t => new Date(t).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const charts = {};
function chart(id, cfg) {
  charts[id]?.destroy();
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
$('saveSettings').onclick = () => {
  settings = { ...settings, athleteId: $('athleteId').value.trim(), apiKey: $('apiKey').value.trim(), proxyUrl: $('proxyUrl').value.trim() };
  saveSettings(settings); status('Impostazioni salvate.');
};
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
$('syncBtn').onclick = async () => {
  if (!settings.apiKey) { status('Inserisci la chiave API in Impostazioni.'); document.querySelector('[data-tab=set]').click(); return; }
  try {
    status('Sincronizzazione in corso…');
    const ath = await fetchAthlete(settings);
    settings = { ...settings, ftp: ath.ftp || settings.ftp, lthr: ath.lthr || settings.lthr, weight: ath.weight || settings.weight };
    saveSettings(settings); fillSettings();
    const [acts, events, curve] = await Promise.all([fetchActivities(settings), fetchEvents(settings), fetchPowerCurve(settings)]);
    for (const a of acts) await putAct(a);
    await kvSet('events', events);
    await kvSet('curve', curve);
    await kvSet('wellness', await fetchWellness(settings).catch(() => []));
    await kvSet('lastSync', Date.now());
    status(`Sincronizzate ${acts.length} uscite, ${events.length} eventi in calendario.`);
    render();
  } catch (e) {
    status(e instanceof TypeError
      ? 'Connessione bloccata dal browser (CORS) o rete assente. Serve il proxy: vedi README.'
      : e.message);
  }
};

// ---------- Caricamento file ----------
async function importFiles(files) {
  let ok = 0;
  for (const f of files) {
    try {
      if (/\.fit$/i.test(f.name)) {
        const { records, session } = parseFit(await f.arrayBuffer());
        const a = analyzeRecords(records, session, settings);
        await putAct({ ...a, id: 'fit-' + a.date, source: 'fit', name: f.name.replace(/\.fit$/i, '') });
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

// ---------- Rendering ----------
async function render() {
  const acts = (await getAll()).sort((a, b) => b.date - a.date);
  const events = (await kvGet('events')) || [];
  const icuCurve = (await kvGet('curve')) || {};
  // Se ci sono i valori ufficiali di intervals (che includono tutti gli sport) usiamo quelli,
  // altrimenti li calcoliamo dalle uscite salvate.
  const wellness = (await kvGet('wellness')) || [];
  let p = pmc(acts, 120);
  if (wellness.length) {
    const ofDay = new Map(wellness.map(w => [startOfDay(w.date), w]));
    p = p.map(d => {
      const w = ofDay.get(d.date);
      return w ? { ...d, ctl: w.ctl, atl: w.atl, tsb: w.ctl - w.atl } : d;
    });
  }
  const last = p[p.length - 1] || { ctl: 0, atl: 0 };

  // KPI
  const weekStart = startOfDay(Date.now()) - ((new Date().getDay() + 6) % 7) * 864e5;
  const week = acts.filter(a => a.date >= weekStart);
  const sum = (arr, k) => arr.reduce((s, a) => s + (a[k] || 0), 0);
  const wkg = settings.ftp && settings.weight ? (settings.ftp / settings.weight).toFixed(2) : '–';
  $('kpis').innerHTML = [
    ['Fitness (CTL)', last.ctl.toFixed(0)], ['Fatica (ATL)', last.atl.toFixed(0)],
    ['Forma (TSB)', (last.ctl - last.atl).toFixed(0)], ['TSS settimana', sum(week, 'tss').toFixed(0)],
    ['Km settimana', (sum(week, 'distance') / 1000).toFixed(0)], ['FTP', settings.ftp ? `${settings.ftp} W · ${wkg} W/kg` : '–'],
  ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  // Consigli
  $('advice').innerHTML = buildAdvice(p, acts, events).map(t => `<li class="${t.level}">${t.text}</li>`).join('');

  // PMC
  chart('pmcChart', {
    type: 'line',
    data: {
      labels: p.map(d => new Date(d.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })),
      datasets: [
        { label: 'Fitness', data: p.map(d => d.ctl), borderColor: '#2f6fde', backgroundColor: '#2f6fde22', fill: true, pointRadius: 0, tension: .3 },
        { label: 'Fatica', data: p.map(d => d.atl), borderColor: '#c2185b', pointRadius: 0, tension: .3, borderWidth: 1.5 },
        { label: 'Forma', data: p.map(d => d.tsb), borderColor: '#d98a00', pointRadius: 0, tension: .3, borderWidth: 1.5 },
        { label: 'TSS', type: 'bar', data: p.map(d => d.load), backgroundColor: '#8891a055', yAxisID: 'y2' },
      ],
    },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y2: { position: 'right', grid: { display: false } } } },
  });

  // Settimanale (12 settimane)
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const s = weekStart - i * 7 * 864e5, e = s + 7 * 864e5;
    const w = acts.filter(a => a.date >= s && a.date < e);
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

  // Mensile (12 mesi)
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - i);
    const e = new Date(d); e.setMonth(e.getMonth() + 1);
    const m = acts.filter(a => a.date >= d.getTime() && a.date < e.getTime());
    months.push({ label: d.toLocaleDateString('it-IT', { month: 'short' }), km: sum(m, 'distance') / 1000, up: sum(m, 'ascent') });
  }
  chart('monthChart', {
    type: 'bar',
    data: { labels: months.map(m => m.label), datasets: [
      { label: 'Km', data: months.map(m => Math.round(m.km)), backgroundColor: '#1f9d55' },
      { label: 'Dislivello (m)', type: 'line', data: months.map(m => Math.round(m.up)), borderColor: '#8891a0', yAxisID: 'y2' },
    ] },
    options: { scales: { y2: { position: 'right', grid: { display: false } } } },
  });

  // Curva di potenza: dati intervals se presenti, altrimenti dai FIT caricati
  const curve = {};
  for (const d of CURVE_DURATIONS) {
    let best = icuCurve[d] || 0;
    for (const a of acts) if (a.date > Date.now() - 90 * 864e5 && a.curve?.[d] > best) best = a.curve[d];
    if (best) curve[d] = best;
  }
  const lbl = s => (s < 60 ? `${s}s` : `${s / 60}'`);
  chart('curveChart', {
    type: 'line',
    data: { labels: Object.keys(curve).map(Number).map(lbl), datasets: [{ label: 'Watt', data: Object.values(curve), borderColor: '#c2185b', backgroundColor: '#c2185b22', fill: true, tension: .3 }] },
    options: { plugins: { legend: { display: false } } },
  });

  // Zone
  const z = new Array(POWER_ZONES.length).fill(0);
  acts.filter(a => a.date > Date.now() - 28 * 864e5).forEach(a => (a.zones || []).forEach((s, i) => (z[i] += s)));
  chart('zoneChart', {
    type: 'bar',
    data: { labels: POWER_ZONES.map(x => x.name), datasets: [{ label: 'Ore', data: z.map(s => +(s / 3600).toFixed(1)),
      backgroundColor: ['#8891a0', '#2f6fde', '#1f9d55', '#d98a00', '#e0662b', '#d64545', '#7b3fbf'] }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });

  // Storico
  $('actList').innerHTML = acts.length ? acts.slice(0, 300).map(a => `
    <div class="row">
      <div><div class="t">${esc(a.name)}<span class="tag">${a.source}</span></div>
        <div class="s">${fmtDate(a.date)} · ${fmtDur(a.movingTime)} · ${(a.distance / 1000).toFixed(1)} km · ${Math.round(a.ascent || 0)} m</div></div>
      <div class="r"><div>${a.tss != null ? a.tss + ' TSS' : ''}</div>
        <div class="s">${a.np ? 'NP ' + a.np + ' W' : a.avgPower ? a.avgPower + ' W' : ''}${a.avgHr ? ' · ' + a.avgHr + ' bpm' : ''}${a.ifactor ? ' · IF ' + a.ifactor : ''}</div>
        <button data-del="${a.id}">Elimina</button></div>
    </div>`).join('') : '<p class="hint">Nessuna attività. Sincronizza da intervals.icu o carica un file.</p>';
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await delAct(b.dataset.del); render(); });

  // Calendario
  const up = events.filter(e => e.date >= startOfDay(Date.now())).sort((a, b) => a.date - b.date);
  $('calList').innerHTML = up.length ? up.map(e => `
    <div class="row"><div><div class="t">${esc(e.name || '')}<span class="tag">${esc(e.category || '')}</span></div>
      <div class="s">${fmtDate(e.date)}${e.description ? ' · ' + esc(e.description.slice(0, 120)) : ''}</div></div>
      <div class="r">${e.load ? e.load + ' TSS' : ''}<div class="s">${e.duration ? fmtDur(e.duration) : ''}</div></div></div>`).join('')
    : '<p class="hint">Nessun evento pianificato (o non ancora sincronizzato).</p>';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

fillSettings();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
kvGet('lastSync').then(t => t && status('Ultima sincronizzazione: ' + new Date(t).toLocaleString('it-IT')));
