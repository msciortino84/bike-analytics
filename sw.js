// Service worker: rende l'app disponibile offline. Cambia VERSION a ogni rilascio.
const VERSION = 'v5';
const FILES = ['./', 'index.html', 'styles.css', 'manifest.json', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/fit.js', 'js/metrics.js', 'js/intervals.js', 'js/advice.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Rete prima (così vedi sempre la versione nuova), cache se offline. Le chiamate API non passano dalla cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || e.request.url.includes('intervals.icu') || e.request.url.includes('workers.dev')) return;
  e.respondWith(
    // no-cache: chiede sempre a GitHub se il file è cambiato, invece di usare la copia del browser (che dura 10 minuti).
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copy = r.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
