/* RL Director — rank via spillets egen backend (PsyNet), 18/8-2026.
 *
 * Brugerens fund: Rocket Leagues private /Services-API (dokumenteret i
 * github.com/AeonLucid/RocketLeaguePublic, levende reference-implementering
 * github.com/dank/rlapi — dette modul er en 1:1 Node-port af det NØDVENDIGE
 * derfra, ikke mere). Skills/GetPlayersSkills giver Tier/Division/Mu pr.
 * playlist for VILKÅRLIGE PlayerIDs (Epic|..|0, PS4|..|0, Switch|..|0 …) i ét
 * kald på ~150 ms, uden døgnkvote. Spike-bevis 18/8: DXXØ = TRN på tallet.
 *
 * KÆDEN:  Epic-launcher-token (auth-code én gang → refresh-token, ~23 dages
 *         glidende levetid) → exchange-code → EOS-token for RL's deployment
 *         → Auth/AuthPlayer v2 (HTTP, HMAC-signeret) → PsyToken (45 s!) →
 *         websocket-RPC (holdes åben m. ping/pong, genforbinder selv, og
 *         FORNYES planlagt før PsyNets 4-timers sessions-grænse — se
 *         PSY.sessionMaxMs og recycle()).
 *
 * TO REGLER MÅLT I SPIKEN, IKKE ANTAGET:
 *  1. Én konto = én PsyNet-session. Logger man ind på SPILLERENS egen konto,
 *     kicker serveren spillets backend-session ("disconnected — reconnect?" i
 *     spillet) og spillet kicker os igen 70 s senere (DuplicateLogin). Derfor
 *     kører modulet på en SEPARAT LÆSERKONTO (gratis Epic-konto, behøver ikke
 *     engang at have startet spillet). init() nægter at bruge en konto der er
 *     identisk med den trackede spiller.
 *  2. Refresh-tokens ROTERER ved hver brug (det gamle = TOKEN_NOT_FOUND). Det
 *     nye gemmes straks, og KUN denne proces må eje psynet-auth.json.
 *
 * PsyBuildID/FeatureSet skifter ved hver RL-patch. Konstanterne herunder er
 * rlapi's (build 260811.1257.524913, verificeret mod den installerede exe), men
 * modulet læser selv versionen ud af RocketLeague.exe (UTF-16-scan, samme
 * princip som rlapi tools/version) når Epic-manifestets CL ikke matcher — så en
 * patch-tirsdag ikke slår ranks fra indtil næste app-version.
 *
 * Alt her er brugerens egen læserkonto, der læser offentlige rank-tal. Der
 * skrives aldrig noget til Psyonix ud over login og opslag.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ---- Epic Games Store (launcher-klienten, samme som rlapi/legendary) ---- */
const EGS = {
  ua: 'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
  clientId: '34a02cf8f4414e29b15921876da36f9a',
  secret: 'daafbccc737745039dffe53d94fc76cf',
  host: 'account-public-service-prod03.ol.epicgames.com'
};
/* ---- Epic Online Services: Rocket Leagues deployment + klient ---- */
const EOS = {
  deploymentId: 'da32ae9c12ae40e8a112c52e1f17f3ba',
  clientId: 'xyza7891p5D7s9R6Gm6moTHWGloerp7B',
  secret: 'Knh18du4NVlFs+3uQ+ZPpDCVto0WYf4yXP8+OcwVt1o',
  tokenUrl: 'https://api.epicgames.dev/epic/oauth/v2/token'
};
/* ---- PsyNet ---- */
const PSY = {
  baseUrl: 'https://api.rlpp.psynet.gg/rpc',
  gameVersion: '260811.1257.524913',
  featureSet: 'PrimeUpdate59_1',
  sigKey: 'c338bd36fb8c42b1a431d30add939fc7',
  pingMs: 20e3, pongMs: 10e3, rpcTimeoutMs: 12e3,
  /* PsyNet lukker enhver session ~4t00 efter AuthPlayer — målt i collector-
   * journalen 18-20/8: to uafhængige processtarter fik første DuplicateLogin
   * præcis +4t00m02s efter connect, alle senere kom 4t00-4t01 efter hver
   * genforbindelse. Forny selv i god tid før grænsen. */
  sessionMaxMs: 230 * 60e3
};

const AUTH_FILE = 'psynet-auth.json';
const TIERS = ['Unranked', 'Bronze I', 'Bronze II', 'Bronze III', 'Silver I', 'Silver II', 'Silver III',
  'Gold I', 'Gold II', 'Gold III', 'Platinum I', 'Platinum II', 'Platinum III', 'Diamond I', 'Diamond II',
  'Diamond III', 'Champion I', 'Champion II', 'Champion III', 'Grand Champion I', 'Grand Champion II',
  'Grand Champion III', 'Supersonic Legend'];
