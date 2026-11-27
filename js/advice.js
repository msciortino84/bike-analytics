// ---------- Wellness: HRV, sonno, FC a riposo ----------
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function wellnessStatus(wellness) {
  const days = [...wellness].sort((a, b) => a.date - b.date);
  const today = days.filter(d => d.date > Date.now() - 2 * 864e5).pop() || null; // oggi o ieri
  // HRV come media mobile di 7 giorni (sul logaritmo) contro la media di 60: la notte singola
  // dell'Apple Watch (SDNN) oscilla troppo per decidere da sola. Fascia normale = ±0,5 dev. standard.
  const sdv = a => { const m = avg(a); return a.length > 1 ? Math.sqrt(avg(a.map(x => (x - m) ** 2))) : null; };
  const since = n => days.filter(d => d.date > Date.now() - n * 864e5);
  const lnB = since(60).filter(d => d.hrv > 0).map(d => Math.log(d.hrv));
  const ln7 = since(7).filter(d => d.hrv > 0).map(d => Math.log(d.hrv));
  const hrvBase = lnB.length ? Math.exp(avg(lnB)) : null;
  const hrv7 = ln7.length ? Math.exp(avg(ln7)) : null;
  const okR = d => d.restingHR >= 30 && d.restingHR <= 90;
  const rhrBase = avg(since(60).filter(okR).map(d => d.restingHR));
  const r7 = since(7).filter(okR).map(d => d.restingHR);
  const rhr7 = r7.length >= 3 ? avg(r7) : null;
  const res = { today, hrvBase, rhrBase, hrv7, rhr7, flags: [] };
  if (lnB.length >= 7 && ln7.length >= 3) {
    const sB = sdv(lnB) || 0.1, z = (avg(ln7) - avg(lnB)) / sB;
    res.hrvZ = z; res.hrvBand = [Math.exp(avg(lnB) - 0.5 * sB), Math.exp(avg(lnB) + 0.5 * sB)];
    const pct = Math.round(Math.abs(hrv7 / hrvBase - 1) * 100);
    if (z < -1.5) res.flags.push({ level: 'bad', key: 'hrv', text: `HRV media 7 giorni ${Math.round(hrv7)} ms, ${pct}% sotto la tua norma (${Math.round(hrvBase)}): il corpo non sta recuperando. Riduci il carico per qualche giorno.` });
    else if (z < -0.5) res.flags.push({ level: 'ok', key: 'hrvtrend', text: `HRV media 7 giorni ${Math.round(hrv7)} ms, sotto la tua fascia normale: accumuli fatica, evita lavori molto intensi.` });
    else res.flags.push({ level: 'good', key: 'hrvok', text: `HRV media 7 giorni ${Math.round(hrv7)} ms, ${z > 0.5 ? 'sopra' : 'dentro'} la tua fascia normale: recupero ok.` });
  }
  if (rhr7 && rhrBase && rhr7 > rhrBase + 3) res.flags.push({ level: 'ok', key: 'rhr', text: `FC a riposo media 7 giorni ${Math.round(rhr7)} bpm, +${Math.round(rhr7 - rhrBase)} rispetto al solito: possibile fatica o inizio di malanno.` });
  if (today?.sleepSecs && today.sleepSecs < 6 * 3600) res.flags.push({ level: 'ok', key: 'sleep', text: `Hai dormito ${(today.sleepSecs / 3600).toFixed(1)} h: meglio un allenamento facile.` });
  return res;
}

// ---------- Allenamento del giorno ----------
// Le descrizioni usano la sintassi workout di intervals.icu, così diventano allenamenti strutturati.
const WORKOUTS = {
  rest: { name: 'Riposo', minutes: 0, text: 'Giorno di riposo completo, oppure 20-30 minuti di camminata o stretching.', description: '' },
  recovery: { name: 'Recupero attivo', minutes: 45, text: '45 minuti molto facili in Z1, cadenza agile.',
    description: '- 45m 50% 90rpm' },
  endurance: { name: 'Endurance Z2', minutes: 90, text: '1h30 costante in Z2, la base della resistenza aerobica.',
    description: 'Warmup\n- 10m ramp 50-65%\n\nMain set\n- 70m 65-72%\n\nCooldown\n- 10m 50%' },
  sweetspot: { name: 'Sweet Spot 3x12', minutes: 75, text: '3 ripetute da 12 minuti all\'88-92% FTP con 5 minuti di recupero.',
    description: 'Warmup\n- 15m ramp 50-75%\n\nMain set 3x\n- 12m 88-92%\n- 5m 55%\n\nCooldown\n- 9m 50%' },
  threshold: { name: 'Soglia 2x20', minutes: 80, text: '2 ripetute da 20 minuti al 95-100% FTP con 8 minuti di recupero.',
    description: 'Warmup\n- 15m ramp 50-75%\n- 3x 1m 110% 1m 50%\n\nMain set 2x\n- 20m 95-100%\n- 8m 55%\n\nCooldown\n- 5m 50%' },
  vo2: { name: 'VO2max 5x4', minutes: 70, text: '5 ripetute da 4 minuti al 110-120% FTP con 4 minuti di recupero.',
    description: 'Warmup\n- 15m ramp 50-75%\n- 2x 30s 120% 1m30s 50%\n\nMain set 5x\n- 4m 110-120%\n- 4m 50%\n\nCooldown\n- 10m 50%' },
  openers: { name: 'Attivazione pre-gara', minutes: 45, text: '45 minuti facili con 3 brevi accelerazioni per arrivare brillante alla gara.',
    description: '- 20m 60%\n\n3x\n- 1m 105%\n- 3m 55%\n\n- 13m 55%' },
};

