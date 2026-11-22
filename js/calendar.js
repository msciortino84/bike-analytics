// Calendario mensile stile intervals: uscite fatte, allenamenti pianificati con mini schema, totali settimanali.
import { startOfDay } from './metrics.js';

// ---------- Struttura del workout ----------
// Ritorna un elenco piatto di blocchi { secs, from, to } con intensità in % FTP.
export function workoutBlocks(ev) {
  if (ev.steps?.length) {
    const out = flattenDoc(ev.steps);
    if (out.length) return out;
  }
  return parseDescription(ev.description || '');
}

// workout_doc di intervals: { duration, power: {value|start,end, units}, reps, steps }
function flattenDoc(steps) {
  const out = [];
  for (const s of steps) {
    if (s.reps && s.steps) {
      const inner = flattenDoc(s.steps);
      for (let i = 0; i < s.reps; i++) out.push(...inner);
      continue;
    }
    const secs = s.duration || 0;
    if (!secs) continue;
    const p = s.power || {};
    const pct = v => (p.units && p.units !== '%ftp' ? null : v);
    let from = pct(p.start ?? p.value), to = pct(p.end ?? p.value);
    if (from == null && s.hr) from = to = 65; // passi a battito: altezza indicativa
    if (from == null) from = to = 50;
    out.push({ secs, from, to });
  }
  return out;
}

// Sintassi testuale di intervals: "- 10m 55%", "- 15m ramp 50-75%", righe "3x" per le ripetute,
// oppure in linea "- 3x 1m 110% 1m 50%".
export function parseDescription(text) {
  const out = [];
  let reps = 1, block = [];
  const flush = () => { for (let i = 0; i < reps; i++) out.push(...block); block = []; reps = 1; };
  const dur = s => {
    const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m && m[0] ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const rep = line.match(/(?:^|\s)(\d+)\s*x\s*$/i);
    if (rep && !line.startsWith('-')) { flush(); reps = +rep[1]; continue; }
    if (!line.startsWith('-')) continue;
    const body = line.slice(1).trim();
    const inline = body.match(/^(\d+)x\s+(.*)$/i);
    const parts = inline ? inline[2] : body;
    const steps = [];
    const re = /(\d+h)?(\d+m)?(\d+s)?\s+(?:ramp\s+)?(\d+)(?:-(\d+))?%/gi;
    let m;
    while ((m = re.exec(parts))) {
      const secs = dur((m[1] || '') + (m[2] || '') + (m[3] || ''));
      if (secs) steps.push({ secs, from: +m[4], to: +(m[5] || m[4]) });
    }
    if (inline) for (let i = 0; i < +inline[1]; i++) block.push(...steps);
    else block.push(...steps);
  }
  flush();
  return out;
}

const zoneColor = pct =>
  pct < 56 ? '#8891a0' : pct < 76 ? '#2f6fde' : pct < 91 ? '#1f9d55' : pct < 106 ? '#d98a00' : pct < 121 ? '#e0662b' : pct < 151 ? '#d64545' : '#7b3fbf';

// Mini grafico SVG: larghezza = durata, altezza = % FTP, colore = zona.
export function workoutSvg(blocks, h = 34) {
  const total = blocks.reduce((s, b) => s + b.secs, 0);
  if (!total) return '';
  const max = Math.max(130, ...blocks.map(b => Math.max(b.from, b.to)));
  let x = 0;
  const shapes = blocks.map(b => {
    const w = (b.secs / total) * 100;
    const y1 = h - (b.from / max) * h, y2 = h - (b.to / max) * h;
    const poly = `<polygon points="${x},${h} ${x},${y1} ${x + w},${y2} ${x + w},${h}" fill="${zoneColor((b.from + b.to) / 2)}"/>`;
    x += w;
    return poly;
  }).join('');
  return `<svg class="wo-svg" viewBox="0 0 100 ${h}" preserveAspectRatio="none" aria-hidden="true">${shapes}</svg>`;
}

export const blocksDuration = blocks => blocks.reduce((s, b) => s + b.secs, 0);

// ---------- Vista mensile ----------
const fmtDur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}'`; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DOW = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

