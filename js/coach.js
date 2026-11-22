// Consigli strutturati per area: carico, recupero, tipo di lavoro, previsione.
// pmcData: giorni { date, load, ctl, atl } fino a oggi; activities: uscite; events: calendario intervals.

const D = 864e5;
const sum = a => a.reduce((s, x) => s + x, 0);
const avg = a => (a.length ? sum(a) / a.length : 0);
const f0 = x => Math.round(x);

export function structuredAdvice(pmcData, activities, events, wstat) {
  if (!pmcData.length || !activities.length) {
    return [{ title: 'Inizia', icon: '👋', items: [{ level: 'info', text: 'Carica o sincronizza qualche attività per ricevere consigli.' }] }];
  }
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const today = day0.getTime();
  const last = pmcData[pmcData.length - 1];
  const ctl = last.ctl, atl = last.atl, tsb = ctl - atl;
  const loads = n => pmcData.slice(-n).map(d => d.load || 0);
  const groups = [];

  // ---------- Carico ----------
  const carico = [];
  const acwr = ctl > 0 ? atl / ctl : 0;
  if (acwr > 1.5) carico.push({ level: 'bad', text: `Rapporto fatica/fitness (ACWR) ${acwr.toFixed(2)}: il carico recente è molto più alto di quello a cui sei abituato. Sopra 1,5 cresce il rischio di sovrallenamento e infortuni: riduci per qualche giorno.` });
  else if (acwr > 1.3) carico.push({ level: 'ok', text: `ACWR ${acwr.toFixed(2)}: stai spingendo. Va bene per un blocco di carico breve, non per più di 1–2 settimane.` });
  else if (acwr >= 0.8) carico.push({ level: 'good', text: `ACWR ${acwr.toFixed(2)}: carico recente in equilibrio con la tua fitness (zona ideale 0,8–1,3).` });
  else carico.push({ level: 'info', text: `ACWR ${acwr.toFixed(2)}: stai facendo meno di quanto la tua fitness sopporti; se non è una settimana di scarico, puoi aumentare.` });

  const wk = sum(loads(7));
  const prev4 = [1, 2, 3, 4].map(i => sum(pmcData.slice(-(7 * (i + 1)), -(7 * i)).map(d => d.load || 0)));
  const avg4 = avg(prev4);
  if (avg4 > 0) {
    const r = wk / avg4;
    const extra = r > 1.3 ? ' Aumento sopra il 30%: la settimana prossima tienila più leggera.'
      : r < 0.6 ? ' Settimana di scarico: ottimo per assorbire il lavoro.' : '';
    carico.push({ level: r > 1.3 ? 'ok' : r < 0.6 ? 'info' : 'good',
      text: `Ultimi 7 giorni: ${f0(wk)} TSS, ${r >= 1 ? '+' : ''}${f0((r - 1) * 100)}% rispetto alla media delle 4 settimane precedenti (${f0(avg4)}).${extra}` });
  }
  // Monotonia di Foster: giorni troppo simili tra loro = poco recupero
  const l7 = loads(7), m = avg(l7), sd = Math.sqrt(avg(l7.map(x => (x - m) ** 2)));
  if (sd > 0 && m / sd > 2) carico.push({ level: 'ok', text: `Monotonia ${(m / sd).toFixed(1)}: i giorni della settimana sono troppo simili. Alterna giorni duri a giorni davvero facili o di riposo.` });
  const ramp = ctl - (pmcData[Math.max(0, pmcData.length - 8)]?.ctl ?? ctl);
  const rampTxt = ramp > 8 ? ': troppo rapido, rischi di non recuperare' : ramp > 5 ? ': al limite alto consigliato (5–7 a settimana)' : ramp >= 2 ? ': crescita sostenibile' : '';
  carico.push({ level: ramp > 8 ? 'bad' : ramp > 5 ? 'ok' : 'good', text: `Fitness ${ramp >= 0 ? 'in crescita' : 'in calo'} di ${Math.abs(ramp).toFixed(1)} punti in 7 giorni${rampTxt}.` });
  groups.push({ title: 'Carico', icon: '📈', items: carico });

  // ---------- Recupero ----------
  const rec = [...(wstat?.flags || [])];
  if (tsb < -30) rec.push({ level: 'bad', text: `Forma ${f0(tsb)}: fatica molto alta. Prevedi 1–2 giorni di riposo o recupero attivo in Z1.` });
  else if (tsb < -10) rec.push({ level: 'ok', text: `Forma ${f0(tsb)}: zona di allenamento produttivo. Inserisci un giorno facile ogni 3–4.` });
  else if (tsb <= 5) rec.push({ level: 'good', text: `Forma ${f0(tsb)}: equilibrio, buon momento per un lavoro di qualità.` });
  else rec.push({ level: tsb > 25 ? 'ok' : 'good', text: `Forma +${f0(tsb)}: sei fresco${tsb > 25 ? ', anche troppo: rischi di perdere fitness' : ', ideale per una gara o un test'}.` });
  let streak = 0;
  for (let i = pmcData.length - 1; i >= 0 && (pmcData[i].load || 0) > 0; i--) streak++;
  if (streak >= 6) rec.push({ level: 'ok', text: `${streak} giorni di fila con allenamento: inserisci un giorno di riposo completo.` });
  if (!streak) {
    let off = 0;
    for (let i = pmcData.length - 1; i >= 0 && !((pmcData[i].load || 0) > 0); i--) off++;
    if (off >= 3) rec.push({ level: 'info', text: `${off} giorni senza allenamento.` });
  }
  groups.push({ title: 'Recupero', icon: '🛌', items: rec });

  // ---------- Tipo di lavoro ----------
  const tipo = [];
  const recent7 = activities.filter(a => a.date > Date.now() - 7 * D);
  const hard = recent7.filter(a => (a.ifactor ?? 0) >= 0.85).length;
  if (hard === 0 && recent7.length >= 2) tipo.push({ level: 'info', text: 'Nessuna seduta intensa negli ultimi 7 giorni: aggiungine una (soglia o VO2max) per stimolare la FTP.' });
  else if (hard >= 3) tipo.push({ level: 'ok', text: `${hard} sedute intense in 7 giorni: sono tante, 2 di qualità a settimana bastano.` });
  else if (hard) tipo.push({ level: 'good', text: `${hard === 1 ? 'Una seduta intensa' : hard + ' sedute intense'} negli ultimi 7 giorni: dose giusta.` });
  const long14 = Math.max(0, ...activities.filter(a => a.date > Date.now() - 14 * D).map(a => a.movingTime || 0));
  if (long14 < 2.5 * 3600) tipo.push({ level: 'info', text: `Uscita più lunga delle ultime 2 settimane: ${(long14 / 3600).toFixed(1)} h. Un lungo da 3 ore o più in Z2 a settimana sostiene la resistenza.` });
  const z = [0, 0, 0, 0, 0, 0, 0];
  activities.filter(a => a.date > Date.now() - 28 * D).forEach(a => (a.zones || []).forEach((s, i) => (z[i] += s)));
  const zt = sum(z);
  if (zt) {
    const low = (z[0] + z[1]) / zt, mid = (z[2] + z[3]) / zt, high = (z[4] + z[5] + z[6]) / zt;
    const note = mid > 0.4 ? ' Troppo tempo nella "zona grigia": sposta ore verso Z2 e concentra l\'intensità in poche sedute.'
      : low >= 0.75 ? ' Distribuzione polarizzata: ottima.' : '';
    tipo.push({ level: mid > 0.4 ? 'ok' : 'good', text: `Ultimi 28 giorni: ${f0(low * 100)}% facile (Z1–Z2), ${f0(mid * 100)}% medio (Z3–Z4), ${f0(high * 100)}% intenso (Z5+).${note}` });
  }
  groups.push({ title: 'Tipo di lavoro', icon: '🎯', items: tipo });

  // ---------- Previsione con il piano di intervals ----------
  const prev = [];
  const planned = new Map();
  for (const e of events) {
    if (e.category !== 'WORKOUT' && !/RACE/.test(e.category || '')) continue;
    const d = new Date(e.date); d.setHours(0, 0, 0, 0);
    if (d.getTime() > today) planned.set(d.getTime(), (planned.get(d.getTime()) || 0) + (e.load || 0));
  }
  let c = ctl, a = atl;
  const fut = [];
  for (let i = 1; i <= 14; i++) {
    const t = today + i * D, load = planned.get(t) || 0;
    const form = c - a; // la forma di un giorno usa i valori della sera prima
    c += (load - c) / 42; a += (load - a) / 7;
    fut.push({ t, form, ctl: c });
  }
  const wd = t => new Date(t).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' });
  if (planned.size) {
    const best = fut.slice(0, 7).reduce((mx, x) => (x.form > mx.form ? x : mx));
    prev.push({ level: 'info', text: `Con i workout pianificati, tra 7 giorni: fitness ${f0(fut[6].ctl)} (oggi ${f0(ctl)}) e forma ${f0(fut[6].form)}. Giorno più fresco della settimana: ${wd(best.t)} (forma ${f0(best.form)}).` });
    const race = events.filter(e => /RACE/.test(e.category || '') && e.date > Date.now()).sort((x, y) => x.date - y.date)[0];
    if (race) {
      const rd = new Date(race.date); rd.setHours(0, 0, 0, 0);
      const r = fut.find(x => x.t === rd.getTime());
      if (r) {
        const msg = r.form < 5 ? 'Troppo affaticato: alleggerisci i giorni prima.' : r.form > 25 ? 'Molto fresco: puoi permetterti un po\' più di carico prima.' : 'Nella finestra ideale (+5 / +25).';
        prev.push({ level: r.form >= 5 && r.form <= 25 ? 'good' : 'ok', text: `Gara "${race.name}" (${wd(r.t)}): forma prevista ${f0(r.form)}. ${msg}` });
      }
    }
  } else {
    prev.push({ level: 'info', text: 'Nessun allenamento pianificato su intervals nei prossimi giorni: pianificali per vedere come evolverà la forma.' });
  }
  const avgDaily = avg(loads(28));
  const trend = avgDaily > ctl + 2 ? ', quindi continuerà a salire' : avgDaily < ctl - 2 ? ', quindi calerà lentamente' : ', cioè resterà stabile';
  prev.push({ level: 'info', text: `Mantenendo il carico medio delle ultime 4 settimane (${f0(avgDaily * 7)} TSS a settimana) la fitness tenderà verso ${f0(avgDaily)}${trend}.` });
  groups.push({ title: 'Previsione', icon: '🔮', items: prev });

  return groups;
}
