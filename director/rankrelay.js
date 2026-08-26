/* RL Director — rank-relæ-klient (18/8-2026).
 *
 * Standardvejen til ranks for ALLE trackere: collectoren (collect.gitato.net)
 * holder ÉN PsyNet-læserkonto og svarer på POST /v1/rank {pids} med samme
 * normaliserede form som director/psynet.js giver lokalt ({p1,p2,p3,...}).
 * Så skal ingen tester oprette en Epic-konto, ingen nøgle forlader serveren,
 * og DuplicateLogin (én konto = én session) er umulig pr. konstruktion.
 *
 * Rækkefølgen i server.js: egen læserkonto (psynet.js, hvis brugeren har
 * forbundet én) → dette relæ → rocket-league10 (kvote). Relæet er ikke en
 * afhængighed: er det nede, backer klienten af i 60 s og næste kilde tager over.
 *
 * Konfiguration: RANK_RELAY (env) > director-ai.json.rankRelay > standard-URL.
 * "off"/false slår relæet fra. */
'use strict';

const DEFAULT_URL = 'https://collect.gitato.net';
const TIMEOUT_MS = 6000, BACKOFF_MS = 60e3, MAX_PIDS = 32;

function init(opts){
  const say = (opts && opts.log) || (() => {});
  const ua = (opts && opts.userAgent) || 'GitatoRLTracker/1.0';
  let url = (opts && opts.url !== undefined && opts.url !== null) ? opts.url : DEFAULT_URL;
  if (url === false || /^(off|false|0|none)$/i.test(String(url))) url = null;
  if (url) url = String(url).replace(/\/+$/, '');

  const st = { downUntil: 0, lastOkAt: 0, lastError: null, lookups: 0 };

  function enabled(){ return !!url; }
  function available(){ return !!url && Date.now() >= st.downUntil; }

  /* pids -> { pid: data|null }. Kaster ved netværks-/serverfejl (kalderen
   * falder videre til næste kilde); et tomt svar for en pid er null = ingen data. */
  /* opts.fresh = omgå serverens cache (selv-opslag efter en kamp). */
  async function getSkills(pids, opts){
    if (!url) throw new Error('relæ slået fra');
    if (Date.now() < st.downUntil) throw new Error('relæ i backoff');
    const ids = [...new Set((pids || []).map(String))].slice(0, MAX_PIDS);
    const out = {}; for (const p of ids) out[p] = null;
    if (!ids.length) return out;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try{
      const r = await fetch(url + '/v1/rank', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'Accept-Encoding': 'identity' },
        body: JSON.stringify(opts && opts.fresh ? { pids: ids, fresh: true } : { pids: ids })
      });
      if (!r.ok){
        const txt = (await r.text().catch(() => '')).trim().slice(0, 160);
        /* 503 = læserkontoen på serveren er nede, 429 = vi spørger for tit,
         * 5xx = serveren har det skidt — alle er "prøv igen om lidt", ikke
         * "spørg hvert sekund". 4xx ellers er vores egen fejl og logges. */
        st.lastError = 'HTTP ' + r.status + (txt ? ' ' + txt : '');
        st.downUntil = Date.now() + (r.status === 429 ? 2 * BACKOFF_MS : BACKOFF_MS);
        throw new Error(st.lastError);
      }
      const j = await r.json();
      if (!j || typeof j.ranks !== 'object') throw new Error('ukendt svarform');
      for (const p of ids) if (p in j.ranks) out[p] = j.ranks[p] || null;
      st.lastOkAt = Date.now(); st.lastError = null; st.lookups++;
      return out;
    }catch(e){
      if (!st.lastError || !/^HTTP/.test(st.lastError)){
        st.lastError = e && e.name === 'AbortError' ? 'timeout (' + TIMEOUT_MS + ' ms)' : String(e && e.message || e);
        st.downUntil = Date.now() + BACKOFF_MS;
      }
      say('[rankrelay] ' + st.lastError);
      throw e;
    }finally{ clearTimeout(timer); }
  }
  function status(){
    return { url, enabled: enabled(), available: available(), lastOkAt: st.lastOkAt || null,
      lastError: st.lastError, downUntil: st.downUntil > Date.now() ? st.downUntil : null, lookups: st.lookups };
  }
  return { enabled, available, getSkills, status, url };
}

module.exports = { init, DEFAULT_URL };
