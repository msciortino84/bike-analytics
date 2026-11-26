// Client API intervals.icu (https://intervals.icu/api/v1/docs)
// Autenticazione: Basic con utente "API_KEY" e password = la chiave personale.
const BASE = 'https://intervals.icu/api/v1';

function iso(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; } // data locale, non UTC

function call(settings, path, opts) {
  return callRaw(settings, `/athlete/${settings.athleteId || '0'}${path}`, opts);
}

async function callRaw(settings, path, { method = 'GET', body } = {}) {
  const base = settings.proxyUrl ? settings.proxyUrl.replace(/\/$/, '') : BASE;
  const headers = { Authorization: 'Basic ' + btoa('API_KEY:' + settings.apiKey) };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (res.status === 401 || res.status === 403) throw new Error('Chiave API o ID atleta non validi');
  if (!res.ok) throw new Error(`intervals.icu: errore ${res.status}`);
  return res.json();
}

export async function fetchAthlete(settings) {
  const a = await call(settings, '');
  const ride = (a.sportSettings || []).find(s => (s.types || []).includes('Ride')) || {};
  return { name: a.name, ftp: ride.ftp, lthr: ride.lthr, maxHr: ride.max_hr, weight: a.icu_weight ?? a.weight,
    hrZoneNames: ride.hr_zone_names || null, hrZones: ride.hr_zones || null };
}

export async function fetchActivities(settings, days = 365) {
  const list = await call(settings, `/activities?oldest=${iso(Date.now() - days * 864e5)}&newest=${iso(Date.now() + 864e5)}`);
  return list
    .filter(a => /Ride/i.test(a.type || ''))
    .map(a => ({
      id: 'icu-' + a.id,
      source: 'intervals',
      name: a.name || 'Uscita',
      date: new Date(a.start_date_local).getTime(),
      movingTime: a.moving_time || 0,
      distance: a.distance || 0,
      ascent: a.total_elevation_gain || 0,
      avgPower: a.icu_average_watts ?? a.average_watts ?? null,
      np: a.icu_weighted_avg_watts ?? null,
      avgHr: a.average_heartrate ?? null,
      tss: a.icu_training_load ?? null,
      ifactor: a.icu_intensity != null ? +(a.icu_intensity / 100).toFixed(2) : null,
      curve: {},
      // Secondi in Z1..Z7 di potenza (la voce "SS" sweet spot di intervals è esclusa: si sovrappone a Z3-Z4)
      zones: ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'].map(z => (a.icu_zone_times || []).find(t => t.id === z)?.secs || 0),
      hrZones: a.icu_hr_zone_times || [],
      indoor: a.trainer === true || /Virtual/i.test(a.type || ''),
      decoupling: a.decoupling ?? null,      // % di deriva del battito a parità di potenza
      ef: a.icu_efficiency_factor ?? null,   // efficienza: NP / FC media
    }));
}

export async function fetchEvents(settings, daysBack = 70, daysAhead = 70) {
  const list = await call(settings, `/events?oldest=${iso(Date.now() - daysBack * 864e5)}&newest=${iso(Date.now() + daysAhead * 864e5)}`);
  return list.map(e => ({
    id: e.id,
    date: new Date(e.start_date_local).getTime(),
    name: e.name || e.category,
    category: e.category,
    type: e.type || null,
    load: e.icu_training_load ?? null,
    duration: e.moving_time ?? null,
    description: e.description || '',
    // Struttura del workout già interpretata da intervals (passi, ripetute, % FTP)
    steps: e.workout_doc?.steps || null,
  }));
}

// Fitness/fatica giornaliere calcolate da intervals (tutti gli sport).
export async function fetchWellness(settings, days = 180) {
  const list = await call(settings, `/wellness?oldest=${iso(Date.now() - days * 864e5)}&newest=${iso(Date.now())}`);
  return list
    .map(w => ({
      date: new Date(w.id + 'T00:00:00').getTime(), ctl: w.ctl ?? null, atl: w.atl ?? null, ctlLoad: w.ctlLoad ?? null, atlLoad: w.atlLoad ?? null,
      hrv: w.hrv ?? null, restingHR: w.restingHR ?? null, weight: w.weight ?? null,
      sleepSecs: w.sleepSecs ?? null, sleepScore: w.sleepScore ?? null,
    }));
}

// Stream secondo per secondo di una singola attività.
export async function fetchStreams(settings, activityId) {
  const id = String(activityId).replace(/^icu-/, '');
  const list = await callRaw(settings, `/activity/${id}/streams?types=time,watts,heartrate,altitude,distance,cadence,latlng`);
  const get = t => list.find(s => s.type === t)?.data || [];
  const ll = list.find(s => s.type === 'latlng');
  return { time: get('time'), power: get('watts'), hr: get('heartrate'), alt: get('altitude'), dist: get('distance'), cad: get('cadence'),
    lat: ll?.data || [], lng: ll?.data2 || [], v: 2 };
}

// Crea un allenamento pianificato nel calendario di intervals.
export async function createWorkout(settings, { date, name, description }) {
  const d = new Date(date);
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00`;
  return call(settings, '/events', { method: 'POST', body: { category: 'WORKOUT', type: 'Ride', start_date_local: local, name, description } });
}

export async function fetchPowerCurve(settings, curve = '90d') {
  try {
    const r = await call(settings, `/power-curves?type=Ride&curves=${curve}`);
    const c = (r.list || r)[0];
    if (!c) return {};
    const out = {};
    c.secs.forEach((s, i) => { out[s] = c.values[i]; });
    return out;
  } catch { return {}; }
}