/* p1/p2/p3 er boardets og weekly.js' kontrakt (samme som rankapi.js). 34 =
 * turneringer rider med under eget navn — turneringer TÆLLER i målingerne
 * (brugerens beslutning 17/8), men er ikke en af de tre ladder-chips. */
const PLAYLIST_KEY = { 10: 'p1', 11: 'p2', 13: 'p3', 34: 'tournaments' };

/* PsyBuildID = CRC-32 (ikke-reflekteret, big-endian, poly 04C11DB7) over
 * gameVersion som UTF-16LE, som signed int32. Port af rlapi buildid.go. */
function crc32be(bytes){
  let crc = 0xFFFFFFFF;
  for (const b of bytes){
    crc = (crc ^ (b << 24)) >>> 0;
    for (let i = 0; i < 8; i++){
      crc = ((crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1)) >>> 0;
    }
  }
  return (crc ^ 0xFFFFFFFF) | 0;
}
function buildIdOf(gameVersion){
  const buf = Buffer.from(String(gameVersion), 'utf16le');
  return String(crc32be(buf));
}
function psySig(body){
  return crypto.createHmac('sha256', PSY.sigKey).update('-').update(body).digest('base64');
}
function mmrOf(mu){ return Math.round(mu * 20 + 100); }   // spillets viste MMR (bekræftet mod TRN 18/8)

/* Watcher-vagten (25/8, gate 4): er DENNE fejl en auth-afvisning fra kæden
 * (EGS-refresh, exchange, EOS, AuthPlayer)? Kun 4xx-svar tæller — 429 er
 * kø-styring, 5xx og netværksfejl er upstreams problem, og DuplicateLogin er
 * sessions-mekanik (håndteret i teardown), aldrig en afvisning af KONTOEN.
 * Bemærk at "AuthPlayer <Type>: ..." også fanger patch-dags-afvisninger
 * (forkert PsyBuildID) — det er med vilje: begge kræver et menneske, og
 * skellet står i lastError, som admin-fladen viser. */
/* Hver af kædens fire HTTP-kald (EGS-token, exchange, EOS-token, AuthPlayer)
 * får denne frist (3/9). Uden den var undicis 300 s headers-timeout grænsen:
 * en upstream der tager TCP'en og så tier, holdt connect() — og dermed hvert
 * rank-opslag på boardet — i fem minutter, før relæ/rankapi fik lov. */
const FETCH_TIMEOUT_MS = 15e3;

function isAuthReject(msg){
  const s = String(msg || '');
  if (/429/.test(s)) return false;
  return /^EGS 4\d\d|^EGS exchange 4\d\d|^EOS 4\d\d|^AuthPlayer HTTP 4\d\d|^AuthPlayer (?!HTTP )[A-Za-z]/.test(s);
}
/* Sammenfattet dom over læserkontoen, til DRIFT (admin-status + log — aldrig
 * en offentlig flade): 'ok' = forbundet eller kortvarig churn (planlagt
 * fornyelse, genforbindelse); 'down' = ude i over DOWN_AFTER_MS af ikke-auth-
 * årsager (net, upstream, fremmed session der holder kontoen); 'auth-dead' =
 * mindst AUTH_DEAD_MIN sammenhængende auth-afvisninger over mindst
 * AUTH_DEAD_SPAN_MS — det billede en konto lukket af Psyonix efterlader.
 * Tærsklerne er sat efter backoff-kurven (5 s -> 10 min loft): fire ægte
 * afvisninger spænder altid flere minutter, og 20 minutters vindue gør et
 * enkelt blip umuligt at forveksle med en død konto. */
const AUTH_DEAD_MIN = 4, AUTH_DEAD_SPAN_MS = 20 * 60e3, DOWN_AFTER_MS = 15 * 60e3;
function judgeHealth(st){
  if (!st.auth) return { state: 'unconfigured', since: null, authFails: st.authFails };
  if (st.connected) return { state: 'ok', since: st.since || null, authFails: 0 };
  const now = Date.now();
  if (st.authFails >= AUTH_DEAD_MIN && st.authFailFirstAt && now - st.authFailFirstAt >= AUTH_DEAD_SPAN_MS)
    return { state: 'auth-dead', since: st.authFailFirstAt, authFails: st.authFails };
  if (st.downSince && now - st.downSince >= DOWN_AFTER_MS)
    return { state: 'down', since: st.downSince, authFails: st.authFails };
  return { state: 'ok', since: st.since || null, authFails: st.authFails };
}