export function suggestWorkout(pmcData, activities, events, wstat, ready) {
  const last = pmcData[pmcData.length - 1] || { ctl: 0, atl: 0 };
  const tsb = last.ctl - last.atl;
  const reasons = [];
  const hard = a => (a.ifactor ?? 0) >= 0.85;
  const recent = activities.filter(a => a.date > Date.now() - 7 * 864e5);
  const lastTwo = activities.filter(a => a.date > Date.now() - 2 * 864e5);
  const race = events.find(e => /RACE/.test(e.category || '') && e.date > Date.now() - 864e5);
  const daysToRace = race ? Math.ceil((race.date - Date.now()) / 864e5) : null;
  let pick;

  // Allenamenti già pianificati nei prossimi 2 giorni: un lavoro duro domani o dopodomani
  // esclude la qualità oggi, per arrivarci freschi.
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const next = events
    .filter(e => (e.category === 'WORKOUT' || /RACE/.test(e.category || '')) && e.date >= day0.getTime() + 864e5 && e.date < day0.getTime() + 3 * 864e5)
    .map(e => {
      const h = (e.duration || 0) / 3600;
      const IF = e.load && h ? Math.sqrt(e.load / h / 100) : 0;
      const dIn = Math.round((new Date(e.date).setHours(0, 0, 0, 0) - day0.getTime()) / 864e5);
      return { ...e, IF, dIn, hard: /RACE/.test(e.category || '') || IF >= 0.85 || (e.load || 0) >= 90 || h >= 3 };
    }).sort((x, y) => x.date - y.date);
  const nextHard = next.find(e => e.hard);
  const when = e => (e.dIn === 1 ? 'domani' : 'dopodomani');
  const nm = e => String(e.name || '').replace(/^\d{4}-\d{2}-\d{2}\s*-?\s*/, '');
  const nextNote = nextHard ? `${when(nextHard)} hai "${nm(nextHard)}"${nextHard.load ? ` (${nextHard.load} TSS)` : ''}` : null;

  // La Readiness ha la precedenza: sotto 40 recupero, sotto 60 solo fondo
  if (ready && ready.score < 60 && !(daysToRace != null && daysToRace <= 1)) {
    pick = ready.score < 25 ? 'rest' : ready.score < 40 || (nextHard && nextHard.dIn === 1) ? 'recovery' : 'endurance';
    reasons.push(`Readiness ${ready.score} (${ready.level.name.toLowerCase()})`);
    if (nextNote) reasons.push(`${nextNote}: arrivaci recuperato`);
    return { key: pick, ...WORKOUTS[pick], reasons };
  }
  if (nextHard && !(daysToRace != null && daysToRace <= 1)) {
    // domani duro: oggi recupero o fondo breve; dopodomani duro: fondo, niente qualità
    pick = nextHard.dIn === 1 ? (tsb < -15 ? 'recovery' : 'endurance') : 'endurance';
    reasons.push(`${nextNote}: oggi niente lavori intensi`);
    return { key: pick, ...WORKOUTS[pick], reasons };
  }
  if (daysToRace != null && daysToRace <= 1) { pick = 'openers'; reasons.push(`gara "${race.name}" ${daysToRace <= 0 ? 'oggi' : 'domani'}`); }
  else if ((wstat?.hrvZ ?? 0) < -1.5 || tsb < -35) { pick = tsb < -40 ? 'rest' : 'recovery'; reasons.push(wstat?.hrvZ < -1.5 ? 'HRV (media 7 gg) molto bassa' : `forma molto negativa (${tsb.toFixed(0)})`); }
  else if (daysToRace != null && daysToRace <= 7) { pick = 'endurance'; reasons.push(`scarico: gara tra ${daysToRace} giorni`); }
  else if (tsb < -20 || (wstat?.hrvZ ?? 0) < -0.5 || wstat?.flags.some(f => f.key === 'sleep' || f.key === 'rhr')) {
    pick = 'endurance';
    reasons.push(tsb < -20 ? `fatica alta (forma ${tsb.toFixed(0)})` : 'recupero non ottimale (HRV, sonno o FC a riposo)');
  } else if (lastTwo.some(hard)) { pick = 'endurance'; reasons.push('lavoro intenso nelle ultime 48 ore'); }
  else {
    const qualityThisWeek = recent.filter(hard).length;
    if (qualityThisWeek >= 2) { pick = 'endurance'; reasons.push(`già ${qualityThisWeek} sedute intense questa settimana`); }
    else {
      const lastVo2 = recent.some(a => (a.ifactor ?? 0) >= 0.95);
      pick = tsb > -5 ? (lastVo2 ? 'threshold' : 'vo2') : 'sweetspot';
      reasons.push(tsb > -5 ? `sei fresco (forma ${tsb.toFixed(0)})` : `forma ${tsb.toFixed(0)}: carico produttivo`);
    }
  }
  return { key: pick, ...WORKOUTS[pick], reasons };
}

