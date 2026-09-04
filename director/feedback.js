/* RL Director — test-feedback-uploader (KUN dev/test-builds, 30/7-2026).
 *
 * Sender nye kamp-digests og rapporter til en privat GitHub-repo i baggrunden,
 * så testeres data kan indgå i kalibreringen af metrikker og coaching.
 * Principperne er ikke til forhandling:
 *
 * - Kører KUN når feedback.json findes med enabled:true. Filen er udeladt af
 *   alle zips, står aldrig i PUBLIC_FILES og committes aldrig (den bærer et
 *   fint-skåret token til ÉN privat repo).
 * - Sender ALDRIG nøglefiler (rank-cache.json/director-ai.json/feedback.json
 *   selv) — og aldrig labels.json medmindre includeLabels:true (spillerens
 *   egne mærker er den mest private fil produktet skriver; eksplicit opt-in).
 * - En fejl må ALDRIG nå recorderen: alt er try/catch'et, og en fejlet
 *   upload udskydes bare til næste tick. En tabt kamp kan ikke genskabes;
 *   en tabt upload kan.
 * - Transporten er udskiftelig (kind: 'github' | 'http' | 'dry') uden at
 *   scanning/kø ændres. 'http' (11/8-2026) sender til vores egen collector
 *   (collector/collector.js) og er vejen der skalerer: GitHub-transporten
 *   kræver ét delt token og dør ved API-kvoten, http-transporten genererer
 *   selv sin identitet (id + nøgle i feedback-state.json, aldrig i config)
 *   og kræver nul administration pr. tester.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const store = require('./store');

const TICK_MS = 5 * 60 * 1000;      // scan hvert 5. minut
const FIRST_MS = 30 * 1000;         // første scan kort efter opstart
const BATCH_MAX = 20;               // vær høflig mod API'et — resten tager næste tick
const HTTP_TIMEOUT = 20000;

let ROOT = null, log = () => {};
let cfg = null, state = null, running = false, timer = null;

function cfgPath(){ return path.join(ROOT, 'feedback.json'); }
function statePath(){ return path.join(ROOT, 'feedback-state.json'); }

/* Filer hvor INDHOLDET afgør om der sendes, ikke mtime (3/9): reach.flush()
 * skriver reach-state.json hvert minut et board er åbent, så filens tid
 * flytter sig uden at tallene gør — 31 uploads i træk mellem to kampe målt i
 * server.log. Sha1 af sidste upload huskes i feedback-state.json: samme bytes
 * stemples som sendt uden et kald. Og fordi overlayet henter /api/session
 * hvert 30. sekund (tælleren VOKSER, så hashen alene stopper det ikke), sendes
 * filen desuden højst én gang pr. interval — tallene er døgn-tællere og taber
 * intet ved en times forsinkelse; den sidste stand går altid med næste tick
 * efter intervallet. Værdien er minimumsafstanden i ms. */
const BY_CONTENT = new Map([['reach-state.json', 60 * 60e3]]);

/* Hvad der sendes. Bevidst en ALLOW-liste, aldrig en blokeringsliste: en ny
 * tilstandsfil i ROOT skal aktivt meldes ind her for at blive delt. */
function candidates(){
  const out = [];
  const add = (abs, rel) => { try{ const st = fs.statSync(abs); if (st.isFile()) out.push({ abs, rel, mtime: st.mtimeMs }); }catch{} };
  for (const dir of ['matches', 'reports']){
    let files = [];
    try{ files = fs.readdirSync(path.join(ROOT, dir)); }catch{ continue; }
    for (const f of files) if (/\.(json|html)$/i.test(f)) add(path.join(ROOT, dir, f), dir + '/' + f);
  }
  add(path.join(ROOT, 'profile.json'), 'profile.json');
  /* Reach (13/8): KUN tællere — åbninger pr. spilledøgn pr. flade, intet
   * indhold. Uden den kan analysen ikke skelne "coaching virkede ikke" fra
   * "coaching blev aldrig set" (K4W-fundet). Se director/reach.js. */
  add(path.join(ROOT, 'reach-state.json'), 'reach-state.json');
  /* form-state.json (23/8, director/form.js) is deliberately ABSENT: the body
   * barometer is the player's own reading and stays on the player's machine. */
  if (cfg.includeLabels === true) add(path.join(ROOT, 'labels.json'), 'labels.json');
  return out;
}

async function ghPut(rel, buf){
  const tester = String(cfg.tester || 'ukendt').replace(/[^\w.-]/g, '_');
  const url = 'https://api.github.com/repos/' + cfg.repo + '/contents/testers/' + tester + '/' + rel;
  const headers = {
    authorization: 'Bearer ' + cfg.token,
    accept: 'application/vnd.github+json',
    'user-agent': 'RLTracker-Feedback/1.0',
    'x-github-api-version': '2022-11-28'
  };
  const put = async sha => {
    const body = { message: 'feedback: ' + rel, content: buf.toString('base64') };
    if (sha) body.sha = sha;
    return fetch(url, { method: 'PUT', headers, body: JSON.stringify(body),
                        signal: AbortSignal.timeout(HTTP_TIMEOUT) });
  };
  let r = await put(null);
  if (r.status === 422){                       // filen findes — hent sha og overskriv
    const g = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT) });
    if (g.ok){ const j = await g.json(); r = await put(j.sha); }
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + rel);
}

/* Egen collector: PUT rå bytes, identitet i headers. Digests er JSON og pakker
 * ~6:1 med gzip — ved 2000 testere er det forskellen på GB og hundreder af MB
 * om dagen på serverens linje, så alt over 4 KB komprimeres. */
