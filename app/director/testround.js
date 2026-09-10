/* RL Director — testrundens dør (25/8-2026, gate 6 før Reddit-rekruttering).
 *
 * To ting, begge bag tynde ruter i server.js (/api/testround, /api/feedback),
 * så al logik kan ændres uden SEA-genbyg:
 *
 * 1. FØRSTE-KØRSELS-VALGET "Join the test round?". Én offentlig build, intet
 *    forudfyldt: valget skriver feedback.json (via store.js — aldrig bar
 *    writeFileSync i director-laget). Tilvalg = enabled:true, kind:'http' mod
 *    collectoren — præcis den config feedback.js altid har kørt på; fravalg =
 *    enabled:false + declined, så spørgsmålet aldrig stilles igen og
 *    feedback.js forbliver slukket (dens egen regel: enabled !== true = tavs).
 *    Ærligheden bor i UI-teksten; HER håndhæves kun at fravalg også stopper en
 *    KØRENDE uploader med det samme (feedback.stop()).
 *
 * 2. FEEDBACK-BESKEDEN: fritekst fra appen videre til collectorens åbne
 *    /v1/feedback. Ingen tokens i buildet (PAT-zip-flowet er dødt for
 *    fremmede) — collectoren værner sig selv med kvoter. Identiteten (id fra
 *    feedback-state.json) lægges ved NÅR den findes, så en besked kan parres
 *    med testerens kampdata; uden identitet er beskeden stadig velkommen.
 *
 * En config med kind 'github' (det gamle K4W-flow) ejes af mennesker og røres
 * aldrig herfra — status() melder den blot som afgjort/tilmeldt.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');
const feedback = require('./feedback');

const DEFAULT_URL = 'https://collect.gitato.net';
const SEND_TIMEOUT = 10000;

let ROOT = null, log = () => {};

function cfgPath(){ return path.join(ROOT, 'feedback.json'); }
function readCfg(){ try{ return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); }catch{ return null; } }

function status(){
  const c = readCfg();
  if (!c || typeof c !== 'object') return { decided: false, joined: false, tester: null };
  if (c.enabled === true) return { decided: true, joined: true, tester: c.tester || null };
  return { decided: true, joined: false, tester: null };
}

function choose(join, tester){
  const c = readCfg();
  if (c && c.kind && c.kind !== 'http' && c.kind !== 'dry')
    return { ok: false, reason: 'feedback.json er sat op manuelt (' + c.kind + ') — ret den i hånden', ...status() };
  if (join === true){
    const t = String(tester || '').replace(/[^\w.-]/g, '_').slice(0, 24) || 'anon';
    store.writeJSON(cfgPath(), { enabled: true, kind: 'http', url: DEFAULT_URL, tester: t,
      joinedAt: new Date().toISOString() });
    try{ feedback.init({ root: ROOT, log }); }catch(e){ log('[testround] feedback-start fejlede: ' + (e && e.message || e)); }
    log('[testround] tilmeldt testrunden som "' + t + '" — kamprapporter deles i baggrunden (aldrig nøgler)');
  }else{
    store.writeJSON(cfgPath(), { enabled: false, declined: true, decidedAt: new Date().toISOString() });
    try{ feedback.stop(); }catch{}
    log('[testround] testrunden fravalgt — intet uploades');
  }
  return { ok: true, ...status() };
}

async function send(text, meta){
  const t = String(text || '').trim().slice(0, 4000);
  if (!t) return { ok: false, reason: 'tom besked' };
  const c = readCfg();
  const url = (c && c.kind === 'http' && c.url ? String(c.url) : DEFAULT_URL).replace(/\/+$/, '');
  let ident = null;
  try{ ident = JSON.parse(fs.readFileSync(path.join(ROOT, 'feedback-state.json'), 'utf8')).identity || null; }catch{}
  const body = { text: t,
    tester: (c && c.tester) || null,
    id: (ident && ident.id) || null,
    app: (meta && meta.app) || null };
  try{
    const r = await fetch(url + '/v1/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'User-Agent': (meta && meta.userAgent) || 'GitatoRLTracker/1.0' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT)
    });
    if (!r.ok){
      const txt = (await r.text().catch(() => '')).trim().slice(0, 120);
      return { ok: false, reason: 'HTTP ' + r.status + (txt ? ' ' + txt : '') };
    }
    log('[testround] feedback sendt (' + t.length + ' tegn)');
    return { ok: true };
  }catch(e){
    return { ok: false, reason: e && e.name === 'TimeoutError' ? 'timeout' : String(e && e.message || e) };
  }
}

function init(opts){
  ROOT = opts.root;
  log = opts.log || log;
  return { status, choose, send };
}

module.exports = { init };
