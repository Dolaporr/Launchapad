// ---------------------------------------------------------------------------
// BROWSER DEMO ONLY. This file talks to localStorage, never to a blockchain.
// There is no wallet connection, no RPC call and no contract read anywhere in it.
//
// Every number shown by this app is either zero or the result of the user pressing
// "Simulate trade". Nothing here is real volume, real revenue, real TVL or a real
// NVDA purchase, and nothing here may be presented as if it were.
// ---------------------------------------------------------------------------
const KEY = 'launchpad-factory-demo-v2';
const $ = (s, root=document) => root.querySelector(s);
const app = $('#app');

// Seed pads exist to make the layout legible. Their economics are deliberately ZERO:
// fabricated volume/reserve figures were removed rather than dressed up with a footnote.
const seed = {
  pads: [
    {id: crypto.randomUUID(), name:'NVDA Floor', slug:'nvda-floor', description:'Every launch contributes to a transparent reserve economy.', accent:'#a5ff4a', preset:'nvda', createdAt:Date.now(), volume:0, ownerRevenue:0, reserve:0, tokens:[
      {id:crypto.randomUUID(),name:'Alpha',symbol:'ALPHA',supply:1000000000,volume:0,createdAt:Date.now()-6400000},
      {id:crypto.randomUUID(),name:'Neuron',symbol:'NRN',supply:1000000000,volume:0,createdAt:Date.now()-3200000},
    ]},
    {id: crypto.randomUUID(), name:'AI Arena', slug:'ai-arena', description:'An experimental market for agent and AI-native tokens.', accent:'#75a7ff', preset:'standard', createdAt:Date.now(), volume:0, ownerRevenue:0, reserve:0, tokens:[]}
  ]
};
let state = load();
let activePreset = 'nvda';
let selectedPad = null;

