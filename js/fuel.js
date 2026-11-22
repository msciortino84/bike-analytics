// Consigli di integrazione (liquidi e carboidrati) in base a durata e intensità.
// Indicazioni generali per il ciclismo di endurance, non sostituiscono un nutrizionista.

const r5 = x => Math.round(x / 5) * 5;

// secs = durata, ifactor = intensità (NP/FTP), weight = kg, kj = lavoro meccanico (≈ kcal spese)
export function fuelPlan({ secs, ifactor, weight, kj, hot = false }) {
  if (!secs) return null;
  const h = secs / 3600;
  const IF = ifactor || 0.7;
  const w = weight || 70;

  // Carboidrati/ora: crescono con durata e intensità
  let cho;
  if (h < 1) cho = IF >= 0.85 ? [20, 30] : [0, 0];
  else if (h < 1.5) cho = IF >= 0.8 ? [40, 60] : [30, 45];
  else if (h < 2.5) cho = IF >= 0.8 ? [60, 80] : [45, 60];
  else cho = IF >= 0.75 ? [75, 90] : [60, 75];
  // Liquidi/ora e sodio
  const fl = hot ? [750, 1000] : IF >= 0.8 ? [600, 800] : [500, 700];
  const na = hot ? [600, 1000] : [300, 600];

  const totCho = [r5(cho[0] * h), r5(cho[1] * h)];
  const totFl = [Math.round(fl[0] * h / 50) * 50, Math.round(fl[1] * h / 50) * 50];
  // I kJ meccanici prodotti equivalgono circa alle kcal spese (rendimento muscolare ~24%)
  const kcal = kj ? Math.round(kj) : null;

  // Equivalenti pratici: gel ~25 g, barretta ~40 g, borraccia 500 ml di bevanda al 6% = 30 g
  const avgCho = (totCho[0] + totCho[1]) / 2;
  const bottles = Math.max(1, Math.round((totFl[0] + totFl[1]) / 2 / 500));
  const fromDrink = Math.min(avgCho, bottles * 30);
  const rest = Math.max(0, avgCho - fromDrink);
  const gels = Math.round(rest / 25);

  const pre = h >= 2 || IF >= 0.85
    ? `2–3 ore prima: pasto con circa ${r5(w * 1.5)}–${r5(w * 2)} g di carboidrati (pasta, riso, pane, frutta), poco grasso e fibre.`
    : h >= 1 ? 'Uno spuntino con 30–60 g di carboidrati 1–2 ore prima (es. banana e fette biscottate).' : 'Non serve nulla di particolare: parti idratato.';
  const post = h >= 1.5 || IF >= 0.85
    ? `Entro 1 ora: ${r5(w * 1)}–${r5(w * 1.2)} g di carboidrati e 20–30 g di proteine, più circa ${Math.round((totFl[0] + totFl[1]) / 2 * 1.2 / 100) * 100} ml di liquidi.`
    : 'Un pasto normale e acqua bastano.';

  return { h, IF, cho, fl, na, totCho, totFl, kcal, bottles, gels, pre, post };
}

export function fuelHtml(p, { planned = false } = {}) {
  if (!p) return '';
  const during = p.cho[1] === 0
    ? 'Durante: bastano acqua o una bevanda con sali; i carboidrati non sono necessari sotto l\'ora a bassa intensità.'
    : `Durante: <b>${p.cho[0]}–${p.cho[1]} g/h</b> di carboidrati → <b>${p.totCho[0]}–${p.totCho[1]} g</b> in totale
       (es. ${p.bottles} borracc${p.bottles > 1 ? 'e' : 'ia'} di bevanda energetica${p.gels ? ` + ${p.gels} gel o barrett${p.gels > 1 ? 'e' : 'a'}` : ''}).
       Inizia entro i primi 20–30 minuti e poi a piccole dosi ogni 15–20 minuti.`;
  return `<div class="fuel">
    <div class="fuel-grid">
      <div class="fz cho"><span>Carboidrati</span><b>${p.cho[1] ? `${p.totCho[0]}–${p.totCho[1]} g` : '—'}</b><small>${p.cho[1] ? `${p.cho[0]}–${p.cho[1]} g/h` : 'non necessari'}</small></div>
      <div class="fz fl"><span>Liquidi</span><b>${(p.totFl[0] / 1000).toFixed(1)}–${(p.totFl[1] / 1000).toFixed(1)} L</b><small>${p.fl[0]}–${p.fl[1]} ml/h</small></div>
      <div class="fz na"><span>Sodio</span><b>${p.na[0]}–${p.na[1]}</b><small>mg/h</small></div>
      ${p.kcal ? `<div class="fz kc"><span>Energia ${planned ? 'stimata' : 'spesa'}</span><b>≈ ${p.kcal.toLocaleString('it-IT')}</b><small>kcal</small></div>` : ''}
    </div>
    <ul>
      <li><b>Prima</b> · ${p.pre}</li>
      <li><b>${during.split(':')[0]}</b> ·${during.slice(during.indexOf(':') + 1)}</li>
      <li><b>Dopo</b> · ${p.post}</li>
    </ul>
    <div class="hint">Indicazioni generali per durata e intensità (IF ${p.IF.toFixed(2)}); con il caldo aumenta liquidi e sodio. Prova sempre in allenamento ciò che userai in gara.</div>
  </div>`;
}
