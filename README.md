# Bike Analytics

App web per analizzare le uscite in bici: sincronizzazione da intervals.icu, caricamento di file `.fit`/`.json`, carico di lavoro (TSS, CTL/ATL/TSB), curva di potenza, zone, storico e consigli.

## Avvio sul PC

I moduli JavaScript non funzionano aprendo `index.html` con doppio clic: serve un piccolo server locale.

```powershell
cd C:\Sviluppo\BikeAnalytics
python -m http.server 8080
```

Poi apri http://localhost:8080.

## Primo utilizzo

1. Impostazioni → inserisci ID atleta e chiave API di intervals.icu (Settings → Developer Settings).
2. Premi **Sincronizza**: arrivano attività (ultimi 365 giorni), calendario, FTP/FC soglia/peso e curva di potenza.
3. In alternativa, nella scheda Attività carichi file `.fit` o `.json`.

## Se la sincronizzazione dice "CORS"

Il browser potrebbe bloccare le chiamate dirette a intervals.icu. Soluzione gratuita: un Cloudflare Worker che fa da ponte.

```js
export default {
  async fetch(req) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const r = await fetch('https://intervals.icu' + url.pathname + url.search, { headers: { Authorization: req.headers.get('Authorization') } });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
```

Poi in Impostazioni → Proxy metti `https://<nome>.workers.dev/api/v1`.

## Usarla da iPhone

Pubblica la cartella su GitHub Pages o Netlify (gratis), aprila in Safari e scegli Condividi → Aggiungi a Home.
I dati restano su ogni dispositivo: con intervals basta premere Sincronizza anche sull'iPhone.

## Struttura

- `js/fit.js`: lettura dei file FIT
- `js/metrics.js`: NP, IF, TSS, curva di potenza, zone, CTL/ATL/TSB
- `js/intervals.js`: API intervals.icu
- `js/advice.js`: consigli basati su regole
- `js/app.js`: interfaccia, grafici, archivio locale (IndexedDB)
