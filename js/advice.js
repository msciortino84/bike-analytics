// Consigli basati su regole a partire dal PMC e dalle ultime attività.
export function buildAdvice(pmcData, activities, events) {
  const tips = [];
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
