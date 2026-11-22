import { parseFit } from './fit.js';
import { analyzeRecords, pmc, CURVE_DURATIONS, POWER_ZONES, startOfDay, bestEfforts, normalizedPower, powerZones } from './metrics.js';
import { fetchAthlete, fetchActivities, fetchEvents, fetchPowerCurve, fetchWellness, fetchStreams, createWorkout } from './intervals.js';
import { buildAdvice, wellnessStatus, suggestWorkout } from './advice.js';

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
        const t0 = records.find(r => r.t)?.t ?? 0;
        const rs = records.filter(r => r.t);
        const streams = {
          time: rs.map(r => Math.round((r.t - t0) / 1000)), power: rs.map(r => r.power), hr: rs.map(r => r.hr),
          alt: rs.map(r => r.alt), dist: rs.map(r => r.dist), cad: rs.map(r => r.cad),
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
      return w?.ctl != null && w.atl != null ? { ...d, ctl: w.ctl, atl: w.atl, tsb: w.ctl - w.atl } : d;
    });
  }
  const last = p[p.length - 1] || { ctl: 0, atl: 0 };
  const wstat = wellnessStatus(wellness);

  // Allenamento del giorno
  const wo = suggestWorkout(p, acts, events, wstat);
  const plannedToday = events.find(e => e.category === 'WORKOUT' && startOfDay(e.date) === startOfDay(Date.now()));
  $('workout').innerHTML = `
    <h2>Allenamento consigliato per oggi</h2>
    <div class="name">${esc(wo.name)}${wo.minutes ? ` <span class="tag">${wo.minutes}'</span>` : ''}</div>
    <div>${esc(wo.text)}</div>
    <div class="hint" style="margin-top:6px">Perché: ${esc(wo.reasons.join(', '))}.</div>
    ${plannedToday ? `<div class="hint">In calendario oggi hai già: <b>${esc(plannedToday.name)}</b>.</div>` : ''}
    ${wo.description ? `<pre>${esc(wo.description)}</pre>` : ''}
    ${wo.description && settings.apiKey ? `<button id="addWo" class="primary">Aggiungi al calendario di oggi su intervals</button>` : ''}`;
  if ($('addWo')) $('addWo').onclick = async () => {
    if (!confirm(`Aggiungere "${wo.name}" al tuo calendario intervals.icu di oggi?`)) return;
    try {
      await createWorkout(settings, { date: Date.now(), name: wo.name, description: wo.description });
      status(`"${wo.name}" aggiunto al calendario intervals. Si sincronizza su Garmin come allenamento strutturato.`);
      $('addWo').disabled = true;
    } catch (e) { status(e.message); }
  };

  // Wellness
  const wl = wellness.filter(w => w.date > Date.now() - 60 * 864e5).sort((a, b) => a.date - b.date);
  $('wellCard').hidden = !wl.some(w => w.hrv || w.sleepSecs);
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
  $('advice').innerHTML = buildAdvice(p, acts, events, wstat).map(t => `<li class="${t.level}">${t.text}</li>`).join('');

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
    <div class="row click" data-open="${a.id}">
      <div><div class="t">${esc(a.name)}<span class="tag">${a.source}</span></div>
        <div class="s">${fmtDate(a.date)} · ${fmtDur(a.movingTime)} · ${(a.distance / 1000).toFixed(1)} km · ${Math.round(a.ascent || 0)} m</div></div>
      <div class="r"><div>${a.tss != null ? a.tss + ' TSS' : ''}</div>
        <div class="s">${a.np ? 'NP ' + a.np + ' W' : a.avgPower ? a.avgPower + ' W' : ''}${a.avgHr ? ' · ' + a.avgHr + ' bpm' : ''}${a.ifactor ? ' · IF ' + a.ifactor : ''}</div>
        <button data-del="${a.id}">Elimina</button></div>
    </div>`).join('') : '<p class="hint">Nessuna attività. Sincronizza da intervals.icu o carica un file.</p>';
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    if (confirm('Eliminare questa attività dallo storico locale?')) { await delAct(b.dataset.del); render(); }
  });
  document.querySelectorAll('[data-open]').forEach(r => r.onclick = () => openDetail(acts.find(a => a.id === r.dataset.open)));

  // Calendario
  const up = events.filter(e => e.date >= startOfDay(Date.now())).sort((a, b) => a.date - b.date);
  $('calList').innerHTML = up.length ? up.map(e => `
    <div class="row"><div><div class="t">${esc(e.name || '')}<span class="tag">${esc(e.category || '')}</span></div>
      <div class="s">${fmtDate(e.date)}${e.description ? ' · ' + esc(e.description.slice(0, 120)) : ''}</div></div>
      <div class="r">${e.load ? e.load + ' TSS' : ''}<div class="s">${e.duration ? fmtDur(e.duration) : ''}</div></div></div>`).join('')
    : '<p class="hint">Nessun evento pianificato (o non ancora sincronizzato).</p>';
}
// ---------- Dettaglio uscita ----------
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  window.scrollTo(0, 0);
}
$('backBtn').onclick = () => showTab('acts');

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
  let s = a.streams;
  if (!s && a.source === 'intervals') {
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
  const maxHr = hrs.length ? Math.max(...hrs) : null;
  const maxP = hasPower ? Math.max(...power) : null;
  const kj = hasPower ? Math.round(power.reduce((x, y) => x + y, 0) / 1000) : null;
  const vi = hasPower && a.avgPower ? (np / a.avgPower).toFixed(2) : null;
  const speed = a.movingTime ? (a.distance / a.movingTime) * 3.6 : 0;
  $('dKpis').innerHTML = [
    ['Durata', fmtDur(a.movingTime)], ['Distanza', `${(a.distance / 1000).toFixed(1)} km`], ['Dislivello', `${Math.round(a.ascent || 0)} m`],
    ['Velocità media', `${speed.toFixed(1)} km/h`], ['TSS', a.tss ?? '–'], ['IF', a.ifactor ?? '–'],
    ['Potenza media', a.avgPower ? `${a.avgPower} W` : '–'], ['NP', np ? `${np} W` : '–'], ['Potenza max', maxP ? `${maxP} W` : '–'],
    ['Lavoro', kj ? `${kj} kJ` : '–'], ['FC media / max', a.avgHr ? `${a.avgHr} / ${maxHr}` : '–'],
    ['Cadenza media', cads.length ? Math.round(cads.reduce((x, y) => x + y, 0) / cads.length) + ' rpm' : '–'],
    ...(vi ? [['Variabilità (VI)', vi]] : []),
  ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  // Grafico potenza + battito nel tempo
  const N = 600;
  const pw = downsample(power, N);
  const hr = downsample(resample(s.time, s.hr || []).map(x => x || null), N);
  const step = power.length / pw.length;
  const labels = pw.map((_, i) => fmtDur(i * step));
  chart('dPowerChart', {
    type: 'line',
    data: { labels, datasets: [
      ...(hasPower ? [{ label: 'Potenza (W)', data: pw.map(x => x && Math.round(x)), borderColor: '#c2185b', backgroundColor: '#c2185b18', fill: true, pointRadius: 0, borderWidth: 1 }] : []),
      { label: 'Battito (bpm)', data: hr.map(x => x && Math.round(x)), borderColor: '#d64545', pointRadius: 0, borderWidth: 1.5, yAxisID: 'y2' },
      ...(hasPower && settings.ftp ? [{ label: 'FTP', data: pw.map(() => settings.ftp), borderColor: '#8891a0', borderDash: [5, 5], pointRadius: 0, borderWidth: 1 }] : []),
    ] },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y2: { position: 'right', grid: { display: false } } } },
  });

  // Altimetria sulla distanza
  const pts = s.time.map((_, i) => ({ d: s.dist?.[i], h: s.alt?.[i] })).filter(p => p.d != null && p.h != null);
  const every = Math.max(1, Math.floor(pts.length / N));
  const alt = pts.filter((_, i) => i % every === 0);
  chart('dAltChart', {
    type: 'line',
    data: { labels: alt.map(p => (p.d / 1000).toFixed(1) + ' km'), datasets: [{ label: 'Altitudine (m)', data: alt.map(p => Math.round(p.h)), borderColor: '#1f9d55', backgroundColor: '#1f9d5533', fill: true, pointRadius: 0, borderWidth: 1.5 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 8 } } } },
  });

  // Migliori sforzi, con confronto ai record degli ultimi 90 giorni
  const lbl = d => (d < 60 ? `${d}s` : `${d / 60}'`);
  if (hasPower) {
    const be = bestEfforts(power);
    const icuCurve = (await kvGet('curve')) || {};
    $('dBest').innerHTML = '<div class="best">' + Object.entries(be).map(([d, w]) => {
      const rec = icuCurve[d];
      const pct = rec ? Math.round((w / rec) * 100) : null;
      const wkg = settings.weight ? ` · ${(w / settings.weight).toFixed(1)} W/kg` : '';
      return `<div><span>${lbl(+d)}</span><b>${w} W</b><span>${wkg.slice(3)}${pct ? `<br>${pct >= 100 ? '🏆 record 90 gg' : pct + '% del record'}` : ''}</span></div>`;
    }).join('') + '</div>';
    const z = powerZones(power, settings.ftp);
    chart('dZoneChart', {
      type: 'bar',
      data: { labels: POWER_ZONES.map(x => x.name), datasets: [{ label: 'Minuti', data: z.map(x => Math.round(x / 60)),
        backgroundColor: ['#8891a0', '#2f6fde', '#1f9d55', '#d98a00', '#e0662b', '#d64545', '#7b3fbf'] }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } } },
    });
  } else {
    $('dBest').innerHTML = '<p class="hint">Nessun dato di potenza.</p>';
    charts.dZoneChart?.destroy();
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

fillSettings();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
kvGet('lastSync').then(t => t && status('Ultima sincronizzazione: ' + new Date(t).toLocaleString('it-IT')));
