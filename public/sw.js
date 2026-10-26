// Shareek service worker: precache the app shell; never cache /api (auth/private data) or non-GET requests.
const V="shareek-v2-2",SHELL=["/","/index.html","/styles.css","/app.js","/ui.js","/config.js","/offline.html","/manifest.webmanifest","/fonts/inter.woff2","/fonts/fraunces.woff2","/icons/icon-192.png","/icons/icon-512.png","/icons/apple-touch-icon.png","/icons/favicon-32.png","/owner.html","/owner.js"];
self.addEventListener("install",e=>e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!=V).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{const r=e.request,u=new URL(r.url);
  if(r.method!="GET"||u.origin!=location.origin||u.pathname.startsWith("/api")||u.pathname.startsWith("/health")||u.pathname.startsWith("/docs")||r.headers.has("Authorization"))return; // network only
  if(r.mode=="navigate"){e.respondWith(fetch(r).then(res=>{if(res.ok){const c=res.clone();caches.open(V).then(x=>x.put(u.pathname=="/"?"/":r,c))}return res}).catch(async()=>(await caches.match(r))||(await caches.match("/"))||caches.match("/offline.html")));return}
  // static: stale-while-revalidate
  e.respondWith(caches.open(V).then(async c=>{const hit=await c.match(r);const net=fetch(r).then(res=>{if(res.ok&&res.type=="basic")c.put(r,res.clone());return res}).catch(()=>hit);return hit||net}));
});