function load(){ try { return JSON.parse(localStorage.getItem(KEY)) || structuredClone(seed); } catch { return structuredClone(seed); } }
function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode: demo stays in memory */ } }
function resetDemo(){ try { localStorage.removeItem(KEY); } catch {} state = structuredClone(seed); route('home'); }
// "sim" prefix is not decoration: these are simulated units, not dollars anyone earned.
function money(n){ return 'sim ' + new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n||0); }
function escapeHtml(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
// Accent is interpolated into a style attribute, so only a literal hex colour is ever accepted.
function safeAccent(v){ return /^#[0-9a-fA-F]{6}$/.test(String(v||'')) ? String(v) : '#a5ff4a'; }
function route(name, data){ selectedPad=data||null; history.replaceState(null,'',name==='home'?'#':`#${name}${data?`=${data}`:''}`); render(); }
function parseRoute(){ const h=location.hash.slice(1); if(!h) return ['home']; const [r,v]=h.split('='); return [r,v]; }

document.addEventListener('click', e=>{
  const r=e.target.closest('[data-route]'); if(r) route(r.dataset.route, r.dataset.value);
});
window.addEventListener('hashchange', render);

function render(){
  const [r,v]=parseRoute();
  if(r==='create') return renderCreate();
  if(r==='explore') return renderExplore();
  if(r==='pad') return renderPad(v);
  renderHome();
}

function renderHome(){
  const totalVolume=state.pads.reduce((a,p)=>a+p.volume,0), totalPads=state.pads.length, totalTokens=state.pads.reduce((a,p)=>a+p.tokens.length,0), reserve=state.pads.reduce((a,p)=>a+p.reserve,0);
  app.innerHTML=`
  <section class="shell hero">
    <div>
      <div class="eyebrow">Permissionless launchpad infrastructure</div>
      <h1>Launch the place where coins launch.</h1>
      <p>Create a branded token market in minutes. Pick the economy, launch tokens underneath it, and participate in the activity your ecosystem generates.</p>
      <div class="actions"><button class="btn primary" data-route="create">Create your launchpad →</button><button class="btn ghost" data-route="explore">Explore pads</button></div>
    </div>
    <aside class="hero-card">
      <div class="metric-label">Simulated network activity</div><div class="big-metric">${money(totalVolume)}</div>
      <div class="flow">
        <div class="flow-row"><span>Launchpads (local demo)</span><strong>${totalPads}</strong></div>
        <div class="flow-row"><span>Tokens (local demo)</span><strong>${totalTokens}</strong></div>
        <div class="flow-row"><span>Simulated reserve fee accrual</span><strong class="green">${money(reserve)}</strong></div>
      </div>
      <p class="muted" style="font-size:12px;margin-top:18px">These figures start at zero and only move when you press &ldquo;Simulate trade&rdquo;. They are not on-chain volume, not TVL, and not NVDA. No NVDA has been bought by anything in this repository.</p>
    </aside>
  </section>
  <section class="shell section">
    <div class="section-title"><div><div class="eyebrow">One factory, many economies</div><h2>Build around your niche.</h2></div></div>
    <div class="grid">
      ${feature('01','Your brand','A launchpad that looks and feels like your product, not ours.')}
      ${feature('02','Your economy','Choose a fee model. NVDA Reserve is the first opinionated module.')}
      ${feature('03','Your market','Launch tokens underneath one shared ecosystem and dashboard.')}
    </div>
  </section>
  ${padsSection(state.pads.slice(0,3),'Recently created')}`;
}
function feature(n,t,d){ return `<div class="card pad-card"><div class="eyebrow">${n}</div><h3>${t}</h3><p class="muted">${d}</p></div>`; }
function padsSection(pads,title){ return `<section class="shell section"><div class="section-title"><h2>${title}</h2><button class="btn ghost" data-route="explore">View all</button></div><div class="grid">${pads.map(padCard).join('')}</div></section>`; }
function padCard(p){ return `<article class="card pad-card" data-route="pad" data-value="${p.slug}" style="--accent:${safeAccent(p.accent)}"><div class="pad-head"><div class="pad-logo">${escapeHtml((p.name||"?")[0])}</div><span class="pill">${p.preset==='nvda'?'NVDA Reserve':'Standard'}</span></div><h3>${escapeHtml(p.name)}</h3><p class="muted">${escapeHtml(p.description)}</p><div class="card-stats"><div class="card-stat"><span class="metric-label">Simulated volume</span><strong>${money(p.volume)}</strong></div><div class="card-stat"><span class="metric-label">Tokens</span><strong>${p.tokens.length}</strong></div></div></article>`; }

function renderExplore(){ app.innerHTML=`<section class="shell page-head"><div class="eyebrow">Network</div><h1>Explore launchpads</h1><p class="muted">Independent markets created from the same underlying factory.</p></section>${padsSection(state.pads,'All launchpads')}`; }

function renderCreate(){
  app.innerHTML=`<section class="shell page-head"><div class="eyebrow">Launchpad builder</div><h1>Your market. Your rules.</h1><p class="muted">Alpha keeps the choices intentionally small so the deployed economics stay legible.</p></section>
  <section class="shell builder">
    <form id="createForm" class="card form-card">
      <div class="field"><label>Launchpad name</label><input name="name" maxlength="40" placeholder="e.g. Agent Arena" required /></div>
      <div class="field"><label>Slug</label><input name="slug" maxlength="40" placeholder="agent-arena" required /></div>
      <div class="field"><label>Description</label><textarea name="description" maxlength="180" placeholder="What launches here?"></textarea></div>
      <div class="field"><label>Accent</label><input name="accent" type="color" value="#a5ff4a" /></div>
      <div class="field"><label>Economy</label><div class="preset-grid">
        <button class="preset" type="button" data-preset="standard"><strong>Standard</strong><span class="muted">0.50% owner / 0.10% protocol</span></button>
        <button class="preset active" type="button" data-preset="nvda"><strong>NVDA Reserve</strong><span class="muted">0.80% reserve / 0.20% execution</span></button>
      </div></div>
      <div class="notice">The NVDA preset is a product specification, not a live mechanism. Creating a pad here writes to <code>localStorage</code> and nothing else. No NVDA is bought by this app or by any contract in this repository.</div>
      <button class="btn primary" style="width:100%;margin-top:18px" type="submit">Create launchpad →</button>
    </form>
    <aside class="card preview" id="preview" style="--accent:#a5ff4a">
      <div class="accent-bar"></div><div class="eyebrow">Live preview</div><div class="preview-hero"><h3 id="pvName">Your launchpad</h3><p id="pvDesc" class="muted">A market built around your community.</p></div><div id="pvEconomy"></div>
    </aside>
  </section>`;
  const form=$('#createForm');
  const draw=()=>{ const fd=new FormData(form); const name=fd.get('name')||'Your launchpad', desc=fd.get('description')||'A market built around your community.', accent=fd.get('accent')||'#a5ff4a'; $('#preview').style.setProperty('--accent',accent); $('#pvName').textContent=name; $('#pvDesc').textContent=desc; $('#pvEconomy').innerHTML=economyHtml(activePreset); };
  draw(); form.addEventListener('input',draw);
  document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{activePreset=b.dataset.preset;document.querySelectorAll('[data-preset]').forEach(x=>x.classList.toggle('active',x===b));draw();}));
  form.addEventListener('submit',e=>{e.preventDefault(); const fd=new FormData(form); const raw=String(fd.get('slug')).toLowerCase().trim().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-'); if(!raw) return; if(state.pads.some(p=>p.slug===raw)){alert('That slug already exists.');return;} const pad={id:crypto.randomUUID(),name:String(fd.get('name')),slug:raw,description:String(fd.get('description')||''),accent:safeAccent(fd.get('accent')),preset:activePreset,createdAt:Date.now(),volume:0,ownerRevenue:0,reserve:0,tokens:[]}; state.pads.unshift(pad);save();route('pad',raw);});
}
function economyHtml(p){ return `<div class="economy-box"><div class="metric-label">Economy</div><h3 style="font-size:22px">${p==='nvda'?'NVDA Reserve':'Standard'}</h3>${p==='nvda'?`<div class="flow-row"><span>Total fee</span><strong>1.00%</strong></div><div class="flow-row"><span>Reserve</span><strong class="green">0.80%</strong></div><div class="flow-row"><span>Execution</span><strong>0.20%</strong></div><div class="flow-row"><span>Creator drain from reserve fee</span><strong>0%</strong></div>`:`<div class="flow-row"><span>Owner</span><strong class="green">0.50%</strong></div><div class="flow-row"><span>Protocol</span><strong>0.10%</strong></div>`}</div>`; }

function renderPad(slug){
  const p=state.pads.find(x=>x.slug===slug); if(!p) return renderExplore();
  const ownerTake=p.ownerRevenue||0;
  app.innerHTML=`<section class="shell page-head" style="--accent:${safeAccent(p.accent)}"><div class="eyebrow">${p.preset==='nvda'?'NVDA Reserve economy':'Standard economy'}</div><h1>${escapeHtml(p.name)}</h1><p class="muted">${escapeHtml(p.description)}</p></section>
  <section class="shell pad-shell">
    <aside class="card sidebar"><button class="active" data-section="tokensCard">Overview</button><button data-section="tokensCard">Tokens</button><button data-section="economyCard">Economy</button></aside>
    <div class="dashboard">
      <div class="stats">
        ${stat('Simulated volume',money(p.volume))}${stat('Tokens',p.tokens.length)}${stat(p.preset==='nvda'?'Simulated reserve accrual':'Simulated owner revenue',money(p.preset==='nvda'?p.reserve:ownerTake),p.preset==='nvda')}${stat('Economy',p.preset==='nvda'?'NVDA':'Standard')}
      </div>
      <div class="card form-card" id="tokensCard"><div class="toolbar"><div><div class="eyebrow">Market</div><h2 style="margin:6px 0">Tokens</h2></div><div><button class="btn ghost" id="simulateBtn">Simulate a 1k trade</button> <button class="btn primary" id="launchBtn">Launch token +</button></div></div>
      ${p.tokens.length?`<table class="token-table"><thead><tr><th>Token</th><th>Supply</th><th>Simulated volume</th><th>Created</th></tr></thead><tbody>${p.tokens.map(t=>`<tr><td><strong>$${escapeHtml(t.symbol)}</strong><div class="muted">${escapeHtml(t.name)}</div></td><td>${Number(t.supply).toLocaleString()}</td><td>${money(t.volume)}</td><td>${new Date(t.createdAt).toLocaleDateString()}</td></tr>`).join('')}</tbody></table>`:`<div class="empty">No tokens yet. Launch the first one.</div>`}</div>
      <div class="card form-card" id="economyCard">${economyHtml(p.preset)}${p.preset==='nvda'?`<div class="notice" style="margin-top:16px"><strong>Proof gate:</strong> the reserve figure above is a simulated accrual, not an NVDA holding. Nothing in this repository buys NVDA. Before this number may be shown as a reserve it must be backed by: the canonical NVDA contract address, the vault address, and an explorer link to the actual buy transaction.</div>`:''}</div>
    </div>
  </section>`;
  $('#launchBtn').onclick=()=>openTokenModal(p);
  $('#simulateBtn').onclick=()=>{p.volume+=1000;if(p.preset==='nvda')p.reserve+=8;else p.ownerRevenue+=5;if(p.tokens[0])p.tokens[0].volume+=1000;save();renderPad(slug);};
  // The sidebar used to be four inert buttons. Each entry now actually goes somewhere.
  document.querySelectorAll('[data-section]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('[data-section]').forEach(x=>x.classList.toggle('active',x===b));
    const target=$('#'+b.dataset.section); if(target) target.scrollIntoView({behavior:'smooth',block:'start'});
  }));
}
function stat(label,value,green=false){return `<div class="card stat"><div class="metric-label">${label}</div><div class="value ${green?'green':''}">${value}</div></div>`}
function openTokenModal(p){
  const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.innerHTML=`<form class="card modal" id="tokenForm"><div class="modal-head"><div><div class="eyebrow">${escapeHtml(p.name)}</div><h2>Launch a token</h2></div><button class="icon-btn" type="button" id="closeModal">×</button></div><div class="field"><label>Name</label><input name="name" required placeholder="My Token" /></div><div class="field"><label>Symbol</label><input name="symbol" required maxlength="10" placeholder="MTK" /></div><div class="field"><label>Fixed supply</label><input name="supply" type="number" min="1" step="1" value="1000000000" required /></div><div class="notice">This creates a row in your browser only &mdash; no wallet, no transaction, no token. The real on-chain equivalent is <code>Launchpad.launchToken()</code> in <code>contracts/</code>, run via <code>scripts/createLaunchpad.cjs</code>.</div><button class="btn primary" style="width:100%;margin-top:18px">Launch token</button></form>`;document.body.appendChild(wrap);$('#closeModal',wrap).onclick=()=>wrap.remove();$('#tokenForm',wrap).onsubmit=e=>{e.preventDefault();const fd=new FormData(e.target);p.tokens.unshift({id:crypto.randomUUID(),name:String(fd.get('name')),symbol:String(fd.get('symbol')).toUpperCase(),supply:Number(fd.get('supply')),volume:0,createdAt:Date.now()});save();wrap.remove();renderPad(p.slug);};
}

document.getElementById('resetDemo')?.addEventListener('click',()=>{
  if(confirm('Clear all locally stored demo launchpads and tokens?')) resetDemo();
});

render();
