// Shareek UI layer: motion, feedback, PWA. Animates transform/opacity only; honours prefers-reduced-motion.
(()=>{const RM=matchMedia("(prefers-reduced-motion: reduce)").matches,$=s=>document.querySelector(s);
const UI=window.UI={RM};
UI.toast=(m,type)=>{const t=document.createElement("div");t.className="toast"+(type=="err"?" err":"");t.textContent=m;$("#toasts").appendChild(t);setTimeout(()=>{t.classList.add("bye");setTimeout(()=>t.remove(),300)},3200)};
UI.sheet=html=>{const bg=document.createElement("div"),s=document.createElement("div");bg.className="sheet-bg";s.className="sheet";s.innerHTML=html;document.body.append(bg,s);requestAnimationFrame(()=>{bg.classList.add("on");s.classList.add("on")});const close=()=>{bg.classList.remove("on");s.classList.remove("on");setTimeout(()=>{bg.remove();s.remove()},450)};bg.onclick=close;
 let y0=null;s.addEventListener("touchstart",e=>y0=e.touches[0].clientY,{passive:true});s.addEventListener("touchmove",e=>{const d=e.touches[0].clientY-y0;if(d>0)s.style.transform=`translateY(${d}px)`},{passive:true});s.addEventListener("touchend",e=>{const d=(e.changedTouches[0].clientY-y0);s.style.transform="";if(d>90)close()});s.close=close;return s};
// confetti / gold burst
UI.confetti=()=>{if(RM)return;const c=document.createElement("canvas");c.id="confetti";document.body.appendChild(c);const x=c.getContext("2d"),D=devicePixelRatio||1;c.width=innerWidth*D;c.height=innerHeight*D;x.scale(D,D);
 const cols=["#d4af37","#f2d27a","#fff3c4","#1fae7a","#13805a","#ffffff"],P=[...Array(160)].map((_,i)=>({x:innerWidth/2,y:innerHeight*.38,vx:(Math.random()-.5)*14,vy:-Math.random()*14-4,r:Math.random()*6+3,c:cols[i%6],a:Math.random()*6,va:(Math.random()-.5)*.4,s:Math.random()<.35}));let f=0;
 (function t(){x.clearRect(0,0,innerWidth,innerHeight);P.forEach(p=>{p.vy+=.32;p.vx*=.985;p.x+=p.vx;p.y+=p.vy;p.a+=p.va;x.save();x.translate(p.x,p.y);x.rotate(p.a);x.globalAlpha=Math.max(0,1-f/150);x.fillStyle=p.c;if(p.s){x.beginPath();for(let k=0;k<8;k++){const R=k%2?p.r*.45:p.r,an=k*Math.PI/4;x.lineTo(Math.cos(an)*R,Math.sin(an)*R)}x.fill()}else x.fillRect(-p.r/2,-p.r/4,p.r,p.r/2);x.restore()});if(++f<160)requestAnimationFrame(t);else c.remove()})();if(navigator.vibrate)navigator.vibrate([12,40,18])};
// ripple + press feedback (<100ms, on pointerdown)
addEventListener("pointerdown",e=>{const b=e.target.closest(".btn,.tabs a,.pay div,.heart");if(!b)return;b.classList.add("press");const up=()=>{b.classList.remove("press");removeEventListener("pointerup",up);removeEventListener("pointercancel",up)};addEventListener("pointerup",up);addEventListener("pointercancel",up);
 if(RM||!b.classList.contains("btn"))return;const r=b.getBoundingClientRect(),s=Math.max(r.width,r.height),i=document.createElement("span");i.className="ripple";i.style.cssText=`width:${s}px;height:${s}px;left:${e.clientX-r.left-s/2}px;top:${e.clientY-r.top-s/2}px`;b.appendChild(i);setTimeout(()=>i.remove(),650)},{passive:true});
// reveals, counters, bars
const io="IntersectionObserver" in window?new IntersectionObserver(es=>es.forEach(en=>{if(!en.isIntersecting)return;const el=en.target;io.unobserve(el);el.classList.add("in");if(el.dataset.count!=null)count(el)}),{rootMargin:"0px 0px 40px 0px"}):null;
function count(el){const to=+el.dataset.count,fmt=window[el.dataset.fmt]||(v=>Math.round(v).toLocaleString("en-PK")),d=RM?0:1200,t0=performance.now();if(!d){el.textContent=fmt(to);return}(function s(n){const k=Math.min(1,(n-t0)/d),e=1-Math.pow(1-k,4);el.textContent=fmt(to*e);if(k<1)requestAnimationFrame(s)})(t0)}
UI.enhance=root=>{root=root||document;root.querySelectorAll(".rv,[data-count]").forEach(el=>io?io.observe(el):(el.classList.add("in"),el.dataset.count!=null&&count(el)));
 root.querySelectorAll(".grid,.carousel,.stats,.feat").forEach(g=>[...g.children].forEach((c,i)=>{if(!c.classList.contains("rv")){c.classList.add("rv");c.style.setProperty("--i",Math.min(i,8));io?io.observe(c):c.classList.add("in")}}));
 root.querySelectorAll(".bar i").forEach(i=>i.classList.add("fill"));
 const h=location.hash.replace(/^#\/?/,"").split("/")[0]||"";document.querySelectorAll(".tabs a,.nav a.l").forEach(a=>a.classList.toggle("on",(a.getAttribute("href")||"").replace(/^#\/?/,"").split("/")[0]==h))};
UI.skeleton=()=>`<div class="wrap" aria-busy="true"><div class="sk" style="height:34px;width:46%;margin:8px 0 18px"></div><div class="grid">${[0,1,2].map(()=>`<div class="card" style="padding:0"><div class="sk" style="height:150px;border-radius:20px 20px 0 0"></div><div style="padding:16px"><div class="sk" style="height:18px;width:60%"></div><div class="sk" style="height:12px;margin-top:10px"></div><div class="sk" style="height:10px;margin-top:16px"></div></div></div>`).join("")}</div></div>`;
// view transition wrapper
UI.swap=fn=>{if(document.startViewTransition&&!RM)return document.startViewTransition(fn).finished.catch(()=>{});fn()};
// parallax hero
let tk=0;addEventListener("scroll",()=>{if(RM||tk)return;tk=requestAnimationFrame(()=>{tk=0;const h=$(".hero");if(h)h.style.setProperty("--py",(scrollY*.35)+"px")})},{passive:true});
// pull-to-refresh (touch only)
if(matchMedia("(pointer:coarse)").matches){const p=document.createElement("div");p.className="ptr";p.innerHTML='<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/></svg>';document.body.appendChild(p);let y0=null,d=0;
 addEventListener("touchstart",e=>{y0=scrollY<=0?e.touches[0].clientY:null},{passive:true});
 addEventListener("touchmove",e=>{if(y0==null)return;d=Math.max(0,e.touches[0].clientY-y0);const k=Math.min(d,120);p.style.transition="none";p.style.opacity=Math.min(1,k/70);p.style.transform=`translateY(${k*.6-40}px) rotate(${k*3}deg)`},{passive:true});
 addEventListener("touchend",async()=>{if(y0==null)return;y0=null;p.style.transition="transform .5s cubic-bezier(.34,1.56,.64,1),opacity .4s";if(d>80){p.style.transform="translateY(30px) rotate(360deg)";window.cacheClear&&cacheClear();await window.route?.();}p.style.transform="translateY(-40px)";p.style.opacity=0;d=0})}
// prefetch on hover/touchstart (warms the SWR cache)
const pf=e=>{const a=e.target.closest&&e.target.closest('a[href^="#/c/"],a[href^="#/invest/"]');if(!a||!window.api)return;const slug=a.getAttribute("href").split("/")[2];if(slug)api("/campaigns/"+slug).catch(()=>{})};
addEventListener("pointerover",pf,{passive:true});addEventListener("touchstart",pf,{passive:true});
// keyboard shortcuts (desktop): "/" browse, g+h home, g+p portfolio, g+b browse, g+a account
let g=0;addEventListener("keydown",e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.metaKey||e.ctrlKey)return;if(e.key=="/"){e.preventDefault();location.hash="#/browse";return}if(e.key=="g"){g=Date.now();return}if(Date.now()-g<800){const m={h:"#/",p:"#/portfolio",b:"#/browse",a:"#/account",f:"#/founder"}[e.key];if(m)location.hash=m;g=0}});
// PWA: service worker + install prompt
if("serviceWorker" in navigator&&location.protocol!="file:")addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));
let dp=null;const ib=$("#installBtn");addEventListener("beforeinstallprompt",e=>{e.preventDefault();dp=e;ib&&ib.classList.add("show")});
ib&&(ib.onclick=async()=>{if(!dp)return;dp.prompt();await dp.userChoice;dp=null;ib.classList.remove("show")});
addEventListener("appinstalled",()=>{ib&&ib.classList.remove("show");UI.toast("Shareek installed ✓")});
const ios=/iphone|ipad|ipod/i.test(navigator.userAgent)&&!navigator.standalone&&!matchMedia("(display-mode: standalone)").matches;
if(ios&&!localStorage.getItem("shareek_ioshint"))setTimeout(()=>{localStorage.setItem("shareek_ioshint","1");const s=UI.sheet(`<h3 style="margin-top:0">Install Shareek</h3><p class="mut">Add Shareek to your Home Screen for a full-screen, app-like experience that works offline.</p><ol style="line-height:2"><li>Tap the <b>Share</b> button <span aria-hidden="true">⬆︎</span> in Safari</li><li>Choose <b>Add to Home Screen</b></li></ol><button class="btn" style="width:100%">Got it</button>`);s.querySelector("button").onclick=s.close},2500);
})();