/* Rå Skills-liste -> boardets kontrakt. Tier 0 = placeringskampe ikke færdige. */
function normalize(skills){
  if (!Array.isArray(skills) || !skills.length) return null;
  const out = {};
  for (const s of skills){
    if (!s || typeof s !== 'object') continue;
    const key = PLAYLIST_KEY[Number(s.Playlist)];
    if (!key) continue;
    const tier = Number(s.Tier) || 0;
    out[key] = {
      label: TIERS[tier] || ('Tier ' + tier),
      division: (Number(s.Division) || 0) + 1,
      mmr: Number.isFinite(Number(s.Mu)) ? mmrOf(Number(s.Mu)) : null,
      mu: Number(s.Mu), sigma: Number(s.Sigma), tier,
      matches: Number.isFinite(Number(s.MatchesPlayed)) ? Number(s.MatchesPlayed) : null,
      placement: Number.isFinite(Number(s.PlacementMatchesPlayed)) ? Number(s.PlacementMatchesPlayed) : null,
      streak: Number.isFinite(Number(s.WinStreak)) ? Number(s.WinStreak) : null
    };
  }
  if (!out.p1 && !out.p2 && !out.p3) return null;
  out.source = 'psynet';
  return out;
}

/* ---- version-detektion fra RocketLeague.exe (valgfri, selvhelende) ----
 * Epic-manifestet giver installationsstien og "++Prime+Update59.1-CL-524913".
 * CL'et er versionens sidste led; FeatureSet er "PrimeUpdate59_1". Selve
 * build-strengen (dato.tid.CL) står i exe'en som UTF-16 — vi scanner efter
 * \d{6}\.\d{3,5}\.<CL>, så manifestets CL pinner det rigtige match. */
function findInstall(){
  try{
    const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
    for (const f of fs.readdirSync(dir)){
      if (!f.endsWith('.item')) continue;
      let m; try{ m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }catch{ continue; }
      if (!/rocket\s*league/i.test(String(m.DisplayName || ''))) continue;
      const exe = path.join(String(m.InstallLocation || ''), 'Binaries', 'Win64', 'RocketLeague.exe');
      const cl = String(m.AppVersionString || '').match(/CL-(\d+)/);
      const upd = String(m.AppVersionString || '').match(/Update(\d+)(?:\.(\d+))?/i);
      return { exe, cl: cl ? cl[1] : null,
        featureSet: upd ? 'PrimeUpdate' + upd[1] + '_' + (upd[2] || '0') : null,
        appVersion: m.AppVersionString || null };
    }
  }catch{}
  return null;
}
function detectVersion(inst){
  if (!inst || !inst.exe || !inst.cl) return null;
  let data; try{ data = fs.readFileSync(inst.exe); }catch{ return null; }
  // gameVersion: UTF-16LE "NNNNNN.NNNN.<CL>"
  const needle = Buffer.from('.' + inst.cl, 'utf16le');
  let gameVersion = null;
  for (let pos = data.indexOf(needle); pos >= 0 && !gameVersion; pos = data.indexOf(needle, pos + 2)){
    if (pos % 2) continue;
    // gå baglæns over cifre og punktum
    let start = pos;
    while (start >= 2){
      const c = data.readUInt16LE(start - 2);
      if ((c >= 0x30 && c <= 0x39) || c === 0x2e) start -= 2; else break;
    }
    const s = data.toString('utf16le', start, pos + needle.length);
    if (/^\d{6}\.\d{3,5}\.\d+$/.test(s)) gameVersion = s;
  }
  // featureSet: højeste "PrimeUpdate<major><suffix>" i exe'en (samme regel som rlapi)
  const pu = Buffer.from('PrimeUpdate', 'utf16le');
  let best = null;
  for (let pos = data.indexOf(pu); pos >= 0; pos = data.indexOf(pu, pos + 2)){
    if (pos % 2) continue;
    let s = '', i = pos + pu.length;
    while (i + 1 < data.length){ const c = data.readUInt16LE(i); if (c <= 0x20 || c > 0x7e) break; s += String.fromCharCode(c); i += 2; }
    const m = s.match(/^(\d+)(\S*)$/);
    if (!m) continue;
    const cand = { major: Number(m[1]), suffix: m[2], full: 'PrimeUpdate' + s };
    if (!best || cand.major > best.major || (cand.major === best.major && cand.suffix > best.suffix)) best = cand;
  }
  return { gameVersion, featureSet: best ? best.full : (inst.featureSet || null) };
}

/* ======================================================================== */