// Consigli basati su regole a partire dal PMC e dalle ultime attività.
export function buildAdvice(pmcData, activities, events, wstat) {
  const tips = [...(wstat?.flags || [])];
  if (!pmcData.length) return [{ level: 'info', text: 'Carica o sincronizza qualche attività per ricevere consigli.' }];
  const last = pmcData[pmcData.length - 1];
  const weekAgo = pmcData[Math.max(0, pmcData.length - 8)];
  const ramp = last.ctl - weekAgo.ctl;
  const tsb = last.ctl - last.atl;

  if (tsb < -30) tips.push({ level: 'bad', text: `Forma ${tsb.toFixed(0)}: fatica molto alta. Prevedi 1-2 giorni di riposo o recupero attivo in Z1.` });
  else if (tsb < -10) tips.push({ level: 'ok', text: `Forma ${tsb.toFixed(0)}: zona di allenamento produttivo. Mantieni, ma inserisci un giorno facile ogni 3-4.` });
  else if (tsb <= 5) tips.push({ level: 'good', text: `Forma ${tsb.toFixed(0)}: equilibrio. Buon momento per un lavoro di qualità (soglia o VO2max).` });
  else if (tsb <= 25) tips.push({ level: 'good', text: `Forma +${tsb.toFixed(0)}: sei fresco. Ideale per una gara o un test FTP.` });
  else tips.push({ level: 'ok', text: `Forma +${tsb.toFixed(0)}: molto riposato, rischi di perdere fitness. Riprendi a caricare gradualmente.` });

  if (ramp > 8) tips.push({ level: 'bad', text: `Fitness (CTL) salita di ${ramp.toFixed(1)} in 7 giorni: rampa troppo ripida, rischio sovrallenamento. Resta sotto 5-7/settimana.` });
  else if (ramp > 3) tips.push({ level: 'good', text: `Rampa di CTL +${ramp.toFixed(1)}/settimana: crescita sostenibile.` });
  else if (ramp < -3) tips.push({ level: 'ok', text: `CTL in calo (${ramp.toFixed(1)} in 7 giorni): fase di scarico o di stop.` });

  const recent = activities.filter(a => a.date > Date.now() - 28 * 864e5 && a.zones?.length);
  if (recent.length) {
    const tot = [0, 0, 0, 0, 0, 0, 0];
    recent.forEach(a => a.zones.forEach((s, i) => (tot[i] += s)));
    const sum = tot.reduce((a, b) => a + b, 0) || 1;
    const low = (tot[0] + tot[1]) / sum, mid = tot[2] / sum + tot[3] / sum;
    if (mid > 0.4) tips.push({ level: 'ok', text: `Ultime 4 settimane: ${(mid * 100).toFixed(0)}% del tempo in Z3-Z4 ("zona grigia"). Prova un approccio più polarizzato: più Z2 e pochi lavori intensi mirati.` });
    else if (low > 0.85) tips.push({ level: 'info', text: `Ultime 4 settimane quasi tutte in Z1-Z2: ottima base. Aggiungi 1-2 sedute di qualità a settimana per alzare la FTP.` });
  }

  const race = events.find(e => /RACE/.test(e.category || '') && e.date > Date.now());
  if (race) {
    const d = Math.ceil((race.date - Date.now()) / 864e5);
    if (d <= 10) tips.push({ level: 'info', text: `Gara "${race.name}" tra ${d} giorni: inizia lo scarico, riduci il volume del 30-50% mantenendo qualche breve richiamo d'intensità. Obiettivo forma tra +5 e +20.` });
    else tips.push({ level: 'info', text: `Gara "${race.name}" tra ${d} giorni.` });
  }

  const lastRide = activities.reduce((m, a) => (a.date > (m?.date ?? 0) ? a : m), null);
  if (lastRide && Date.now() - lastRide.date > 5 * 864e5) tips.push({ level: 'info', text: `Nessuna uscita da ${Math.floor((Date.now() - lastRide.date) / 864e5)} giorni.` });
  return tips;
}
