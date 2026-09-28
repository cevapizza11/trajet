/* Trajet Model 3 — service worker
   - page (index.html) : réseau d'abord (toujours la dernière version), copie de secours hors connexion
   - bibliothèques (Leaflet, polices, Firebase) : copie locale d'abord
   - données (itinéraires, bornes, météo, cartes) : jamais mises en cache ici */
const CACHE='trajet-m3-v1';
const STATIC=/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs)/;
self.addEventListener('install',e=>{ self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['./','./index.html','./manifest.webmanifest','./icon-192.png']).catch(()=>{}))); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return;
  const u=new URL(r.url);
  if(r.mode==='navigate'||(u.origin===location.origin&&/\/(index\.html)?$/.test(u.pathname))){
    e.respondWith(fetch(r).then(res=>{ const cp=res.clone(); caches.open(CACHE).then(c=>c.put('./index.html',cp)); return res; }).catch(()=>caches.match('./index.html')));
    return;
  }
  if(STATIC.test(u.host+u.pathname)||(u.origin===location.origin&&/\.(png|webmanifest)$/.test(u.pathname))){
    e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(res=>{ if(res.ok||res.type==='opaque'){ const cp=res.clone(); caches.open(CACHE).then(c=>c.put(r,cp)); } return res; })));
  }
});