export function renderCalendar(el, { month, acts, events }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = startOfDay(first.getTime() - ((first.getDay() + 6) % 7) * 864e5); // lunedì
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const today = startOfDay(Date.now());
  const byDay = (list, d) => list.filter(x => startOfDay(x.date) === d);
  const dayOf = t => { const d = new Date(t); d.setHours(12); return d; };

  let html = `<div class="cal-head"><button data-cal="-1" aria-label="Mese precedente">‹</button>
    <b>${first.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}</b>
    <button data-cal="1" aria-label="Mese successivo">›</button>
    <button data-cal="0">Oggi</button></div>
    <div class="cal-grid"><div class="cal-dow">${DOW.map(d => `<span>${d}</span>`).join('')}<span>Settimana</span></div>`;

  for (let w = start; w <= last.getTime(); w += 7 * 864e5) {
    let wTss = 0, wTime = 0, pTss = 0, pTime = 0;
    html += '<div class="cal-week">';
    for (let i = 0; i < 7; i++) {
      const d = startOfDay(dayOf(w).getTime() + i * 864e5);
      const date = new Date(d);
      const out = date.getMonth() !== month.getMonth();
      const dayActs = byDay(acts, d);
      const dayEvs = byDay(events, d);
      dayActs.forEach(a => { wTss += a.tss || 0; wTime += a.movingTime || 0; });
      html += `<div class="cal-day${out ? ' out' : ''}${d === today ? ' today' : ''}${d < today ? ' past' : ''}">
        <div class="cal-date"><span class="cal-dname">${DOW[i]}</span> ${date.getDate()}</div>`;
      for (const e of dayEvs) {
        const isRace = /RACE/.test(e.category || '');
        if (e.category === 'WORKOUT' || isRace) {
          const blocks = workoutBlocks(e);
          const secs = e.duration || blocksDuration(blocks);
          pTss += e.load || 0; pTime += secs || 0;
          html += `<div class="cal-ev ${isRace ? 'race' : 'plan'}" data-ev="${esc(e.id)}">
            <div class="cal-ev-t">${isRace ? '🏁 ' : ''}${esc(e.name)}</div>
            ${blocks.length ? workoutSvg(blocks) : ''}
            <div class="cal-ev-s">${secs ? fmtDur(secs) : ''}${e.load ? ` · ${e.load} TSS` : ''}</div></div>`;
        } else if (e.category === 'NOTE') {
          html += `<div class="cal-ev note" data-ev="${esc(e.id)}">📝 ${esc(e.name)}</div>`;
        }
      }
      for (const a of dayActs) {
        html += `<div class="cal-act" data-open="${esc(a.id)}">
          <div class="cal-ev-t">✓ ${esc(a.name)}</div>
          <div class="cal-ev-s">${fmtDur(a.movingTime)} · ${(a.distance / 1000).toFixed(0)} km${a.tss ? ` · ${a.tss} TSS` : ''}</div></div>`;
      }
      html += '</div>';
    }
    html += `<div class="cal-sum">
      <div><span>Fatto</span><b>${Math.round(wTss)} TSS</b><span>${fmtDur(wTime)}</span></div>
      ${pTss || pTime ? `<div class="pl"><span>Previsto</span><b>${Math.round(pTss)} TSS</b><span>${fmtDur(pTime)}</span></div>` : ''}
    </div></div>`;
  }
  html += '</div><div id="calDetail"></div>';
  el.innerHTML = html;
}

export function renderEventDetail(el, e, canAdd) {
  const blocks = workoutBlocks(e);
  el.innerHTML = `<div class="card cal-detail">
    <h2>${new Date(e.date).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
    <div class="name">${esc(e.name)}</div>
    ${blocks.length ? workoutSvg(blocks, 60).replace('wo-svg', 'wo-svg big') : ''}
    <div class="hint">${e.duration || blocks.length ? fmtDur(e.duration || blocksDuration(blocks)) : ''}${e.load ? ` · ${e.load} TSS previsti` : ''}</div>
    ${e.description ? `<pre>${esc(e.description)}</pre>` : ''}
  </div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
