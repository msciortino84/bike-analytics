// Client API intervals.icu (https://intervals.icu/api/v1/docs)
// Autenticazione: Basic con utente "API_KEY" e password = la chiave personale.
const BASE = 'https://intervals.icu/api/v1';

function iso(d) { return new Date(d).toISOString().slice(0, 10); }

async function call(settings, path) {
  const base = settings.proxyUrl ? settings.proxyUrl.replace(/\/$/, '') : BASE;
  const athlete = settings.athleteId || '0';
  const res = await fetch(`${base}/athlete/${athlete}${path}`, {
    headers: { Authorization: 'Basic ' + btoa('API_KEY:' + settings.apiKey) },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Chiave API o ID atleta non validi');
  if (!res.ok) throw new Error(`intervals.icu: errore ${res.status}`);
  return res.json();
}

export async function fetchAthlete(settings) {
  const a = await call(settings, '');
  const ride = (a.sportSettings || []).find(s => (s.types || []).includes('Ride')) || {};
  return { name: a.name, ftp: ride.ftp, lthr: ride.lthr, maxHr: ride.max_hr, weight: a.icu_weight ?? a.weight };
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
      zones: [],
    }));
}

export async function fetchEvents(settings, daysBack = 7, daysAhead = 28) {
  const list = await call(settings, `/events?oldest=${iso(Date.now() - daysBack * 864e5)}&newest=${iso(Date.now() + daysAhead * 864e5)}`);
  return list.map(e => ({
    date: new Date(e.start_date_local).getTime(),
    name: e.name || e.category,
    category: e.category,
    load: e.icu_training_load ?? null,
    duration: e.moving_time ?? null,
    description: e.description || '',
  }));
}

// Fitness/fatica giornaliere calcolate da intervals (tutti gli sport).
export async function fetchWellness(settings, days = 180) {
  const list = await call(settings, `/wellness?oldest=${iso(Date.now() - days * 864e5)}&newest=${iso(Date.now())}`);
  return list
    .filter(w => w.ctl != null && w.atl != null)
    .map(w => ({ date: new Date(w.id + 'T00:00:00').getTime(), ctl: w.ctl, atl: w.atl }));
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
