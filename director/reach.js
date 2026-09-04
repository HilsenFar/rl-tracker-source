/* RL Director — reach-tæller (13/8-2026).
 *
 * Måler om coach-fladerne overhovedet bliver ÅBNET — affødt af K4W-fundet
 * 13/8: en tester kan køre trackeren i ugevis uden at have set ét eneste råd,
 * og uden denne fil kan ingen bagefter skelne "coaching virkede ikke" fra
 * "coaching blev aldrig leveret". Ingen data er ikke et negativt resultat —
 * men kun hvis man VED at der ingen data var. Reach er den viden.
 *
 * Principper (arver feedback.js' ånd):
 * - KUN antal. Intet indhold, ingen URL'er ud over fladens art, ingen
 *   tidspunkter ud over spilledøgnet (06:00-reglen, samme som weekly.js).
 * - Tæller HENTNINGER, ikke garanterede menneskeblikke: et board-vindue der
 *   genåbnes automatisk tæller med, og demo-mode kan ikke skelnes server-side.
 *   Analyser skal læse tallene som "fladen blev hentet af en browser".
 * - En fejl må aldrig nå recorderen: alt er try/catch'et, flush højst hvert
 *   60. sekund og kun ved ændringer. Et tabt minut reach er ligegyldigt; en
 *   tabt kamp kan ikke genskabes.
 * - reach-state.json er en TILSTANDSFIL i ROOT: aldrig i PUBLIC_FILES, altid
 *   på zip-eksklusionslisten i deploy-runbooken — men den ER med i
 *   feedback-uploaden (candidates() i feedback.js), for reach hos testerne
 *   er hele pointen.
 */
'use strict';
const path = require('path');
const store = require('./store');

const FLUSH_MS = Number(process.env.REACH_FLUSH_MS) || 60 * 1000;   // env-styrbar til test
const DAY_START_HOUR = 6;            // spilledøgnet — samme regel som weekly.js

let ROOT = null, log = () => {};
let state = null, dirty = false;

function file(){ return path.join(ROOT, 'reach-state.json'); }

/* Spilledøgnet starter kl. 06:00 lokal tid: en session der løber til 03:00
 * hører til aftenen før — ellers deles brugerens nætter i to døgn. */
function dayKey(){
  const d = new Date(Date.now() - DAY_START_HOUR * 3600e3);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function hit(kind){
  try{
    if (!state || !/^[a-z_]{2,32}$/.test(kind)) return;
    const day = state.days[dayKey()] = state.days[dayKey()] || {};
    day[kind] = (day[kind] || 0) + 1;
    dirty = true;
  }catch{}
}

function flush(){
  if (!dirty) return;
  dirty = false;
  try{ store.writeJSON(file(), state); }catch{}
}

function init(opts){
  ROOT = opts.root;
  log = opts.log || log;
  state = store.readJSON(file(), () => ({ schema: 'reach/1', days: {} }));
  if (!state.days || typeof state.days !== 'object') state.days = {};
  const t = setInterval(flush, FLUSH_MS);
  if (t.unref) t.unref();
  log('[reach] tæller åbninger af coach-fladerne (kun antal, pr. spilledøgn)');
  return { hit, flush };
}

/* hit eksporteres også (25/8): pause-signalet i session.js tæller
 * pause_shown/followed/ignored/stop_shown — samme modulinstans via require-
 * cachen, og hit() er no-op indtil server.js har kaldt init. */
module.exports = { init, hit };
