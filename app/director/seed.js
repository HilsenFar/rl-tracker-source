/* RL Director — standard-baseline for gæster (19/8-2026).
 *
 * Brugerens krav: en gæst (typisk en Switch-medspiller, der aldrig kan få
 * appen selv) skal coaches fra KAMP 1, ikke efter ti kampe — man spiller
 * sjældent ti kampe i træk med samme medspiller, og vejledningen skal kunne
 * gives undervejs. Så en gæsteprofil starter på en standard, der er lagt på
 * forhånd, og glider derfra over i gæstens egen normal (samme EWMA som alle
 * andre: efter ~20 kampe er standarden stort set vasket ud).
 *
 * Standarden er MÅLT, ikke opfundet: den er gennemsnittet pr. playlist-spand af
 * hver metrik over ALLE spillere i ALLE digests i matches/ — ejeren, hans
 * medspillere og modstandere i de lobbyer han faktisk spiller i. Det er det
 * eneste "standard" systemet ærligt kan sige noget om; det er ikke et rank-
 * benchmark og bliver aldrig kaldt ét. Boost-metrikker findes kun for ejerens
 * eget hold (SPECTATOR-felter), så de hviler på færre spiller-kampe — tallet
 * står ved hver metrik.
 *
 * Samme motor som alt andet: metrics.computeMetrics(digest, player) pr.
 * spiller, i den fart-enhed der er konfigureret nu (ejerens). En gæstedebrief
 * siger "standarden" hvor ejerens siger "din normal" (director.relabel), og
 * spanden bærer `seeded:true` så ingen flade kan forveksle de to.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./metrics');

const SCHEMA = 'seed-baseline/1';
const MAX_AGE_MS = 7 * 24 * 3600e3;      // genbygges stille når den er ældre

function seedPath(root){ return path.join(root, 'seed-baseline.json'); }

/* Trimmet gennemsnit (10 % i hver ende): én spiller der stod stille i første
 * tredjedel giver en speed_drift på flere hundrede, og ét sådant tal må ikke
 * flytte standarden for alle. Samme tal-semantik som ejerens EWMA-normal
 * (et gennemsnit), bare uden halerne. */
function trimmedMean(values){
  const v = values.slice().sort((a, b) => a - b);
  const cut = Math.floor(v.length * 0.1);
  const core = v.slice(cut, v.length - cut);
  return core.reduce((x, y) => x + y, 0) / core.length;
}

function isRealPlayer(p){
  if (!p || typeof p.pid !== 'string') return false;
  if (p.pid === 'Unknown|0|0' || p.pid.startsWith('Demo|')) return false;
  const parts = p.pid.split('|');
  return parts.length >= 3 && !!parts[0] && !!parts[1] && parts[1] !== '0';
}

/* Gå hele arkivet igennem. Returnerer seed-objektet (skriver det ikke). */
function build(root, log){
  const dir = path.join(root, 'matches');
  const out = { schema: SCHEMA, builtAt: new Date().toISOString(), speedUnit: M.currentUnit ? M.currentUnit() : null,
                matches: 0, playerMatches: 0, playlists: {} };
  let files = [];
  try{ files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort(); }
  catch{ return out; }
  const acc = {};                           // key -> id -> { sum, n }
  for (const f of files){
    let d;
    try{ d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }catch{ continue; }
    if (!d || !Array.isArray(d.players) || d.players.length < 2) continue;
    if (!(d.kickoffs || []).length) continue;                 // samme port som validity(): ingen kickoffs = artefakt
    if (d.abandoned) continue;
    try{ if (M.isPrivate(d) === true) continue; }catch{}
    let key;
    try{ key = M.bucketOf(d).key; }catch{ continue; }
    if (!key) continue;
    let counted = false;
    for (const p of d.players){
      if (!isRealPlayer(p)) continue;
      let mm;
      try{ mm = M.computeMetrics(d, p); }catch{ continue; }
      const ids = Object.keys(mm);
      if (!ids.length) continue;
      const a = acc[key] || (acc[key] = { players: 0, metrics: {} });
      a.players++;
      for (const id of ids){
        const e = a.metrics[id] || (a.metrics[id] = []);
        e.push(mm[id].value);
      }
      out.playerMatches++; counted = true;
    }
    if (counted) out.matches++;
  }
  for (const key of Object.keys(acc)){
    const a = acc[key];
    const metrics = {};
    for (const id of Object.keys(a.metrics)){
      const v = a.metrics[id];
      if (v.length >= M.MIN_BASELINE) metrics[id] = { mean: trimmedMean(v), n: v.length };   // under ti spiller-kampe er ingen standard
    }
    if (Object.keys(metrics).length) out.playlists[key] = { playerMatches: a.players, metrics };
  }
  if (log) log('[seed] standard-baseline: ' + out.matches + ' kampe, ' + out.playerMatches + ' spiller-kampe, spande: '
    + Object.keys(out.playlists).map(k => k + ' (' + out.playlists[k].playerMatches + ')').join(', '));
  return out;
}

function read(root){
  try{
    const s = JSON.parse(fs.readFileSync(seedPath(root), 'utf8'));
    return s && s.schema === SCHEMA ? s : null;
  }catch{ return null; }
}

/* Læs den gemte standard, eller byg og gem en ny når den mangler/er gammel. */
function ensure(root, log, store){
  let s = read(root);
  const stale = !s || !s.builtAt || Date.now() - Date.parse(s.builtAt) > MAX_AGE_MS;
  if (stale){
    s = build(root, log);
    try{ (store && store.writeJSON ? store.writeJSON(seedPath(root), s, 1) : fs.writeFileSync(seedPath(root), JSON.stringify(s, null, 1))); }
    catch(e){ if (log) log('[seed] kunne ikke gemme: ' + (e.message || e)); }
  }
  return s;
}

/* Læg standarden ind i en (gæste)profil. Kun spande gæsten endnu ikke har en
 * moden normal i: en spand med < MIN_BASELINE egne kampe erstattes af
 * standarden (de få kampe var ikke dømt alligevel — de var "indsamler"), en
 * moden eller allerede seedet spand røres ikke. n sættes til MIN_BASELINE,
 * så porten er åben fra første kamp; `seeded:true` + `seedN` (spiller-kampe
 * bag standarden) bliver stående på spanden, så enhver flade kan sige hvad
 * den dømmer imod. Returnerer antal spande der blev seedet. */
function apply(profile, seed){
  if (!profile || !seed || !seed.playlists) return 0;
  if (!profile.playlists || typeof profile.playlists !== 'object') profile.playlists = {};
  let n = 0;
  for (const key of Object.keys(seed.playlists)){
    const s = seed.playlists[key];
    const cur = profile.playlists[key];
    if (cur && (cur.seeded || (cur.n || 0) >= M.MIN_BASELINE)) continue;
    const metrics = {};
    for (const id of Object.keys(s.metrics)) metrics[id] = { mean: s.metrics[id].mean, n: M.MIN_BASELINE };
    profile.playlists[key] = { n: M.MIN_BASELINE, metrics, seeded: true, seedN: s.playerMatches, seededAt: seed.builtAt,
                               idWeight: 0, kinds: {} };
    n++;
  }
  if (n){
    profile.seeded = { at: new Date().toISOString(), from: 'seed-baseline.json', builtAt: seed.builtAt,
                       matches: seed.matches, playerMatches: seed.playerMatches };
  }
  return n;
}

module.exports = { SCHEMA, seedPath, build, read, ensure, apply };