function init(opts){
  const ROOT = opts.ROOT;
  const say = opts.log || (() => {});
  const onEvent = opts.onEvent || (() => {});
  const trackedPid = opts.trackedPid || (() => null);
  const authPath = path.join(ROOT, AUTH_FILE);

  const st = {
    auth: null,               // { egsRefreshToken, egsRefreshExpiresAt, accountId, displayName, savedAt }
    eos: null,                // { accessToken, expiresAt, accountId }
    ws: null, connected: false, connecting: null,
    sessionId: null, since: 0,
    reqNo: 0, pending: new Map(),
    pingTimer: null, pongTimer: null, keepalive: null,
    reconnectAt: 0, backoffMs: 5e3, closeReason: '',
    lastError: null, lastLookupAt: 0, lookups: 0,
    gameVersion: PSY.gameVersion, featureSet: PSY.featureSet, versionSource: 'rlapi-konstant',
    duplicateLogins: 0, recycles: 0,
    /* Watcher-vagten (25/8, gate 4): tæller SAMMENHÆNGENDE auth-afvisninger på
     * tværs af connect-forsøg, så health() kan skelne "netværksbøvl/planlagt
     * fornyelse" fra "kontoen er lukket/kæden afviser os vedvarende". Nulstilles
     * KUN af en åben websocket — en netværksfejl imellem hverken øger eller
     * nulstiller (den beviser intet om auth). */
    authFails: 0, authFailFirstAt: 0, downSince: 0
  };

  function loadAuth(){
    try{ st.auth = JSON.parse(fs.readFileSync(authPath, 'utf8')); }catch{ st.auth = null; }
    if (st.auth && !st.auth.egsRefreshToken) st.auth = null;
  }
  function saveAuth(){
    try{
      const tmp = authPath + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st.auth, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, authPath);
    }catch(e){ say('[psynet] kunne ikke gemme auth: ' + String(e.message || e)); }
  }
  function forgetAuth(){
    st.auth = null; st.eos = null;
    try{ fs.unlinkSync(authPath); }catch{}
  }

  /* ---- versions-vagt: manifest + exe slår konstanten når de er enige ----
   * Uden spil på maskinen (collectoren!) kan en patch-dag rettes ved at lægge
   * {"gameVersion":"...","featureSet":"PrimeUpdateNN_M"} i ROOT/psynet-version.json
   * — læses ved start, ingen kodedeploy. rlapi's tools/version giver tallene. */
  function refreshVersion(){
    try{
      const o = JSON.parse(fs.readFileSync(path.join(ROOT, 'psynet-version.json'), 'utf8'));
      if (o && /^\d{6}\.\d{3,5}\.\d+$/.test(String(o.gameVersion)) && /^PrimeUpdate\d+/.test(String(o.featureSet))){
        st.gameVersion = String(o.gameVersion); st.featureSet = String(o.featureSet);
        st.versionSource = 'psynet-version.json (manuel override)';
        return;
      }
    }catch{}
    const inst = findInstall();
    if (!inst || !inst.cl) return;
    if (PSY.gameVersion.endsWith('.' + inst.cl)){ st.versionSource = 'rlapi-konstant (=installeret CL ' + inst.cl + ')'; return; }
    const v = detectVersion(inst);
    if (v && v.gameVersion && v.featureSet){
      st.gameVersion = v.gameVersion; st.featureSet = v.featureSet;
      st.versionSource = 'læst fra RocketLeague.exe (' + inst.appVersion + ')';
      say('[psynet] spillet er patchet — bruger version ' + v.gameVersion + ' / ' + v.featureSet + ' læst fra exe');
    }else{
      st.versionSource = 'ADVARSEL: installeret CL ' + inst.cl + ' ≠ konstant, og exe-læsning fejlede';
      say('[psynet] ' + st.versionSource);
    }
  }

  /* ---- Epic (EGS) ---- */
  async function egsToken(form){
    const body = new URLSearchParams(form).toString();
    const r = await fetch('https://' + EGS.host + '/account/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': EGS.ua,
        'Authorization': 'Basic ' + Buffer.from(EGS.clientId + ':' + EGS.secret).toString('base64') },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('EGS ' + r.status + ' ' + (j.errorCode || '') + ' ' + (j.errorMessage || ''));
    return j;
  }
  function rememberEgs(j){
    st.auth = {
      egsRefreshToken: j.refresh_token,
      egsRefreshExpiresAt: j.refresh_expires_at || (j.refresh_expires ? new Date(Date.now() + j.refresh_expires * 1e3).toISOString() : null),
      accountId: j.account_id, displayName: j.displayName || null,
      savedAt: new Date().toISOString()
    };
    saveAuth();
  }
  async function egsAccess(){
    if (!st.auth) throw new Error('ingen læserkonto forbundet');
    const j = await egsToken({ grant_type: 'refresh_token', refresh_token: st.auth.egsRefreshToken, token_type: 'eg1' });
    rememberEgs(j);            // ROTATION: det gamle token er dødt fra nu af
    return j;
  }
  async function eosAccess(){
    if (st.eos && Date.now() < st.eos.expiresAt - 60e3) return st.eos;
    const egs = await egsAccess();
    const xr = await fetch('https://' + EGS.host + '/account/api/oauth/exchange', {
      headers: { 'Authorization': 'bearer ' + egs.access_token, 'User-Agent': EGS.ua },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const xj = await xr.json().catch(() => ({}));
    if (!xr.ok || !xj.code) throw new Error('EGS exchange ' + xr.status + ' ' + (xj.errorCode || ''));
    const body = new URLSearchParams({ grant_type: 'exchange_code', exchange_code: xj.code,
      deployment_id: EOS.deploymentId, scope: 'basic_profile' }).toString();
    const er = await fetch(EOS.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': EGS.ua,
        'Authorization': 'Basic ' + Buffer.from(EOS.clientId + ':' + EOS.secret).toString('base64') },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const ej = await er.json().catch(() => ({}));
    if (!er.ok || !ej.access_token) throw new Error('EOS ' + er.status + ' ' + (ej.errorCode || ej.error || ''));
    st.eos = { accessToken: ej.access_token, accountId: ej.account_id,
      expiresAt: Date.now() + (Number(ej.expires_in) || 7200) * 1e3 };
    return st.eos;
  }

  /* ---- PsyNet HTTP (kun AuthPlayer) ---- */
  function nextReqId(){ return 'PsyNetMessage_X_' + (st.reqNo++); }
  async function authPlayer(){
    const eos = await eosAccess();
    const req = {
      Platform: 'Epic', PlayerName: st.auth.displayName || '', PlayerID: eos.accountId, Language: 'INT',
      AuthTicket: eos.accessToken, BuildRegion: '', FeatureSet: st.featureSet, Device: 'PC',
      LocalFirstPlayerID: 'Epic|' + eos.accountId + '|0', bSkipAuth: false, bSetAsPrimaryAccount: true,
      EpicAuthTicket: eos.accessToken, EpicAccountID: eos.accountId
    };
    const body = JSON.stringify(req);
    const r = await fetch(PSY.baseUrl + '/Auth/AuthPlayer/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'RL Win/' + st.gameVersion + ' gzip (x86_64-pc-win32) curl-7.67.0 Schannel',
        'PsyBuildID': buildIdOf(st.gameVersion), 'PsyEnvironment': 'Prod',
        'PsyRequestID': nextReqId(), 'PsySig': psySig(body)
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error('AuthPlayer HTTP ' + r.status);
    const j = await r.json();
    if (j.Error) throw new Error('AuthPlayer ' + (j.Error.Type || '') + ': ' + (j.Error.Message || ''));
    const res = j.Result || {};
    if (!res.PsyToken || !res.PerConURLv2) throw new Error('AuthPlayer: intet PsyToken/PerConURLv2');
    return res;
  }

  /* ---- websocket-RPC ---- */
  function buildMessage(headers, bodyObj){
    let msg = '';
    let json = '';
    if (bodyObj !== undefined){ json = JSON.stringify(bodyObj); headers.PsySig = psySig(json); }
    for (const [k, v] of Object.entries(headers)) msg += k + ': ' + v + '\r\n';
    return msg + '\r\n' + json;
  }
  function parseMessage(text){
    const i = text.indexOf('\r\n\r\n');
    if (i < 0) return null;
    const headers = {};
    for (const line of text.slice(0, i).split('\r\n')){
      const c = line.indexOf(':'); if (c < 0) continue;
      headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
    }
    let body = null; try{ body = JSON.parse(text.slice(i + 4)); }catch{}
    return { headers, body };
  }
  function clearTimers(){
    if (st.pingTimer){ clearTimeout(st.pingTimer); st.pingTimer = null; }
    if (st.pongTimer){ clearTimeout(st.pongTimer); st.pongTimer = null; }
  }
  function schedulePing(){
    clearTimers();
    st.pingTimer = setTimeout(() => {
      if (!st.connected || !st.ws) return;
      try{ st.ws.send(buildMessage({ PsyPing: '' })); }catch{ return teardown('ping-send-fejl'); }
      st.pongTimer = setTimeout(() => teardown('pong-timeout'), PSY.pongMs);
    }, PSY.pingMs);
  }
  function teardown(reason){
    clearTimers();
    const ws = st.ws;
    st.ws = null; st.connected = false; st.sessionId = null;
    st.closeReason = reason || '';
    if (!st.downSince) st.downSince = Date.now();
    for (const [, p] of st.pending){ try{ p.reject(new Error('forbindelsen lukkede (' + reason + ')')); }catch{} }
    st.pending.clear();
    if (ws){ try{ ws.close(); }catch{} }
    /* DuplicateLogin har TO betydninger, og alderen skiller dem (målt 18-20/8):
     * kommer den efter ~4 timer, er det PsyNets eget sessions-udløb i forklædning
     * — ingen bruger kontoen, genforbind hurtigt. Kommer den FØR grænsen, er det
     * en ægte anden session på LÆSERKONTOEN (spillet startet på den? en anden
     * tracker-instans?) — genforbindelse med det samme ville bare kicke den
     * anden, så vent længe og sig det højt. */
    if (/DuplicateLogin/i.test(String(reason))){
      st.duplicateLogins++;
      const ageMs = st.since ? Date.now() - st.since : 0;
      if (ageMs >= PSY.sessionMaxMs){
        st.backoffMs = 30e3;
        say('[psynet] DuplicateLogin efter ' + Math.round(ageMs / 60e3) + ' min — PsyNets 4-timers udløb, ikke en fremmed session; logger ind igen om 30 s');
      }else{
        st.backoffMs = 5 * 60e3;
        say('[psynet] DuplicateLogin — læserkontoen bruges et andet sted; prøver igen om 5 min');
      }
    }
    st.reconnectAt = Date.now() + st.backoffMs;
    st.backoffMs = Math.min(st.backoffMs * 2, 10 * 60e3);
    onEvent({ type: 'disconnected', reason: st.closeReason });
  }
  async function connect(){
    if (st.connected) return true;
    if (st.connecting) return st.connecting;
    st.connecting = (async () => {
      const auth = await authPlayer();
      const bid = buildIdOf(st.gameVersion);
      await new Promise((resolve, reject) => {
        let ws;
        try{
          ws = new WebSocket(auth.PerConURLv2, { headers: {
            'PsyBuildID': bid, 'User-Agent': 'RL Win/' + st.gameVersion + ' gzip',
            'PsyEnvironment': 'Prod', 'PsyToken': auth.PsyToken, 'PsySessionID': auth.SessionID } });
        }catch(e){ return reject(e); }
        let opened = false;
        const guard = setTimeout(() => { if (!opened){ try{ ws.close(); }catch{}; reject(new Error('websocket-timeout')); } }, 15e3);
        ws.onopen = () => {
          opened = true; clearTimeout(guard);
          st.ws = ws; st.connected = true; st.sessionId = auth.SessionID; st.since = Date.now();
          st.backoffMs = 5e3; st.lastError = null;
          st.authFails = 0; st.authFailFirstAt = 0; st.downSince = 0;   // en åben session beviser at kæden lever
          schedulePing();
          onEvent({ type: 'connected', account: st.auth && st.auth.displayName });
          resolve();
        };
        ws.onmessage = ev => {
          const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
          if (text.startsWith('PsyPong:')){
            if (st.pongTimer){ clearTimeout(st.pongTimer); st.pongTimer = null; }
            schedulePing();
            return;
          }
          const m = parseMessage(text);
          if (!m) return;
          const id = m.headers.PsyResponseID;
          const p = id && st.pending.get(id);
          if (!p) return;                                  // server-push (party/friends) — ikke vores ærinde
          st.pending.delete(id);
          clearTimeout(p.timer);
          if (m.body && m.body.Error) p.reject(new Error((m.body.Error.Type || 'PsyNetError') + ': ' + (m.body.Error.Message || '')));
          else p.resolve(m.body ? m.body.Result : null);
        };
        ws.onerror = ev => {
          const msg = (ev && ev.message) || 'websocket-fejl';
          if (!opened){ clearTimeout(guard); reject(new Error(msg)); }
        };
        ws.onclose = ev => {
          const reason = ((ev && ev.reason) || '') + (ev && ev.code ? ' (' + ev.code + ')' : '');
          if (!opened){ clearTimeout(guard); return reject(new Error('lukket før åbning ' + reason)); }
          if (st.ws === ws) teardown(reason || 'lukket');
        };
      });
      return true;
    })();
    try{ return await st.connecting; }
    catch(e){
      // a hung upstream ends as a TimeoutError from AbortSignal.timeout: named
      // as such, so the log says what happened — isAuthReject never matches it
      st.lastError = e && e.name === 'TimeoutError'
        ? 'timeout mod Epic/PsyNet (' + (FETCH_TIMEOUT_MS / 1e3) + ' s uden svar)'
        : String(e.message || e);
      st.reconnectAt = Date.now() + st.backoffMs;
      st.backoffMs = Math.min(st.backoffMs * 2, 10 * 60e3);
      /* Watcher-vagten: kun ÆGTE auth-afvisninger tæller mod "kontoen er
       * lukket" — netværksfejl, 5xx og 429 beviser intet og rører ikke
       * streaken (nulstilling sker alene ved en åben session). */
      if (isAuthReject(st.lastError)){
        st.authFails++;
        if (!st.authFailFirstAt) st.authFailFirstAt = Date.now();
      }
      if (!st.downSince) st.downSince = Date.now();
      say('[psynet] forbindelse fejlede: ' + st.lastError);
      onEvent({ type: 'error', error: st.lastError });
      throw e;
    }
    finally{ st.connecting = null; }
  }
  function rpc(service, data){
    return new Promise((resolve, reject) => {
      if (!st.connected || !st.ws) return reject(new Error('ikke forbundet'));
      const id = nextReqId();
      const timer = setTimeout(() => { st.pending.delete(id); reject(new Error('RPC-timeout ' + service)); }, PSY.rpcTimeoutMs);
      st.pending.set(id, { resolve, reject, timer });
      try{ st.ws.send(buildMessage({ PsyService: service, PsyRequestID: id }, data)); }
      catch(e){ clearTimeout(timer); st.pending.delete(id); reject(e); }
    });
  }

  /* ---- offentlig flade ---- */
  function configured(){ return !!st.auth; }
  function ready(){ return !!st.auth && st.connected; }
  /* Skal vi overhovedet prøve? Ja når vi har en konto og enten er forbundet
   * eller backoff-vinduet er udløbet. */
  function available(){ return !!st.auth && (st.connected || Date.now() >= st.reconnectAt); }

  async function ensure(){
    if (!st.auth) throw new Error('ingen læserkonto forbundet');
    if (st.connected) return true;
    if (Date.now() < st.reconnectAt && !st.connecting) throw new Error('venter på genforbindelse (' + Math.ceil((st.reconnectAt - Date.now()) / 1e3) + ' s)');
    return connect();
  }

  /* pids -> { pid: normalized|null }. Ét RPC-kald for hele listen. En pid uden
   * svar (ukendt spiller/aldrig spillet) bliver null — et ægte "ingen data". */
  /* Only real platforms go upstream. A bot in an offline match arrives as
   * Unknown|0|0 (or worse), and PsyNet answers InvalidPlayer for the WHOLE batch
   * — seen 18/8 12:2x: two lobbies fell back to the quota'd provider because
   * of one bot id. Filtered ids stay null = "no data", never a request. */
  const PLATFORMS = new Set(['Epic', 'Steam', 'PS4', 'PS5', 'PSN', 'XboxOne', 'Xbox', 'XboxSeries', 'Switch']);
  async function getSkills(pids){
    const out = {};
    const ids = [];
    for (const raw of new Set((pids || []).map(String))){
      out[raw] = null;
      const m = raw.match(/^([A-Za-z0-9]+)\|([^|]+)\|(\d+)$/);
      if (m && PLATFORMS.has(m[1]) && m[2] !== '0' && ids.length < 32) ids.push(raw);
    }
    if (!ids.length) return out;
    await ensure();
    const res = await rpc('Skills/GetPlayersSkills v1', { PlayerIDs: ids });
    st.lastLookupAt = Date.now(); st.lookups++;
    for (const p of (res && res.Players) || []){
      if (p && p.PlayerID in out) out[p.PlayerID] = normalize(p.Skills);
    }
    return out;
  }

  /* Login: brugeren åbner loginUrl() i sin browser, logger ind som LÆSERKONTOEN
   * og indsætter authorizationCode fra svaret. Én gang; derefter refresh. */
  function loginUrl(){
    const redirect = 'https://www.epicgames.com/id/api/redirect?clientId=' + EGS.clientId + '&responseType=code';
    return 'https://www.epicgames.com/id/login?redirectUrl=' + encodeURIComponent(redirect);
  }
  async function loginWithCode(code){
    const c = String(code || '').trim().replace(/^.*"authorizationCode"\s*:\s*"([^"]+)".*$/s, '$1');
    if (!/^[A-Za-z0-9]{16,64}$/.test(c)) return { ok: false, reason: 'ugyldig kode' };
    let j;
    try{ j = await egsToken({ grant_type: 'authorization_code', code: c, token_type: 'eg1' }); }
    catch(e){ return { ok: false, reason: String(e.message || e) }; }
    const tp = String(trackedPid() || '');
    if (tp && tp.split('|')[1] === j.account_id){
      return { ok: false, reason: 'Det er spillerens EGEN konto (' + (j.displayName || j.account_id) + '). '
        + 'Én konto tåler kun én session — den ville kicke spillet. Brug en separat læserkonto.' };
    }
    // ny konto = ny session; luk en evt. gammel pænt
    if (st.ws){ try{ st.ws.close(); }catch{} }
    clearTimers(); st.ws = null; st.connected = false; st.eos = null; st.reconnectAt = 0; st.backoffMs = 5e3;
    rememberEgs(j);
    say('[psynet] læserkonto forbundet: ' + (j.displayName || j.account_id));
    connect().catch(() => {});
    return { ok: true, account: { id: j.account_id, name: j.displayName || null } };
  }
  function logout(){
    if (st.ws){ try{ st.ws.close(); }catch{} }
    clearTimers(); st.ws = null; st.connected = false;
    forgetAuth();
    onEvent({ type: 'disconnected', reason: 'logout' });
    return { ok: true };
  }
  function status(){
    return {
      configured: configured(), connected: st.connected,
      account: st.auth ? { id: st.auth.accountId, name: st.auth.displayName } : null,
      refreshExpiresAt: st.auth ? st.auth.egsRefreshExpiresAt : null,
      since: st.since || null, lastError: st.lastError, closeReason: st.closeReason || null,
      reconnectAt: st.reconnectAt > Date.now() ? st.reconnectAt : null,
      lookups: st.lookups, lastLookupAt: st.lastLookupAt || null,
      gameVersion: st.gameVersion, featureSet: st.featureSet, versionSource: st.versionSource,
      duplicateLogins: st.duplicateLogins, recycles: st.recycles,
      health: judgeHealth(st),
      loginUrl: loginUrl()
    };
  }
  function close(){
    clearTimers();
    if (st.keepalive){ clearInterval(st.keepalive); st.keepalive = null; }
    if (st.ws){ try{ st.ws.close(); }catch{} }
    st.ws = null; st.connected = false;
  }

  /* Planlagt session-fornyelse (20/8): PsyNet lukker sessionen ved 4-timers
   * grænsen uanset hvad vi gør (se PSY.sessionMaxMs), og stemplet er
   * "DuplicateLogin" — som før fixet kostede 5 min relæ-nedetid hver 4. time.
   * Luk selv PÆNT ved 3t50 og log straks ind igen: nedetiden bliver ~2 s, og
   * et DuplicateLogin i journalen betyder igen det ordene siger. Gamle ws
   * nulstilles FØR close, så dens onclose ikke udløser teardown-backoff. */
  function recycle(){
    const ws = st.ws;
    clearTimers();
    st.ws = null; st.connected = false; st.sessionId = null;
    st.closeReason = 'planlagt fornyelse (4-timers grænsen)';
    if (!st.downSince) st.downSince = Date.now();
    st.recycles++;
    for (const [, p] of st.pending){ try{ p.reject(new Error('forbindelsen lukkede (planlagt fornyelse)')); }catch{} }
    st.pending.clear();
    if (ws){ try{ ws.close(); }catch{} }
    st.reconnectAt = 0; st.backoffMs = 5e3;
    say('[psynet] planlagt session-fornyelse før PsyNets 4-timers grænse — logger ind igen');
    onEvent({ type: 'recycle' });
    connect().catch(() => {});
  }

  /* Keepalive (18/8 aften): the session used to reconnect ONLY when a request
   * arrived after the backoff window — so after a DuplicateLogin at 17:22 the
   * relay sat dead for 3 h because nobody happened to ask. On the relay the
   * session must be warm BEFORE the first tester of the evening lands in a
   * lobby, so heal proactively. No-op on a tracker with no reader account
   * (st.auth null), and it respects reconnectAt so it never fights the 5-min
   * DuplicateLogin backoff. 20/8: also renews a session nearing the 4-hour
   * limit — only when no RPC is in flight (they time out in 12 s, so the next
   * 60 s tick always gets its chance well before the limit). */
  function startKeepalive(){
    if (st.keepalive) return;
    st.keepalive = setInterval(() => {
      if (!st.auth) return;
      if (st.connected){
        if (Date.now() - st.since >= PSY.sessionMaxMs && !st.pending.size) recycle();
        return;
      }
      if (st.connecting) return;
      if (Date.now() < st.reconnectAt) return;
      connect().catch(() => {});
    }, 60e3);
    if (st.keepalive.unref) st.keepalive.unref();
  }

  loadAuth();
  try{ refreshVersion(); }catch(e){ say('[psynet] versions-tjek fejlede: ' + String(e.message || e)); }
  if (typeof WebSocket !== 'function'){
    say('[psynet] denne Node har ingen indbygget WebSocket (kræver Node 22+) — rank via PsyNet slået fra');
    st.lastError = 'Node uden WebSocket';
    return { init: true, configured: () => false, ready: () => false, available: () => false,
      getSkills: async () => ({}), loginUrl, loginWithCode: async () => ({ ok: false, reason: 'Node uden WebSocket' }),
      logout, status, close, normalize };
  }
  startKeepalive();
  if (st.auth){
    say('[psynet] læserkonto: ' + (st.auth.displayName || st.auth.accountId) + ' — forbinder…');
    connect().catch(() => {});
  }else{
    say('[psynet] ingen læserkonto endnu — forbind under Setup (Rank source)');
  }

  return { init: true, configured, ready, available, ensure, getSkills, loginUrl, loginWithCode, logout, status, close, normalize };
}

module.exports = { init, normalize, buildIdOf, mmrOf, detectVersion, findInstall, TIERS, PSY,
  isAuthReject, judgeHealth };   // vagten eksponeret til test (director/test/watcher.test.js)