async function httpPut(rel, buf){
  const gz = buf.length > 4096;
  const headers = {
    'x-tester': String(cfg.tester || 'anon'),
    'x-id': state.identity.id,
    'x-key': state.identity.key,
    'content-type': 'application/octet-stream',
    'user-agent': 'RLTracker-Feedback/1.0'
  };
  if (gz) headers['content-encoding'] = 'gzip';
  const r = await fetch(String(cfg.url).replace(/\/+$/, '') + '/v1/f/' + rel, {
    method: 'PUT', headers, body: gz ? zlib.gzipSync(buf) : buf,
    signal: AbortSignal.timeout(HTTP_TIMEOUT)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + rel);
}

async function tick(){
  if (!cfg) return;                             // stoppet (fravalg) — også hvis første-tick-timeren når at fyre
  if (running) return;                          // en langsom runde må ikke stable sig
  running = true;
  try{
    const sent = state.sent;
    // candidates() stat'er hele arkivet synkront (1.235 filer = ~0,5 s maalt 2/9);
    // over 250 ms siges det med navn, saa en blokering i server.log kan henfoeres
    const t0 = Date.now();
    const due = candidates().filter(c => !(sent[c.rel] >= c.mtime)).slice(0, BATCH_MAX);
    if (Date.now() - t0 > 250) log('[tid] feedback.candidates tog ' + (Date.now() - t0) + ' ms');
    if (!due.length) return;
    let ok = 0;
    for (const c of due){
      try{
        const buf = fs.readFileSync(c.abs);
        let hash = null;
        const minGap = BY_CONTENT.get(c.rel);
        if (minGap){
          hash = crypto.createHash('sha1').update(buf).digest('hex');
          const prev = state.sentHash[c.rel];
          if (prev && prev.sha1 === hash){ sent[c.rel] = c.mtime; continue; }   // same bytes as last upload
          if (prev && Date.now() - prev.at < minGap) continue;                  // changed, but too soon: next tick
        }
        if (cfg.kind === 'dry') log('[feedback] (dry) ville sende ' + c.rel + ' (' + buf.length + ' B)');
        else if (cfg.kind === 'http') await httpPut(c.rel, buf);
        else await ghPut(c.rel, buf);
        sent[c.rel] = c.mtime; ok++;
        if (hash) state.sentHash[c.rel] = { sha1: hash, at: Date.now() };
      }catch(e){
        log('[feedback] ' + c.rel + ' udskudt: ' + (e && e.message || e));
        break;                                  // netværk nede rammer alle — prøv igen næste tick
      }
    }
    if (ok){
      // cap: gamle stemplede filer der ikke længere findes ryddes op
      const live = new Set(candidates().map(c => c.rel));
      for (const k of Object.keys(sent)) if (!live.has(k)) delete sent[k];
      for (const k of Object.keys(state.sentHash)) if (!live.has(k)) delete state.sentHash[k];
      store.writeJSON(statePath(), state);
      log('[feedback] ' + ok + ' fil(er) sendt til ' + (cfg.kind === 'dry' ? 'dry-run (ingenting)'
                                                       : cfg.kind === 'http' ? cfg.url : cfg.repo));
    }
  }catch(e){ log('[feedback] tick-fejl (fortsætter): ' + (e && e.message || e)); }
  finally{ running = false; }
}

function init(opts){
  if (cfg) return;                    // allerede aktiv (testround.js kan kalde igen efter et tilvalg)
  ROOT = opts.root;
  log = opts.log || log;
  let raw = null;
  try{ raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); }catch{ return; }   // ingen fil = slået fra
  if (!raw || raw.enabled !== true) return;
  if (raw.kind === 'http'){
    if (!raw.url){ log('[feedback] feedback.json mangler url — slået fra'); return; }
  } else if (raw.kind !== 'dry' && (!raw.repo || !raw.token)){ log('[feedback] feedback.json mangler repo/token — slået fra'); return; }
  cfg = raw;
  state = store.readJSON(statePath(), () => ({ schema: 'feedback-state/1', sent: {}, sentHash: {}, identity: null }));
  if (!state.sent || typeof state.sent !== 'object') state.sent = {};
  if (!state.sentHash || typeof state.sentHash !== 'object') state.sentHash = {};
  /* Identiteten fødes lokalt og bor i STATE-filen, ikke i config: config kan
   * kopieres mellem maskiner/udleveres i en pakke — identiteten må ikke følge
   * med, for så skriver to testere oveni hinandens mapper på serveren. */
  if (cfg.kind === 'http' && !(state.identity && state.identity.id && state.identity.key)){
    state.identity = { id: crypto.randomBytes(6).toString('hex'),
                       key: crypto.randomBytes(24).toString('base64url') };
    store.writeJSON(statePath(), state);
  }
  const target = cfg.kind === 'http' ? cfg.url : cfg.kind === 'dry' ? 'dry' : cfg.repo;
  log('[feedback] testfeedback AKTIV (' + (cfg.kind || 'github') + ' -> ' + target + ') — kampe/rapporter deles i baggrunden, aldrig nøgler'
      + (cfg.includeLabels === true ? ', inkl. mærkater (opt-in)' : ', uden mærkater'));
  setTimeout(() => { tick(); }, FIRST_MS);
  timer = setInterval(() => { tick(); }, TICK_MS);
}

/* Fravalg mens processen kører (testround.js, gate 6): sluk uploaderen NU —
 * "fravalg = intet uploades nogensinde" må ikke vente på næste genstart. */
function stop(){
  if (timer){ clearInterval(timer); timer = null; }
  cfg = null; state = null; running = false;
}
function active(){ return !!cfg; }

module.exports = { init, stop, active, BY_CONTENT,
                   _tick: tick, _state: () => state };   // _tick/_state eksponeret til test-harness
