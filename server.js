#!/usr/bin/env node
/* RL Live Tracker — companion server.
 * Serves the tracker page, bridges the game's TCP stats feed to SSE, records
 * every match to matches/ and hosts the RL Director (director/). Zero
 * dependencies. Opened as a bare HTML file the tracker still works, but only
 * standalone (demo mode, stored history) — everything live comes through here.
 */
'use strict';
/* Klokkeslæt på hver loglinje (3/9): '[feed] hovedtråden var blokeret' kunne
 * ellers ikke kobles til kampafslutning, feedback-tick eller et API-kald. */
const _log = console.log.bind(console);
function logStamp(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
console.log = (...a) => _log(logStamp(), ...a);
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 8341;
/* Loopback only (user's decision, 2026-07-26). This process holds the user's
 * RapidAPI key and personal telemetry, and /api/playerranks has no
 * authentication — on 0.0.0.0 anyone on the network could spend the
 * 5-lookups/day quota. The board and overlay run on this machine, so nothing
 * in daily use needs the network. Opt back in with HOST=0.0.0.0 (LAN devices,
 * e.g. a board on another PC); overwriting the stored key stays loopback-only
 * either way (see playerRanks). */
const HOST = process.env.HOST || '127.0.0.1';
const LAN_OPEN = HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1';
/* ROOT is where the data lives: profile.json, matches/, reports/, the keys.
 * Under SEA that is the folder the exe sits in — the portable pack IS the
 * working directory. RL_ROOT overrides it for development only: the dev config
 * (port 8342) can then read the real archive without a second copy, which is
 * the only way to see the coach's surfaces against real numbers before a
 * release. It is never set in the shipped launchers, and the server still only
 * listens on loopback, so it opens nothing. */
const isSea = (() => { try{ return require('node:sea').isSea(); }catch{ return false; } })();
let ROOT = process.env.RL_ROOT || __dirname;
if (isSea && !process.env.RL_ROOT) ROOT = path.dirname(process.execPath);
/* Motoren (director/*.js + pack-katalogerne) indlæses fra DIR_ROOT, data fra
 * ROOT. Under SEA er det samme mappe. Under `node server.js` er det repoets
 * egen director/ — også med RL_ROOT sat (dev-fælden 25/8: motoren blev læst
 * fra dist/director, så en rettelse i repoet kørte aldrig). RL_DIRECTOR_DIR
 * overstyrer for den der vil pege et andet sted hen. */
const DIR_ROOT = process.env.RL_DIRECTOR_DIR || (isSea ? ROOT : __dirname);
const loadDirectorModule = name =>
  require('module').createRequire(path.join(DIR_ROOT, 'x.js'))(path.join(DIR_ROOT, 'director', name));
const UA = 'GitatoRLTracker/1.0 (dexo.colt@gmail.com)';
/* Synkront arbejde over denne grænse logges med navn (3/9): sådan bliver de
 * 3-5 s '[feed] hovedtråden var blokeret' efter en kamp fordelt på det kald
 * der faktisk kostede — samme tærskel som feed-kvitteringen (FEED_STALL_MS). */
const SLOW_LOG_MS = 250;
function timed(label, fn){
  const t0 = Date.now();
  try{ return fn(); }
  finally{ const ms = Date.now() - t0; if (ms > SLOW_LOG_MS) console.log('[tid] ' + label + ' tog ' + ms + ' ms'); }
}

/* Crash-safe JSON write: truncating the real file first means a crash (or the
 * user closing the exe) mid-write loses the whole thing — the rank cache is a
 * month of hard-won lookups against a 5/day quota, and a match digest can
 * never be recorded again. Write aside, then rename (atomic on NTFS).
 * The director keeps its own copy of this in director/store.js, so the server
 * stays independent of a module that is allowed to fail to load. */
function writeJSONAtomic(file, obj){
  // The temp name carries the pid: two server processes writing the same file
  // would otherwise share one temp path and clobber each other's half-written
  // bytes before either rename lands. A second process should never get this
  // far (see the EADDRINUSE guard at listen), but the archive is unrebuildable,
  // so the cheap defence stays.
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/* ---------------- game stream bridge (TCP -> SSE) ----------------
 * The game's Stats API is a raw TCP stream of back-to-back JSON objects
 * (no delimiters, and NOT an actual WebSocket despite the docs), so
 * browsers can't read it directly. This bridge splits the stream on
 * top-level object boundaries and forwards each message over SSE.
 */
function makeSplitter(emit){
  let buf = '', depth = 0, inStr = false, esc = false, objStart = -1, i = 0;
  return function feed(chunk){
    buf += chunk;
    for (; i < buf.length; i++){
      const c = buf[i];
      if (inStr){
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{'){ if (depth === 0) objStart = i; depth++; }
      else if (c === '}' && depth > 0 && --depth === 0 && objStart >= 0){
        emit(buf.slice(objStart, i + 1));
        objStart = -1;
      }
    }
    if (depth === 0){ buf = ''; i = 0; objStart = -1; }
    else if (objStart > 0){ buf = buf.slice(objStart); i = buf.length; objStart = 0; }
    if (buf.length > 5e6){ buf = ''; depth = 0; inStr = false; esc = false; i = 0; objStart = -1; }
  };
}

/* ---------------- shared upstream feed ----------------
 * One TCP connection per game endpoint, fanned out to every consumer.
 * Each /api/stream used to dial the game itself, so board + overlay + main
 * page + the recorder meant four connections all re-splitting the same
 * 60-120 messages/s. Consumers come and go; the socket is opened once,
 * reconnects on its own, and is closed when the last one leaves (except
 * the recorder's, which is the always-on telemetry source).
 */
const RECONNECT_MS = 3000;
const feeds = new Map();               // 'host:port' -> feed

/* ---- hvorfor socket'en ikke må ligge i hovedtråden (målt 29/8-2026) ----
 * Stats API'et er spillets egen TCP-server INDE i RocketLeague.exe. Holder vi
 * op med at læse, løber kernens modtage-buffer fuld, TCP-vinduet lukker, og
 * spillets `send()` blokerer på den tråd der også tegner billedet og behandler
 * netværkspakker. Så fryser SPILLET fordi VI er optaget.
 *
 * Det var ikke en teori. Målt på brugerens maskine natten til 29/8: et hul på
 * 4771 ms i strømmen, hvorefter fire kampur-tik væltede ud på én gang og uret
 * var løbet seks sekunder videre. Spillet havde sendt hele vejen igennem — det
 * var vores hændelsesløkke der stod stille. Samtidig: GPU'en på 0 % med fuld
 * klok i P0 (den var vågen og fik intet at lave), RL's CPU en tredjedel nede,
 * billedet frosset og spillets netværks-ikon blinkende. Alle tre er den samme
 * blokering set fra hver sin side.
 *
 * Director'en har ~60 synkrone fs-kald, og arkivet vokser: 591 kampe og 527
 * rapporter kostede 0,8 sekund pr. fuldt gennemløb den nat. At jage det ene
 * langsomme kald løser ingenting varigt — hvert fremtidigt synkront kald ville
 * kunne fryse spillet igen. Så socket'en flytter ud i sin egen tråd, der ikke
 * gør andet end at læse, splitte og sende videre. Den rører aldrig disken.
 * Derefter må hovedtråden tage al den tid den vil.
 *
 * Semantikken er bevaret med vilje: tråden sender ÉN besked pr. TCP-chunk,
 * præcis som splitteren i dag udsender en chunks beskeder i træk. Bevægelses-
 * målingen (M4b) stempler stadig med `Date.now()` i hovedtråden på nøjagtig
 * samme kornstørrelse som før. Intet måletal skifter betydning af den her
 * ændring.
 *
 * Kvitteringen tilbage fra hovedtråden er ikke pynt: den måler hvor længe
 * løkken var blokeret, og skriver det i loggen. Det er sådan det NÆSTE
 * langsomme kald bliver fundet — uden at det koster spillet en frysning. */
const FEED_STALL_MS = 250;             // under det er det almindelig behandling
const FEED_BACKLOG_WARN = 2000;        // ubekræftede portioner før vi siger til

const FEED_WORKER_SRC = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const net = require('node:net');
const HOST = workerData.host, PORT = workerData.port;
const RECONNECT_MS = workerData.reconnectMs;
const STALL_MS = workerData.stallMs, BACKLOG_WARN = workerData.backlogWarn;

${makeSplitter.toString()}

let rows = [], seq = 0, warned = false;
const sent = new Map();                // portions-id -> afsendt hvornår
let stopped = false, sock = null, retry = null;

/* Tråden har sin egen console: samme klokkeslæt-præfiks som hovedtråden. */
function stamp(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/* Én blokering forsinker hver eneste portion der nåede at hobe sig op, så en
 * linje pr. kvittering gav 40 linjer om det samme. Episoden samles i stedet:
 * værste ventetid og hvor mange portioner der stod i kø, skrevet én gang når
 * køen er tømt. */
let ep = null;
function noteHeld(held){
  if (held <= STALL_MS) return;
  if (!ep) ep = { worst: 0, batches: 0, timer: null };
  ep.worst = Math.max(ep.worst, held);
  ep.batches++;
  clearTimeout(ep.timer);
  ep.timer = setTimeout(() => {
    console.log(stamp() + ' [feed] hovedtråden var blokeret i ' + ep.worst + ' ms (' +
      ep.batches + ' portioner holdt i tråden) — spillet mærkede det ikke');
    ep = null;
  }, 300);
}

function flush(){
  if (!rows.length) return;
  const batch = rows; rows = [];
  const id = ++seq;
  sent.set(id, Date.now());
  if (sent.size > BACKLOG_WARN && !warned){
    warned = true;
    console.log(stamp() + ' [feed] hovedtråden har ikke svaret på ' + sent.size + ' portioner — strømmen holdes i tråden');
  }
  parentPort.postMessage({ t: 'batch', id, rows: batch });
}
function connect(){
  if (stopped) return;
  const split = makeSplitter(raw => rows.push(raw));
  sock = net.connect(PORT, HOST);
  sock.setEncoding('utf8');
  sock.on('connect', () => parentPort.postMessage({ t: 'state', s: 'connected' }));
  /* én portion pr. chunk: samme kornstørrelse som splitteren havde i forvejen */
  sock.on('data', chunk => { split(chunk); flush(); });
  sock.on('error', () => {});
  sock.on('close', () => {
    sock = null;
    if (stopped) return;
    parentPort.postMessage({ t: 'state', s: 'waiting' });
    clearTimeout(retry);
    retry = setTimeout(connect, RECONNECT_MS);
  });
}
parentPort.on('message', m => {
  if (!m) return;
  if (m.t === 'ack'){
    const at = sent.get(m.id);
    sent.delete(m.id);
    if (sent.size <= BACKLOG_WARN) warned = false;
    if (at) noteHeld(Date.now() - at);
    return;
  }
  if (m.t === 'stop'){
    stopped = true;
    clearTimeout(retry);
    try{ sock && sock.destroy(); }catch(e){}
  }
});
connect();
`;

function makeFeed(host, port){
  const subs = new Set();              // fn(rawMessage)
  const watchers = new Set();          // fn(state) — only called when the state CHANGES
  let state = 'connecting', stopped = false, mode = null;
  let worker = null, sock = null, retry = null;

  const setState = s => {
    if (s === state) return;           // repeated failed reconnects are not new news
    state = s;
    for (const w of watchers) try{ w(s); }catch{}
  };
  const emit = raw => { for (const fn of subs) try{ fn(raw); }catch{} };

  /* Reserven: læs i hovedtråden, nøjagtig som før 29/8. Den findes fordi et
   * tavst dødt feed er værre end en frysning — så mister han optagelsen af
   * hele aftenen uden at opdage det. */
  function startInline(){
    mode = 'inline';
    const connect = () => {
      if (stopped) return;
      const split = makeSplitter(emit);
      sock = net.connect(port, host);
      sock.setEncoding('utf8');
      sock.on('connect', () => setState('connected'));
      sock.on('data', split);
      sock.on('error', () => {});
      sock.on('close', () => {
        sock = null;
        if (stopped) return;
        setState('waiting');
        clearTimeout(retry);
        retry = setTimeout(connect, RECONNECT_MS);
      });
    };
    connect();
  }

  function startWorker(){
    const { Worker } = require('node:worker_threads');
    worker = new Worker(FEED_WORKER_SRC, {
      eval: true,
      workerData: { host, port, reconnectMs: RECONNECT_MS,
                    stallMs: FEED_STALL_MS, backlogWarn: FEED_BACKLOG_WARN }
    });
    mode = 'worker';
    worker.on('message', m => {
      if (!m) return;
      if (m.t === 'batch'){
        for (const raw of m.rows) emit(raw);
        try{ worker.postMessage({ t: 'ack', id: m.id }); }catch{}
      } else if (m.t === 'state') setState(m.s);
    });
    const fail = why => {
      if (stopped || mode !== 'worker') return;
      console.log('[feed] tråden faldt fra (' + why + ') — læser i hovedtråden som før');
      worker = null;
      startInline();
    };
    worker.on('error', e => fail((e && e.message) || String(e)));
    worker.on('exit', code => { if (code !== 0) fail('afsluttede med kode ' + code); });
  }

  /* Nødbremse: RL_FEED_INLINE=1 tvinger den gamle vej. Den er også det ene
   * sted A/B-testen kan tages fra — med den kan man måle spillets modtryk med
   * og uden tråden på den samme kode. */
  if (process.env.RL_FEED_INLINE === '1'){
    console.log('[feed] RL_FEED_INLINE=1 — læser i hovedtråden (spillet kan fryse når vi er optaget)');
    startInline();
  } else {
    try{ startWorker(); }
    catch(e){
      console.log('[feed] kunne ikke starte tråden (' + ((e && e.message) || e) + ') — læser i hovedtråden som før');
      startInline();
    }
  }

  return {
    get state(){ return state; },
    get size(){ return subs.size; },
    get mode(){ return mode; },
    add(onMsg, onState){
      subs.add(onMsg);
      if (onState) watchers.add(onState);
      return () => { subs.delete(onMsg); if (onState) watchers.delete(onState); };
    },
    stop(){
      stopped = true;
      clearTimeout(retry);
      try{ sock && sock.destroy(); }catch{}
      if (worker){
        try{ worker.postMessage({ t: 'stop' }); }catch{}
        try{ worker.terminate(); }catch{}
        worker = null;
      }
    }
  };
}

function getFeed(host, port){
  const key = host + ':' + port;
  let f = feeds.get(key);
  if (!f) feeds.set(key, f = makeFeed(host, port));
  return f;
}
/* Last page for this endpoint closed: drop the socket, unless it is the
 * recorder's — telemetry keeps recording with no browser open at all. */
function releaseFeed(host, port){
  const key = host + ':' + port;
  if (key === STATS_HOST + ':' + STATS_PORT) return;
  const f = feeds.get(key);
  if (f && !f.size){ f.stop(); feeds.delete(key); }
}

/* Every open /api/stream response; lets the server push its own events
 * (Director debriefs) to all connected pages alongside the game bridge. */
const sseClients = new Set();
function broadcastSSE(obj){
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients){ try{ res.write(line); }catch{} }
}

/* The page's default host is "localhost" while the recorder dials 127.0.0.1.
 * Left as-is those are two different feed keys — and therefore two TCP
 * connections to the same game. Fold the loopback spellings together. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i;

function handleStream(url, req, res){
  let host = (url.searchParams.get('host') || '127.0.0.1').replace(/[^a-zA-Z0-9_.:\-]/g, '') || '127.0.0.1';
  if (LOOPBACK.test(host)) host = '127.0.0.1';
  /* Enhver side i browseren kan nå loopback, og hver ny host:port her får
   * serveren til at åbne en TCP-forbindelse (3/9: portscan-flade). På en
   * loopback-server må feedet derfor kun pege på maskinen selv eller den
   * spil-host der er sat ved start (STATS_HOST); LAN-tilstand beholder friheden. */
  if (!LAN_OPEN && host !== '127.0.0.1' && host !== STATS_HOST) host = '127.0.0.1';
  const port = Math.min(65535, Math.max(1, Number(url.searchParams.get('port')) || 49123));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = payload => {
    try{
      const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
      // a client that has stopped reading must not grow the buffer without
      // bound (3/9): UpdateState comes ~10/s and the next one supersedes this
      // one, so it is the one message that may be dropped under backpressure
      if (res.writableLength > 1e6 && s.startsWith('{"Event":"UpdateState"')) return;
      res.write('data: ' + s + '\n\n');
    }catch{}
  };
  sseClients.add(res);
  // a board that (re)opens right after a match still gets the latest debrief,
  // and right after a session still gets that session's report
  if (director){
    const d = director.lastDebrief();
    // Was 10 minutes, which quietly meant a board opened later in the evening
    // showed an empty debrief card even though the debrief existed. The card
    // is the product's centrepiece; showing the latest one is right until a
    // new match replaces it. (The page also fetches /api/debrief at boot, so
    // this is the belt to that pair of braces.)
    if (d && Date.now() - Date.parse(d.at) < 12 * 3600e3) send({ Event: '_director', Data: d });
    const s = director.sessionLatest && director.sessionLatest();
    if (s && Date.now() - Date.parse(s.at) < 60 * 60e3)
      send({ Event: '_session', Data: { schema: 'session/1', at: s.at,
        summary: { matches: s.matches.length, wl: s.wl.w + '-' + s.wl.l, headline: s.headline },
        lines: s.lines, url: s.url } });
    // today's focus has no expiry — it stands until the next session report
    const f = director.focus && director.focus();
    if (f) send({ Event: '_focus', Data: f });
    // a page opened mid-match gets the meter straight away; the periodic
    // broadcast only fires on change, so without this it would sit empty
    // until the next touch moved the number
    const fl = director.focusLive && director.focusLive(rec.m);
    if (fl) send({ Event: '_focusLive', Data: fl });
    // "Ugens fremgang": the running week if it holds anything, otherwise the
    // last closed week's report — a Monday board should not be empty just
    // because the new week has no matches in it yet.
    if (director.weeklyCurrent){
      const wCur = director.weeklyCurrent();
      const w = wCur && wCur.totals.matches ? wCur : (director.weeklyLatest && director.weeklyLatest());
      if (w) send({ Event: '_weekly', Data: w });
    }
  }

  let closed = false;
  const ping = setInterval(() => { try{ res.write(': ping\n\n'); }catch{} }, 15000);

  // The game can emit 60-120 UpdateState/s; forward at most ~10/s (latest wins).
  // Discrete events (goals etc.) pass through immediately.
  let pendingUS = null, usTimer = null;
  const forward = raw => {
    if (raw.startsWith('{"Event":"UpdateState"')){
      pendingUS = raw;
      if (!usTimer) usTimer = setTimeout(() => {
        usTimer = null;
        if (pendingUS && !closed){ send(pendingUS); pendingUS = null; }
      }, 100);
    } else send(raw);
  };

  // a page opened after en spilopdatering skal kende vagtens dom med det samme —
  // banneret må ikke vente på næste 5-minutters-tjek
  if (statsGuard){ const sg = statsGuard.status(); if (sg) send({ Event: '_statsapi', Data: sg }); }
  // og en allerede fundet ny version skal ikke vente på næste døgn-tjek
  if (updateCheck){ const u = updateCheck.status(); if (u && u.updateAvailable) send({ Event: '_update', Data: u }); }

  // join the shared connection and report its real state straight away —
  // a page opened mid-match must not be told "connecting" when it is already live
  const feed = getFeed(host, port);
  send({ Event: '_bridge', Data: { state: feed.state, host, port } });
  const off = feed.add(forward, state => send({ Event: '_bridge', Data: { state } }));

  req.on('close', () => {
    closed = true;
    sseClients.delete(res);
    clearInterval(ping); clearTimeout(usTimer);
    off();
    releaseFeed(host, port);
  });
}

/* ---------------- rank emblems (RocketStats .tga -> .png) ----------------
 * RocketStats (BakkesMod plugin) ships rank emblem images as TGA files in
 * %APPDATA%\bakkesmod\bakkesmod\data\RocketStats\RocketStats_images.
 * Browsers can't render TGA, so convert on the fly (zero deps via zlib).
 */
/* RS_IMAGES_DIR (6/9) gaar forud: paa Linux findes %APPDATA% ikke, og mappen
 * ligger i Wine-prefixet (<pfx>/drive_c/users/<u>/AppData/Roaming/bakkesmod/...)
 * — eller slet ingen steder, hvorefter emblemerne blot udebliver (null). */
const RS_IMAGES = process.env.RS_IMAGES_DIR
  ? process.env.RS_IMAGES_DIR
  : process.env.APPDATA
    ? path.join(process.env.APPDATA, 'bakkesmod', 'bakkesmod', 'data', 'RocketStats', 'RocketStats_images')
    : null;
const imgCache = new Map();

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngEncode(w, h, rgba){
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++){
    raw[y * stride] = 0;                                   // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                                // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
function tgaToPng(buf){
  const idLen = buf[0], cmType = buf[1], type = buf[2];
  const w = buf.readUInt16LE(12), h = buf.readUInt16LE(14), bpp = buf[16], desc = buf[17];
  if (cmType !== 0 || (type !== 2 && type !== 10) || (bpp !== 24 && bpp !== 32) || !w || !h)
    throw new Error('unsupported tga');
  const bytes = bpp / 8;
  const px = Buffer.alloc(w * h * 4);
  const put = (i, p) => {
    px[i * 4] = buf[p + 2]; px[i * 4 + 1] = buf[p + 1]; px[i * 4 + 2] = buf[p];   // BGR -> RGB
    px[i * 4 + 3] = bytes === 4 ? buf[p + 3] : 255;
  };
  let i = 0, p = 18 + idLen;
  if (type === 2){
    for (; i < w * h; i++, p += bytes) put(i, p);
  } else {                                                 // RLE
    while (i < w * h && p < buf.length){
      const hdr = buf[p++], count = (hdr & 127) + 1;
      if (hdr & 128){ for (let k = 0; k < count && i < w * h; k++, i++) put(i, p); p += bytes; }
      else for (let k = 0; k < count && i < w * h; k++, i++, p += bytes) put(i, p);
    }
  }
  if (!(desc & 32)){                                       // origin bottom-left -> flip
    const row = w * 4, tmp = Buffer.alloc(row);
    for (let y = 0; y < (h >> 1); y++){
      const a = y * row, b = (h - 1 - y) * row;
      px.copy(tmp, 0, a, a + row); px.copy(px, a, b, b + row); tmp.copy(px, b);
    }
  }
  return pngEncode(w, h, px);
}
function rankImage(name){
  if (!/^[A-Za-z_]{1,40}$/.test(name) || !RS_IMAGES) return null;
  if (imgCache.has(name)) return imgCache.get(name);
  // misses are cached too (a null means "no such emblem"), and the name comes
  // off the wire — bound the map so a LAN client can't grow it without limit
  if (imgCache.size > 200) imgCache.clear();
  let png = null;
  try{ png = tgaToPng(fs.readFileSync(path.join(RS_IMAGES, name + '.tga'))); }catch{}
  imgCache.set(name, png);
  return png;
}

/* ---------------- opponent rank lookup ----------------
 * The Stats API feed exposes every player's PrimaryId (Epic|id|0 / Steam|id64|0)
 * and Name but NO ranks, and EAC blocks BakkesMod online — so opponent ranks
 * come from an online lookup (RapidAPI, user-supplied key sent per request as
 * the x-rank-key header). Aggressive caching keeps the free tier viable: one
 * lookup per player per 30 days (RANK_TTL). mock=1 serves deterministic fake
 * ranks for demo mode and pipeline tests.
 * The key IS remembered locally in rank-cache.json, so the board's separate
 * Chrome profile can look up without re-entering it — which makes that file a
 * secret: never serve it, never ship it in a zip.
 *
 * 18/8-2026: provider swapped to rocket-league10 (the old rocket-league1 was
 * cancelled — it answered "Unranked, 355 MMR" and worse). Everything about the
 * provider now lives in director/rankapi.js, shared with rank-snapshot.js.
 * The new one is keyed by platform + DISPLAY NAME, not by the account id, so a
 * lookup needs the feed's Name — see rankNameOf().
 */
/* Free plans are brutally small (10 player lookups/DAY, hard limit) — so
 * successful lookups persist to disk for 30 days and survive restarts, a daily
 * counter stops upstream calls at the limit, and 429 pauses lookups for an hour
 * instead of burning the quota on retries. A player the provider has never
 * heard of (404) is a settled answer, not a failure: remembering it for a week
 * is what stops six unknown console players from eating a day's quota every
 * single evening. */
const RANK_TTL = 30 * 24 * 3600e3, RANK_NEG_TTL = 10 * 60e3, RANK_MISS_TTL = 7 * 24 * 3600e3;
/* PsyNet answers cost nothing, so a cached answer only needs to outlive the
 * lobby it was fetched for: 10 minutes. After that the next roster asks again
 * and gets tonight's rank, not last month's. */
const RANK_PSY_TTL = 10 * 60e3;
const rankapi = (() => {
  try{ return loadDirectorModule('rankapi.js'); }
  catch(e){ console.log('[rankapi] modul ikke indlæst — rank-opslag slået fra:', String(e.message || e)); return null; }
})();
const RANK_DAILY_LIMIT = rankapi ? rankapi.DAILY_LIMIT : (Number(process.env.RANK_DAILY_LIMIT) || 10);
const RANK_STATE_FILE = path.join(ROOT, 'rank-cache.json');
const rankState = (() => {
  try{ return JSON.parse(fs.readFileSync(RANK_STATE_FILE, 'utf8')); }catch{ return { players: {}, day: '', used: 0 }; }
})();
/* Keyed by player id straight off the query string. Prototype-less maps, so a
 * key like "__proto__" can never reach Object.prototype (3/9); the ids are
 * also shape-checked in playerRanks before they get here. */
rankState.players = Object.assign(Object.create(null), rankState.players || {});
rankState.names = Object.assign(Object.create(null), rankState.names || {});   // pid -> last display name seen in the feed
let rankPausedUntil = 0;
function rankToday(){ return new Date().toISOString().slice(0, 10); }
function rankSave(){ try{ writeJSONAtomic(RANK_STATE_FILE, rankState); }catch{} }
/* The provider's own remaining count is the truth. RANK_DAILY_LIMIT is merely
 * what WE believe the plan to be — and this machine still carries a
 * RANK_DAILY_LIMIT=950 from the cancelled 1000/day plan, which must not be able
 * to talk us into spending calls the provider will refuse. Whichever says
 * "stop" first wins; only the provider can say "keep going". */
function rankQuota(){
  if (rankState.day !== rankToday()){
    rankState.day = rankToday(); rankState.used = 0; rankState.remaining = null;
    rankPausedUntil = 0; rankSave();
  }
  const remaining = Number.isFinite(rankState.remaining) ? rankState.remaining : null;
  return { used: rankState.used, limit: RANK_DAILY_LIMIT, remaining,
    exhausted: (remaining !== null && remaining <= 0)
      || rankState.used >= RANK_DAILY_LIMIT || Date.now() < rankPausedUntil };
}

function mockRank(pid){
  let h = 0;
  for (const ch of pid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const mk = off => {
    const t = 4 + ((h >>> off) % 17);           // Silver I .. GC III (unsigned shift!)
    const names = ['Unranked','Bronze I','Bronze II','Bronze III','Silver I','Silver II','Silver III',
      'Gold I','Gold II','Gold III','Platinum I','Platinum II','Platinum III','Diamond I','Diamond II',
      'Diamond III','Champion I','Champion II','Champion III','Grand Champion I','Grand Champion II',
      'Grand Champion III','Supersonic Legend'];
    return { label: names[t], division: 1 + ((h >>> (off + 2)) % 4), mmr: 400 + t * 62 + (h % 40) };
  };
  return { p1: mk(1), p2: mk(5), p3: mk(9) };
}

/* The provider is keyed by display name, so a lookup is only possible for a
 * player we have seen named. The feed names everyone in the lobby; remember
 * that, so a retry minutes later (or after a restart) still knows who this pid
 * is even when the roster is long gone. */
let rankNamesDirty = false;
function rankLearnNames(players){
  for (const p of (players || [])){
    const pid = p && (p.PrimaryId || p.pid), name = p && (p.Name || p.name);
    if (!pid || !name || rankState.names[pid] === name) continue;
    rankState.names[pid] = name;
    rankNamesDirty = true;
  }
}
function rankNameOf(pid){ return rankState.names[pid] || null; }

/* Free-tier plans rate-limit hard (429 seen in the wild) — space upstream
 * calls globally and retry failures soon instead of caching them for long. */
let rankQueue = Promise.resolve(), rankLastCall = 0;
const RANK_GAP = 1600, RANK_RETRY_TTL = 90e3;

function throttledFetchRank(pid, name, key){
  const run = async () => {
    const wait = Math.max(0, rankLastCall + RANK_GAP - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    rankLastCall = Date.now();
    return rankapi.fetchRank({ pid, name, key, log: m => console.log(m) });
  };
  const p = rankQueue.then(run, run);
  rankQueue = p.catch(() => {});
  return p;
}

function isLocalReq(req){
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
// Platform|id|n — the shape the feed gives PrimaryId (and the demo rows mimic)
const PID_RX = /^[A-Za-z0-9]+\|[^|]{1,64}\|\d+$/;

async function playerRanks(url, req){
  const sent = req.headers['x-rank-key'];
  // Only a request from this machine may replace the stored key: the setup
  // field lives in the local page, and a LAN board must never be able to
  // overwrite (or silently swap) the user's key on disk.
  if (sent && sent !== rankState.key && isLocalReq(req)){ rankState.key = sent; rankSave(); }
  const key = sent || rankState.key;                     // remembered locally so every window can look up
  const mock = url.searchParams.get('mock') === '1';
  /* Names ride along index-aligned with players. Each one is encoded
   * separately before the list is joined, because a display name may contain
   * the comma we split on. The page has the live roster; the server's own
   * memory of the feed covers retries after the lobby is gone.
   * Only ids shaped like a platform id (Platform|id|n) are accepted (3/9);
   * a rejected id drops its name with it, so the two lists stay aligned. */
  const rawIds = (url.searchParams.get('players') || '').split(',');
  const rawNames = (url.searchParams.get('names') || '').split(',').map(s => {
    try{ return decodeURIComponent(s); }catch{ return s; }
  });
  const ids = [], sentNames = [];
  for (let i = 0; i < rawIds.length && ids.length < 8; i++){
    if (!PID_RX.test(rawIds[i])) continue;
    ids.push(rawIds[i]); sentNames.push(rawNames[i] || '');
  }
  const out = {};
  let dirty = false;
  /* PsyNet first (18/8-2026): the whole roster in ONE call, straight from the
   * game's backend, no quota. Anything it answers is cached for RANK_PSY_TTL and
   * served from the loop below; anything it cannot answer (never played ranked,
   * exotic platform prefix) is a real "no data" and gets the short negative
   * TTL. If the reader session is down, the loop falls through to rankapi —
   * a stale PsyNet answer (data present) still counts as known for RANK_TTL,
   * so a hiccup never spends the 10/day quota on players we already hold. */
  const psyLive = !mock && skillsAvailable();
  let psySource = null;
  if (psyLive){
    const isBackend = c => c && (c.source === 'psynet' || c.source === 'relay');
    const need = ids.filter(pid => {
      const c = rankState.players[pid];
      return !(isBackend(c) && Date.now() - c.t < (c.data ? RANK_PSY_TTL : RANK_NEG_TTL));
    });
    if (need.length){
      const r = await skillsLookup(need);        // logs its own failures; null = both sources down
      if (r){
        psySource = r.source;
        for (const pid of need){
          const data = (r.ranks && r.ranks[pid]) || null;
          rankState.players[pid] = { t: Date.now(), ttl: data ? RANK_PSY_TTL : RANK_NEG_TTL, data, source: r.source };
          dirty = true;
          if (data && director && director.onRank){
            try{ director.onRank(pid, data); }catch(e){ console.log('[weekly] rank-fejl:', String(e.message || e)); }
          }
        }
      }
    }
  }
  for (let i = 0; i < ids.length; i++){            // client sends opponents first — quota goes to them
    const pid = ids[i];
    // mock is checked BEFORE the cache: a real negative cache entry used to
    // leak into demo mode and show empty rank badges
    if (mock){ out[pid] = mockRank(pid); continue; }   // never touches disk state or quota
    const name = sentNames[i] || rankNameOf(pid);
    if (name && rankState.names[pid] !== name){ rankState.names[pid] = name; rankNamesDirty = true; }
    const t = rankapi && rankapi.target(pid, name);
    const c = rankState.players[pid];
    /* A cached answer is about a specific identity. If the player has since
     * renamed, the old miss says nothing about the new name — re-open it. */
    const sameIdent = !c || !c.ident || !t || c.ident === t.ident;
    if (c && sameIdent && Date.now() - c.t < (c.data ? RANK_TTL : c.ttl || RANK_NEG_TTL)){ out[pid] = c.data; continue; }
    let data = null, ttl = RANK_NEG_TTL;
    const q = rankQuota();
    if (!t){
      /* No platform we can ask about (Unknown|0|0), or no name yet. The first
       * is permanent, the second resolves itself the moment the feed names
       * them — so only the permanent one is worth a long silence. */
      const unmapped = !(rankapi && rankapi.PLATFORM[String(pid).split('|')[0]]);
      out[pid] = null;
      if (unmapped){ rankState.players[pid] = { t: Date.now(), ttl: RANK_TTL, data: null }; dirty = true; }
      continue;
    }
    if (key && !q.exhausted){
      const r = await throttledFetchRank(pid, name, key);
      data = r.data;
      /* Every upstream call costs the same at the provider whether it comes
       * back with a rank or with "player not found", so count attempts — and
       * let the response's own remaining overwrite the count whenever it is
       * there, since that survives restarts, the RapidAPI web console and any
       * other machine sharing this key. */
      rankState.used++;
      if (Number.isFinite(r.remaining)) rankState.remaining = r.remaining;
      dirty = true;
      /* A hit needs no ttl — data present means RANK_TTL. Everything else is a
       * decision about how long to stay quiet about this player. */
      if (!data){
        if (r.status === 429){ rankPausedUntil = Date.now() + 3600e3; ttl = 60e3; console.log('[rankapi] kvote/rate ramt — pauser opslag 1 time'); }
        else if (r.status === 403){ rankPausedUntil = Date.now() + 3600e3; ttl = 60e3; console.log('[rankapi] 403 — nøglen har ikke abonnement på denne API; pauser opslag 1 time'); }
        else if (r.status === 404) ttl = RANK_MISS_TTL;   // provider has never seen this player
        else ttl = r.retryable ? RANK_RETRY_TTL : RANK_NEG_TTL;
      }
    }
    rankState.players[pid] = { t: Date.now(), ttl, data, ident: t.ident };
    if (data) dirty = true;
    // M4: a fresh lookup is the only rank measurement this product ever gets
    // (10 free per day). Hand it to the director so the weekly report can draw
    // the curve; it keeps the tracked player's points and drops everyone else's.
    if (data && director && director.onRank){
      try{ director.onRank(pid, data); }catch(e){ console.log('[weekly] rank-fejl:', String(e.message || e)); }
    }
    out[pid] = data;
  }
  if (dirty || rankNamesDirty){
    const keys = Object.keys(rankState.players);
    if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete rankState.players[k];
    const names = Object.keys(rankState.names);
    if (names.length > 2000) for (const k of names.slice(0, names.length - 2000)) delete rankState.names[k];
    rankNamesDirty = false;
    rankSave();
  }
  /* provider names the source that served THIS answer: a fresh backend call
   * says which one, a cache-only answer says "psynet" (the board treats both
   * backend sources alike — short ttl, no quota display). */
  return { ranks: out,
    provider: mock ? 'mock' : psyLive ? (psySource || 'psynet') : (key ? 'rapidapi' : 'none'),
    quota: (mock || psyLive) ? null : rankQuota() };
}

/* ---------------- match telemetry recorder ----------------
 * Always-on: keeps its own TCP connection to the game (independent of any
 * browser) and writes one compact JSON digest per match to <ROOT>/matches/.
 * This is the long-term dataset for coaching analysis (/rl-coach).
 */
// folded through the same loopback normalisation the pages use, or STATS_HOST=localhost
// would key a second feed and the recorder would open its own duplicate socket
const STATS_HOST = (h => LOOPBACK.test(h) ? '127.0.0.1' : h)(process.env.STATS_HOST || '127.0.0.1');
const STATS_PORT = Number(process.env.STATS_PORT) || 49123;
/* Loft for hitEvents pr. digest. En onlinekamp lander på ~300-600 events; den
 * målte 2-timers træningsrunde 30/7 ville have givet ~4.000. 6.000 dækker
 * begge med luft, og overskridelse tælles i hitEventsDropped — aldrig tavst. */
const HIT_EVENTS_MAX = 6000;
const MATCH_DIR = path.join(ROOT, 'matches');
const ADAPTER_VERSION = '1.5.0';   // 1.1.0 digest envelope · 1.2.0 movement + per-second curve (M4b) · 1.3.0 hitEvents (per-hit tidsakse) · 1.4.0 playlistId (rå Game.PlaylistId) · 1.5.0 goals[].w + impactX/impactZ (additive, RADAR-DESIGN §8)

/* RL Director (M1): deterministic debrief engine, loaded from disk so it also
 * works inside the SEA exe (whose builtin require can't load local files). */
let director = null;
try{
  // broadcastSSE is declared earlier in this file, so the session engine can
  // push its after-session report to every connected board.
  director = loadDirectorModule('director.js')
    .init({ root: ROOT, log: m => console.log(m), broadcast: o => broadcastSSE(o) });
  console.log('[director] klar (pack ' + director.PACK_VERSION + ')');
}catch(e){ console.log('[director] ikke indlæst — debriefs slået fra:', String(e.message || e)); }

/* Reach-tælleren (13/8): tæller åbninger af coach-fladerne — logik og
 * principper i director/reach.js. Egen try/catch og egen createRequire:
 * reach skal også måle et board der kører uden fungerende director. */
let reach = null;
try{
  reach = loadDirectorModule('reach.js').init({ root: ROOT, log: m => console.log(m) });
}catch(e){ console.log('[reach] ikke indlæst (fortsætter uden):', String(e.message || e)); }

/* Banekortet (26/8), flyttet til director/pitch.js 3/9: per-fil-cache, så en ny
 * kamp ikke længere koster en fuld genlæsning af arkivet på hovedtråden. */
let pitch = null;
try{ pitch = loadDirectorModule('pitch.js'); }
catch(e){ console.log('[pitch] ikke indlæst — banekortet slået fra:', String(e.message || e)); }
/* Baneradarens zoner (7/9, RADAR-DESIGN.md §6): /api/pitch bærer en `radar`-
 * blok med ugens indkasseringer pr. zone. Geometrien (zoneOf) er trin A;
 * profile()/offenseProfile() er trin B og kan mangle eller kaste — blokken
 * falder så tilbage til rene tællinger (gate null). weekly.js lånes KUN for
 * uge-regnestykket (currentWeek/isoWeekOf/playDay — rene funktioner, samme
 * modul-instans som director.js allerede holder). */
let radar = null, weeklyFns = null;
try{ radar = loadDirectorModule('radar.js'); }
catch(e){ console.log('[radar] ikke indlæst — zonerne slået fra:', String(e.message || e)); }
try{ weeklyFns = loadDirectorModule('weekly.js'); }
catch(e){ console.log('[radar] weekly.js ikke indlæst — ugevalget slået fra:', String(e.message || e)); }

/* Testrunden (25/8, gate 6): første-kørsels-valget "Join the test round?" og
 * feedback-beskeder til collectoren. Tynde ruter her — logik og tekster bor i
 * director/testround.js, som kan ændres uden SEA-genbyg. Egen try/catch og
 * egen createRequire: en tracker uden modulet er stadig en tracker. */
let testround = null;
try{
  testround = loadDirectorModule('testround.js').init({ root: ROOT, log: m => console.log(m) });
}catch(e){ console.log('[testround] ikke indlæst (fortsætter uden):', String(e.message || e)); }

/* StatsAPI-vagten (14/8): to Epic-opdateringer i træk har nulstillet
 * DefaultStatsAPI.ini (PacketSendRate=0) og efterladt trackeren stum. Vagten
 * finder ini'en via Epic-launcherens manifester, retter raten selv og melder
 * `_statsapi` over SSE når et menneske skal genstarte spillet. Logik og
 * fælder: director/statsapi-guard.js. Egen try/catch: en tracker uden vagt
 * skal stadig være en tracker. */
let statsGuard = null;
try{
  statsGuard = loadDirectorModule('statsapi-guard.js').init({
    root: ROOT, log: m => console.log(m),
    desiredRate: Number(process.env.STATSAPI_RATE) || 120,
    expectPort: STATS_PORT,
    iniOverride: process.env.STATSAPI_INI || null,
    onChange: s => broadcastSSE({ Event: '_statsapi', Data: s })
  }).start(5 * 60e3);
}catch(e){ console.log('[statsapi] vagt ikke indlæst (fortsætter uden):', String(e.message || e)); }

/* Versions-tjek (14/8): stille dagligt opslag mod det offentlige releases-repo
 * (github.com/HilsenFar/rl-tracker-releases) — fase 1 af opdaterings-kanalen:
 * besked på boardet, aldrig selv-opdatering. Anonymt kald; slås fra med
 * "updateCheck": false i director-ai.json eller UPDATE_CHECK=0.
 * Logik: director/update-check.js. */
const APP_VERSION = '2026.09.07.1';
let updateCheck = null;
try{
  let updOff = process.env.UPDATE_CHECK === '0';
  try{ if (JSON.parse(fs.readFileSync(path.join(ROOT, 'director-ai.json'), 'utf8')).updateCheck === false) updOff = true; }catch{}
  if (updOff){
    console.log('[update] versions-tjek slået fra (config/env)');
  } else {
    updateCheck = loadDirectorModule('update-check.js').init({
      log: m => console.log(m), appVersion: APP_VERSION,
      onChange: s => { if (s.updateAvailable) broadcastSSE({ Event: '_update', Data: s }); }
    }).start();
  }
}catch(e){ console.log('[update] ikke indlæst (fortsætter uden):', String(e.message || e)); }

/* PsyNet (18/8-2026): rank fra spillets EGEN backend via en separat læserkonto —
 * ægte MMR/tier for spilleren og hele lobbyen i ét kald, ingen døgnkvote.
 * Brugerens fund (AeonLucid/RocketLeaguePublic + dank/rlapi); alt om kæden,
 * DuplicateLogin-reglen og token-rotationen står i director/psynet.js.
 * rocket-league10 (rankapi.js) bliver fallback, ikke erstattet: en tracker
 * uden læserkonto skal stadig kunne slå op som før. */
let psynet = null;
try{
  psynet = loadDirectorModule('psynet.js').init({
    ROOT, log: m => console.log(m),
    trackedPid: () => { try{ return director && director.getTracked ? director.getTracked().pid : null; }catch{ return null; } },
    onEvent: ev => broadcastSSE({ Event: '_psynet', Data: { ...ev, status: psynet ? psynet.status() : null } })
  });
}catch(e){ console.log('[psynet] ikke indlæst (fortsætter med rankapi):', String(e.message || e)); }

/* Rank-relæet (18/8, aften): collect.gitato.net holder ÉN læserkonto for alle
 * trackere. Standardvejen — ingen tester skal oprette noget. Rækkefølge:
 * egen læserkonto (hvis forbundet) → relæ → rocket-league10. Slås fra med
 * RANK_RELAY=off eller "rankRelay": false i director-ai.json. */
let rankRelay = null;
try{
  let relayUrl = process.env.RANK_RELAY;
  if (relayUrl === undefined){
    try{ const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'director-ai.json'), 'utf8'));
      if (c.rankRelay !== undefined) relayUrl = c.rankRelay; }catch{}
  }
  rankRelay = loadDirectorModule('rankrelay.js').init({ url: relayUrl, log: m => console.log(m), userAgent: UA });
  console.log(rankRelay.enabled() ? '[rankrelay] standard-kilde: ' + rankRelay.url : '[rankrelay] slået fra');
}catch(e){ console.log('[rankrelay] ikke indlæst (fortsætter uden):', String(e.message || e)); }

/* Én dør til "ranks fra spillets backend": egen læserkonto først, ellers relæet.
 * Returnerer { ranks: {pid: data|null}, source } eller null når ingen af dem
 * kan lige nu — så tager rankapi (kvote) over hos kalderen. */
/* A promise that gives up after `ms` (3/9). The PsyNet chain used to be able
 * to hang connect() on an upstream that accepted TCP and then went quiet, and
 * every badge lookup on the board waited with it; the fallbacks below (relay,
 * rankapi) only help if the caller actually gets to them. */
function withTimeout(p, ms, what){
  let t;
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timeout (' + ms + ' ms)')), ms); });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}
async function skillsLookup(pids, opts){
  if (psynet && psynet.available()){
    try{ return { ranks: await withTimeout(psynet.getSkills(pids), 8e3, 'psynet'), source: 'psynet' }; }
    catch(e){ console.log('[psynet] opslag fejlede: ' + String(e.message || e)); }
  }
  if (rankRelay && rankRelay.available()){
    try{ return { ranks: await rankRelay.getSkills(pids, opts), source: 'relay' }; }
    /* the module logs HTTP/network failures itself; anything else here is a
     * programming error and must be heard, not swallowed (18/8 15:24-16:00: a
     * missing parameter threw ReferenceError into an empty catch and every
     * badge said "unavailable" for half an hour) */
    catch(e){ if (!/relæ|HTTP|timeout|backoff/.test(String(e && e.message))) console.log('[rankrelay] intern fejl: ' + String(e && e.stack || e)); }
  }
  return null;
}
function skillsAvailable(){
  return !!((psynet && psynet.available()) || (rankRelay && rankRelay.available()));
}

/* Efter hver onlinekamp: spillerens egen rank slås op via PsyNet, så ugekurven
 * (weekly.onRank) får ét ægte punkt PR. KAMP i stedet for ét pr. dagskvote, og
 * boardet får MMR-deltaet. Backend-tallet opdateres nogle sekunder efter
 * kampen (målt 18/8: inden for 2 min) — derfor to forsøg; onRank dropper selv
 * et punkt der ikke har flyttet sig. */
function psynetSelfLookup(reason){
  if (!skillsAvailable()) return;
  let pid = null;
  try{ pid = director && director.getTracked ? director.getTracked().pid : null; }catch{}
  if (!pid) return;
  const prevEntry = rankState.players[pid];
  const prev = prevEntry && prevEntry.data ? prevEntry.data : null;
  // fresh: bypass the relay's cache — we want the number AFTER this match, not
  // the one the board fetched at kickoff (18/8 15:21: "0 friske", no delta)
  skillsLookup([pid], { fresh: true }).then(r => {
    const data = r && r.ranks && r.ranks[pid];
    if (!data) return;
    rankState.players[pid] = { t: Date.now(), ttl: RANK_PSY_TTL, data, source: r.source };
    rankSave();
    if (director && director.onRank){ try{ director.onRank(pid, data); }catch(e){ console.log('[weekly] rank-fejl:', String(e.message || e)); } }
    const delta = {};
    for (const k of ['p1', 'p2', 'p3']){
      if (data[k] && prev && prev[k] && Number.isFinite(data[k].mmr) && Number.isFinite(prev[k].mmr) && data[k].mmr !== prev[k].mmr)
        delta[k] = data[k].mmr - prev[k].mmr;
    }
    if (Object.keys(delta).length) console.log('[psynet] MMR-delta (' + reason + '): '
      + Object.entries(delta).map(([k, d]) => k + ' ' + (d > 0 ? '+' : '') + d).join(', '));
    broadcastSSE({ Event: '_rank', Data: { pid, data, prev, delta, at: Date.now(), reason } });
  }).catch(e => console.log('[psynet] selv-opslag fejlede: ' + String(e.message || e)));
}

const rec = { m: null, clock: null, overtime: false, awaitKickoff: false, roundStartClock: null, lastEndedGuid: null, mv: null, lastHit: null };

function recNewMatch(guid){
  rec.m = {
    guid: guid || null, startedAt: new Date().toISOString(), endedAt: null,
    /* Spillets egen playlist-id, rå og uoversat (Game.PlaylistId). Holdstørrelse
     * alene kan ikke se en privat lobby: 14/8-2026 blev en privat kamp med 4
     * aktive spillere klassificeret "1v1", fordi slut-rosteren kun holdt 2
     * (digest 654FBADA…, slutscore 1-8) — og den flød ind i ugens 1v1-pulje.
     * Additivt felt: gamle digests er blot digests uden det. null betyder
     * "feedet sendte aldrig id'et" (recWrite logger det, så den første kamp
     * efter deploy afgør præmissen). Fortolkningen af id'et (privat/ranked/…)
     * bor i director/metrics.js — aldrig her (samme princip som bhist). */
    playlistId: null,
    arena: '', teams: [], winnerTeamNum: null, overtime: false, abandoned: false,
    players: [], scoreline: [], kickoffs: [], demos: [],
    /* goals: {clock, ot, scorer, team, assist, speed, impactY} + fra 1.5.0 (6/9,
     * RADAR-DESIGN §8) w (vaegur-sekunder siden start, som hitEvents.w) og
     * impactX/impactZ (maalets X/Z fra ImpactLocation, null naar de mangler).
     * Additive: arkivets aeldre digests har blot ikke felterne. */
    goals: [],
    hits: {},                                  // name -> {count,sumSpeed,maxSpeed,plusY,minusY}
    /* Per-hit events WITH a time axis (30/7-2026). The aggregate above answers
     * "hvor hårdt i snit", aldrig "HVORNÅR" — og både de psykologiske vinduer
     * (touchkraft i de 90 s efter et indkasseret mål) og brugerens
     * modstander-tryk-heuristik (stimer af modstander-touches lige efter egne)
     * kræver sekvensen. Boost har allerede sin tidsakse via timeline (M4b);
     * hits var det sidste aggregat uden én. Additivt felt — intet eksisterende
     * ændrer form, og gamle digests er blot digests uden feltet. */
    hitEvents: [],                             // {t: kampur|null, w: sek. siden start, name, team, spd, y}
    boost: {},                                 // name -> {samples,sum,low} (own team only)
    passes: {},                                // name -> count; his touch then a team-mate's, nobody in between
    movement: {},                              // name -> time-weighted movement totals (M4b, own team only)
    timeline: {},                              // name -> per-second curve; compacted to arrays at write
    movementGaps: 0                            // frames whose gap was too long to be play; diagnostics only
  };
  rec.clock = null; rec.overtime = false; rec.awaitKickoff = false; rec.lastHit = null;
  rec.mStartMs = Date.now();                   // vægur-basis for hitEvents.w — kampuret står stille i træning
  rec.mv = { team: null, clock: null, segClock: null, clockAt: 0, lastAt: 0,
             pending: [], p: new Map(), seg: new Map(), resync: true };
}

/* ---------------- movement sampling (M4b) ----------------
 * Players[].Speed is a SPECTATOR field. Live-probed against a running 3v3 on
 * 2026-07-27 (123k frames): it is present for the user's OWN TEAM in every
 * frame and absent for opponents — except during goal replays, where the
 * camera has a target and the feed hands out that player's full record. Every
 * accumulator below therefore runs on non-replay frames only, and "own team"
 * is the TeamNum that carries movement fields in those frames.
 *
 * The feed OMITS falsy values rather than sending them: across those 123k
 * frames `Boost: 0` was sent 0 times, `bOnGround: false` 0 times and
 * `Speed: 0` 0 times. For a player we already know is on the movement team, a
 * missing field therefore means 0/false — not "unknown".
 *
 * Time, not samples, is the unit. The feed runs at ~100 Hz but is not promised
 * to, so everything is weighted by real elapsed dt; counting samples would
 * quietly turn a sample rate into a clock (DESIGN §3).
 *
 * The match clock gates it, and the gate is RETROACTIVE on purpose. The clock
 * ticks once a second while play runs and freezes during kickoff countdowns,
 * replays and pauses — but a freeze can only be recognised after the fact, so
 * a plain "has the clock moved lately" test lets the first second of every
 * countdown through. That second is a car sitting perfectly still, and it lands
 * straight in the hesitation proxy: measured against a synthetic countdown it
 * leaked 0.87 s of zero-speed time per stop. So frames accumulate into a
 * SEGMENT instead, and a segment is only booked when the clock actually ticks —
 * proof that the whole segment was live play. A frozen clock throws its segment
 * away and nothing reaches the archive.
 *
 * The cost is the final partial second of each segment, which never gets its
 * closing tick. It is under a second per stoppage, it is the same in every
 * match, and every comparison here is a player against his own history — so it
 * cancels. The alternative was counting standstill as play, which does not.
 */
const MOVE_STALL_MS  = 1500;   // clock ticks 1/s; longer than this means it is not running
const MOVE_DT_CAP_MS = 50;     // ~100 Hz nominal — a longer gap is a hitch, not 50 ms of play
const MOVE_BIN_W     = 2.5;    // speed-histogram bin width, in whatever unit the feed speaks
const MOVE_BINS      = 41;     // 0..100 plus one overflow bin — covers km/h and mph outright
const MOVE_TL_MAX    = 1500;   // per-second curve cap per player (25 min of clock) — OT is not unbounded
const MOVE_BOOST_W   = 5;      // boost histogram bin width (boost is 0-100)
const MOVE_BOOST_BINS = 20;

function mvNew(){
  return { sec: 0, frames: 0, spdInt: 0, spdMax: 0, ssMaxSpd: 0, boostInt: 0,
           ssSec: 0, airSec: 0, wallSec: 0, boostingSec: 0, slideSec: 0,
           // Time per boost band. The old accumulator counted SAMPLES below a
           // threshold frozen at capture time; this stores the distribution, so
           // where "low" sits stays a decision the metric engine can revise —
           // and the threshold lives in exactly one place (metrics.BOOST_LOW_AT)
           // instead of being duplicated here.
           bhist: new Array(MOVE_BOOST_BINS).fill(0), bhistW: MOVE_BOOST_W,
           // binWidth from the start, not stamped on at write time: the focus
           // meter runs computeMetrics on the match IN PROGRESS, and a
           // histogram without its bin width is unreadable — the metric would
           // silently go missing mid-match and only appear once it ended.
           hist: new Array(MOVE_BINS).fill(0), binWidth: MOVE_BIN_W,
           jumps: 0, jumpBumps: 0, jumpWalls: 0 };
}
function mvAcc(m, name){ return m.movement[name] || (m.movement[name] = mvNew()); }

/* Book a proven-live segment: totals add, peaks take the larger, and the
 * segment becomes one point on the per-second curve. */
function mvBook(m, mv){
  for (const [name, s] of mv.seg){
    if (!(s.sec > 0)) continue;
    const a = mvAcc(m, name);
    a.sec += s.sec; a.frames += s.frames; a.spdInt += s.spdInt; a.boostInt += s.boostInt;
    a.ssSec += s.ssSec; a.airSec += s.airSec; a.wallSec += s.wallSec;
    a.boostingSec += s.boostingSec; a.slideSec += s.slideSec;
    if (s.spdMax > a.spdMax) a.spdMax = s.spdMax;
    if (s.ssMaxSpd > a.ssMaxSpd) a.ssMaxSpd = s.ssMaxSpd;
    for (let i = 0; i < MOVE_BINS; i++) a.hist[i] += s.hist[i];
    for (let i = 0; i < MOVE_BOOST_BINS; i++) a.bhist[i] += s.bhist[i];
    const tl = m.timeline[name] || (m.timeline[name] = []);
    if (tl.length < MOVE_TL_MAX)
      tl.push({ t: mv.segClock, sec: s.sec, spd: s.spdInt, bst: s.boostInt, air: s.airSec });
  }
  mv.seg = new Map();
}

function recMovement(d, m, now){
  const mv = rec.mv;
  if (!mv) return;
  const clk = d.Game.TimeSeconds;

  if (clk !== mv.clock){                       // the clock moved: the segment just closed was live play
    if (mv.clock !== null) mvBook(m, mv);
    mv.clock = clk; mv.clockAt = now; mv.segClock = clk;
  }
  if (mv.team === null){
    for (const p of d.Players)
      if (p && (typeof p.Speed === 'number' || typeof p.Boost === 'number')){ mv.team = p.TeamNum; break; }
    if (mv.team === null){ mv.lastAt = now; return; }
  }

  /* Replay frames carry every player (the camera has a target) and are never
   * play. A clock that has not ticked for MOVE_STALL_MS is a countdown, a
   * replay or a pause — but "not ticked" alone is too blunt at the RESTART:
   * the clock only ticks once a second, so the first second back on the pitch
   * still looks stalled, and that second is the kickoff sprint. The feed
   * settles it: a car at rest has its Speed field omitted entirely, so a
   * frozen countdown has NOBODY carrying a speed while the moment after "GO"
   * has everybody. Stalled AND nobody moving is a stoppage; stalled while the
   * cars are moving is the restart, and it counts.
   *
   * It cannot let a stoppage back in: a segment is still only booked when the
   * clock actually ticks, and the countdown that always precedes a restart
   * clears whatever the celebration before it had accumulated. */
  const stalled = now - mv.clockAt >= MOVE_STALL_MS;
  const moving = !stalled || d.Players.some(p => p && p.TeamNum === mv.team && typeof p.Speed === 'number');
  if (d.Game.bReplay || !moving){
    if (mv.seg.size) mv.seg = new Map();
    mv.lastAt = now; mv.resync = true;         // state is stale; do not read a jump across the gap
    return;
  }

  let dtMs = mv.lastAt ? now - mv.lastAt : 0;
  mv.lastAt = now;
  if (dtMs <= 0) return;
  if (dtMs > MOVE_DT_CAP_MS){ m.movementGaps = (m.movementGaps || 0) + 1; dtMs = MOVE_DT_CAP_MS; }
  const dt = dtMs / 1000;
  const resync = mv.resync; mv.resync = false;

  for (const p of d.Players){
    if (!p || !p.Name || p.TeamNum !== mv.team) continue;
    /* A demolished player is not a slow player. For the ~3 s until the car
     * respawns there IS no car, so the feed omits Speed and bOnGround — which
     * reads, field for field, exactly like standing still in mid-air. Counted,
     * every demo would add three seconds of "hesitation" and three seconds of
     * "off the ground" to the two metrics least able to survive it.
     * bHasCar is the discriminator, and it is trustworthy for the same measured
     * reason: the feed omits falsy values, so bHasCar === true means a car. */
    if (p.bHasCar !== true){ mv.p.delete(p.Name); continue; }
    let s = mv.seg.get(p.Name);
    if (!s) mv.seg.set(p.Name, s = mvNew());
    const spd = typeof p.Speed === 'number' ? p.Speed : 0;
    const bst = typeof p.Boost === 'number' ? p.Boost : 0;
    const onG = p.bOnGround === true, onW = p.bOnWall === true;

    s.frames++; s.sec += dt;
    s.spdInt += spd * dt;                       // speed x time: distance, once the unit is known
    s.boostInt += bst * dt;
    if (spd > s.spdMax) s.spdMax = spd;
    if (p.bSupersonic === true){
      s.ssSec += dt;
      // The unit probe. Supersonic is a fixed 2200 uu/s and the car caps at
      // 2300, so the fastest sample seen WHILE supersonic lands in a band that
      // names the unit outright: ~79-83 km/h, ~49-51 mph, or 2200-2300 uu/s.
      // (The flag itself lingers below the threshold after a hard stop, so the
      // minimum while supersonic proves nothing — the maximum does.)
      if (spd > s.ssMaxSpd) s.ssMaxSpd = spd;
    }
    if (!onG) s.airSec += dt;
    if (onW) s.wallSec += dt;
    if (p.bBoosting === true) s.boostingSec += dt;
    if (p.bPowersliding === true) s.slideSec += dt;
    // Time per speed band, so a "slow" threshold stays a decision the metric
    // engine makes later and can revise — never one frozen into the archive.
    s.hist[Math.min(MOVE_BINS - 1, Math.max(0, Math.floor(spd / MOVE_BIN_W)))] += dt;
    s.bhist[Math.min(MOVE_BOOST_BINS - 1, Math.max(0, Math.floor(bst / MOVE_BOOST_W)))] += dt;

    /* Jumps, derived (M4b §3b). A car leaves the ground for one of three
     * reasons: it jumped, it was hit, or it drove off a wall. CarTouches is a
     * per-player counter, so a bump shows up as an increment; bOnWall names the
     * third. What is left is a jump. Double jumps stay unmeasurable — the
     * second one happens while already airborne, so nothing changes state, and
     * the feed carries no vertical speed to see it with. */
    let st = mv.p.get(p.Name);
    if (!st) mv.p.set(p.Name, st = { onG, ctVal: p.CarTouches, ctAt: 0, wallAt: 0 });
    if (typeof p.CarTouches === 'number' && p.CarTouches !== st.ctVal){ st.ctVal = p.CarTouches; st.ctAt = now; }
    if (onW) st.wallAt = now;
    if (!resync && st.onG && !onG && p.bHasCar === true)
      mv.pending.push({ name: p.Name, at: now, wall: now - st.wallAt < 250 });
    st.onG = onG;
  }

  // A pending take-off is judged once its +/-1 s contact window has passed.
  for (let i = mv.pending.length - 1; i >= 0; i--){
    const j = mv.pending[i];
    if (now - j.at < 1000) continue;
    mv.pending.splice(i, 1);
    const st = mv.p.get(j.name), a = mvAcc(m, j.name);
    if (st && st.ctAt > j.at - 1000) a.jumpBumps++;
    else if (j.wall) a.jumpWalls++;
    else a.jumps++;
  }
}

/* Match over: round the totals and fold the per-second buckets into the
 * parallel arrays the curve is drawn from. Rounding happens once, here, so the
 * archive stays small and every reader sees the same numbers — never a float
 * that renders differently in two places. */
function mvCompact(m){
  const r = (v, n) => { const f = Math.pow(10, n); return Math.round(v * f) / f; };
  for (const name of Object.keys(m.movement || {})){
    const a = m.movement[name];
    if (!(a.sec > 0)){ delete m.movement[name]; continue; }
    a.sec = r(a.sec, 2); a.spdInt = r(a.spdInt, 1); a.boostInt = r(a.boostInt, 1);
    a.spdMax = r(a.spdMax, 2); a.ssMaxSpd = r(a.ssMaxSpd, 2);
    a.ssSec = r(a.ssSec, 2); a.airSec = r(a.airSec, 2); a.wallSec = r(a.wallSec, 2);
    a.boostingSec = r(a.boostingSec, 2); a.slideSec = r(a.slideSec, 2);
    a.hist = a.hist.map(v => r(v, 2));
    a.bhist = a.bhist.map(v => r(v, 2));
  }
  for (const name of Object.keys(m.timeline || {})){
    const buckets = m.timeline[name];
    const t = [], spd = [], bst = [], air = [];
    for (const b of buckets){
      if (!(b.sec > 0)) continue;
      t.push(b.t);
      spd.push(r(b.spd / b.sec, 1));
      bst.push(Math.round(b.bst / b.sec));
      air.push(r(b.air / b.sec, 2));
    }
    if (t.length) m.timeline[name] = { t, spd, bst, air };
    else delete m.timeline[name];
  }
}
function recWrite(){
  const m = rec.m;
  rec.m = null;
  if (!m || !m.players.length || !m.scoreline.length) return;
  if (m.abandoned && !m.goals.length && !m.kickoffs.length) return;   // no gameplay observed (post-game artifact)
  m.endedAt = new Date().toISOString();
  mvCompact(m);
  // digest envelope (rl-director/DESIGN.md §3): downstream consumers key on these
  m.schema = 'digest/1';
  m.game = 'rl';
  m.adapterVersion = ADAPTER_VERSION;
  const sizes = [0, 0];
  for (const p of m.players) if (p.team === 0 || p.team === 1) sizes[p.team]++;
  // players is the FINAL snapshot — a leaver vacates it, so judge two-sidedness
  // on match history too (goals/kickoff first-touches carry team numbers).
  // Same evidence rule as metrics.validity(); freeplay has neither guid nor
  // two-sided history and still lands as 'offline'.
  const twoSided = (sizes[0] && sizes[1])
    || new Set(m.goals.map(g => g.team)).size > 1
    || new Set(m.kickoffs.map(k => k.team)).size > 1;
  m.mode = m.guid && twoSided ? 'online' : 'offline';
  const teamSize = Math.max(sizes[0], sizes[1]);
  m.playlist = teamSize >= 1 && teamSize <= 4 ? teamSize + 'v' + teamSize : 'other';
  // Feltnavnet Game.PlaylistId er brugerens egen feed-aflæsning; de offentlige
  // referencer dokumenterer det ikke. Én linje pr. online-kamp gør et fravær
  // synligt i stedet for tavst — en digest med null her må aldrig ligne måling.
  if (m.mode === 'online' && m.playlistId === null)
    console.log('[recorder] Game.PlaylistId aldrig set i feedet — digest.playlistId = null');
  const stamp = m.startedAt.replace(/[:.]/g, '-').slice(0, 19);
  const file = stamp + '-' + (m.guid || 'offline').slice(0, 12) + '.json';
  try{
    fs.mkdirSync(MATCH_DIR, { recursive: true });
    writeJSONAtomic(path.join(MATCH_DIR, file), m);
    console.log('[recorder] kamp gemt:', stamp, m.teams.map(t => t.score).join('-'),
      m.abandoned ? '(afbrudt)' : '');
  }catch(e){ console.log('[recorder] skrivefejl:', String(e.message || e)); }
  // Deliberately outside the write's try: a failed disk write (full disk,
  // locked file, a second process) used to skip the debrief entirely, so the
  // user lost the coaching as well as the archive entry. The digest is in
  // memory either way — the debrief can still be produced from it.
  if (director){
    try{
      const debrief = timed('director.onDigest', () => director.onDigest(m, file));
      if (debrief) broadcastSSE({ Event: '_director', Data: debrief });
    }catch(e){ console.log('[director] fejl:', String(e.message || e)); }
  }
  // Own rank after the match (PsyNet). Three tries: ranked wins book within
  // 25 s, but a tournament measured 18/8 booked one win only ~8 min after the
  // match (and a loss never) — so a late look catches what the early ones miss.
  if (m.mode === 'online' && !m.abandoned && (psynet || rankRelay)){
    setTimeout(() => psynetSelfLookup('kamp+25s'), 25e3);
    setTimeout(() => psynetSelfLookup('kamp+150s'), 150e3);
    setTimeout(() => psynetSelfLookup('kamp+10min'), 600e3);
  }
}
function recOnMsg(raw){
  let msg; try{ msg = JSON.parse(raw); }catch{ return; }
  let d = msg.Data;
  if (typeof d === 'string'){ try{ d = JSON.parse(d); }catch{ return; } }
  d = d || {};
  switch (msg.Event){
    case 'MatchCreated':
      if (rec.m) { rec.m.abandoned = true; recWrite(); }
      recNewMatch(d.MatchGuid);
      if (director && director.onMatchStart) director.onMatchStart();   // keeps the idle watchdog off a running match
      break;
    case 'ClockUpdatedSeconds': rec.clock = d.TimeSeconds; if ('bOvertime' in d) rec.overtime = !!d.bOvertime; break;
    case 'RoundStarted': rec.awaitKickoff = true; rec.roundStartClock = rec.clock; rec.lastHit = null; break;
    case 'UpdateState': {
      if (!d.Players || !d.Game) break;
      rankLearnNames(d.Players);        // the rank provider looks players up by name
      // podium/post-game frames after MatchEnded reuse the ended match's guid —
      // recreating from them wrote score-only duplicate digests (day-1 data)
      if (!rec.m && d.MatchGuid && d.MatchGuid === rec.lastEndedGuid) break;
      if (!rec.m) recNewMatch(d.MatchGuid);    // joined mid-match
      const m = rec.m;
      if (d.MatchGuid && !m.guid) m.guid = d.MatchGuid;
      m.arena = d.Game.Arena || m.arena;
      if (typeof d.Game.PlaylistId === 'number') m.playlistId = d.Game.PlaylistId;
      m.overtime = m.overtime || !!d.Game.bOvertime;
      m.teams = (d.Game.Teams || []).map(t => ({ name: t.Name, score: t.Score ?? 0 }));
      m.players = d.Players.map(p => ({
        name: p.Name, pid: p.PrimaryId || null, team: p.TeamNum, score: p.Score ?? 0,
        goals: p.Goals ?? 0, assists: p.Assists ?? 0, saves: p.Saves ?? 0,
        shots: p.Shots ?? 0, touches: p.Touches ?? 0, demos: p.Demos ?? 0
      }));
      const s0 = m.teams[0] ? m.teams[0].score : 0, s1 = m.teams[1] ? m.teams[1].score : 0;
      const last = m.scoreline[m.scoreline.length - 1];
      if (!last || last.s0 !== s0 || last.s1 !== s1)
        m.scoreline.push({ clock: d.Game.TimeSeconds ?? rec.clock, ot: !!d.Game.bOvertime, s0, s1 });
      for (const p of d.Players){
        if (typeof p.Boost !== 'number') continue;          // own team only (SPECTATOR fields)
        const b = m.boost[p.Name] || (m.boost[p.Name] = { samples: 0, sum: 0, low: 0 });
        b.samples++; b.sum += p.Boost;
        if (p.Boost < 15) b.low++;
      }
      recMovement(d, m, Date.now());
      break;
    }
    case 'BallHit': {
      if (!rec.m) break;
      const spd = d.Ball && d.Ball.PostHitSpeed, loc = (d.Ball && d.Ball.Location) || null,
            y = loc && loc.Y,
            /* 26/8 (radar-sporet): X = sidelinje-aksen (banekort), Z = hoejden ved
             * beroering (det foerste aerlige aerial-signal feedet har givet os).
             * Defensivt: mangler felterne, bliver de null — aldrig gaettet. */
            x = loc && loc.X, z = loc && loc.Z;
      for (const pl of (d.Players || [])){
        if (!pl || !pl.Name) continue;
        /* A pass, as far as the feed can honestly see one: his touch, then a
         * team-mate's, with no opponent touch in between. It says nothing about
         * whether it was intended — hence the name is the sequence, not the
         * intent. The chain is cut at every kickoff and every goal, so a touch
         * either side of a restart is never joined into one. */
        const prevHit = rec.lastHit;
        if (prevHit && prevHit.name !== pl.Name && prevHit.team === pl.TeamNum)
          rec.m.passes[prevHit.name] = (rec.m.passes[prevHit.name] || 0) + 1;
        rec.lastHit = { name: pl.Name, team: pl.TeamNum };

        const h = rec.m.hits[pl.Name] || (rec.m.hits[pl.Name] = { count: 0, sumSpeed: 0, maxSpeed: 0, plusY: 0, minusY: 0 });
        h.count++;
        if (typeof spd === 'number'){ h.sumSpeed += spd; if (spd > h.maxSpeed) h.maxSpeed = spd; }
        if (typeof y === 'number'){ y > 0 ? h.plusY++ : h.minusY++; }
        /* Tidsstemplet udgave af samme touch. `t` deler akse med goals/kickoffs
         * (kampuret — null i træning, hvor det aldrig løber), `w` er sekunder
         * på vægguret siden digest-start og overlever både træning og pauser.
         * Cappet, og cappen er aldrig tavs (hitEventsDropped) — en trunkeret
         * liste der ligner en komplet ville lyve om stimerne. */
        if (rec.m.hitEvents.length < HIT_EVENTS_MAX){
          rec.m.hitEvents.push({
            t: typeof rec.clock === 'number' ? rec.clock : null,
            w: Math.round((Date.now() - rec.mStartMs) / 100) / 10,
            name: pl.Name, team: pl.TeamNum,
            spd: typeof spd === 'number' ? Math.round(spd) : null,
            y: typeof y === 'number' ? Math.round(y) : null,
            x: typeof x === 'number' ? Math.round(x) : null,
            z: typeof z === 'number' ? Math.round(z) : null
          });
        } else rec.m.hitEventsDropped = (rec.m.hitEventsDropped || 0) + 1;
        if (rec.awaitKickoff){
          rec.awaitKickoff = false;
          rec.m.kickoffs.push({ clock: rec.clock, firstTouch: pl.Name, team: pl.TeamNum,
            speed: typeof spd === 'number' ? Math.round(spd) : null });
        }
      }
      break;
    }
    case 'GoalScored':
      rec.lastHit = null;                                // the pass chain never crosses a goal
      if (rec.m && d.Scorer && d.Scorer.Name){           // skip phantom goals
        const loc = d.ImpactLocation || {};
        rec.m.goals.push({ clock: rec.clock, ot: rec.overtime, scorer: d.Scorer.Name, team: d.Scorer.TeamNum,
          /* w: vaegur-sekunder siden digest-start, samme akse som hitEvents.w —
           * saa et maal kan sys til beroeringerne foer det (RADAR-DESIGN §8, 1.5.0) */
          w: Math.round((Date.now() - rec.mStartMs) / 100) / 10,
          assist: (d.Assister && d.Assister.Name) || null,
          speed: typeof d.GoalSpeed === 'number' ? Math.round(d.GoalSpeed) : null,
          // goal-line Y: lets metrics calibrate attack direction per match (never assumed)
          impactY: typeof loc.Y === 'number' ? Math.round(loc.Y) : null,
          // X/Z (1.5.0): hvor i maalet bolden gik ind — additive, null naar feedet ikke sender dem
          impactX: typeof loc.X === 'number' ? Math.round(loc.X) : null,
          impactZ: typeof loc.Z === 'number' ? Math.round(loc.Z) : null });
      }
      break;
    case 'StatfeedEvent':
      if (rec.m && d.EventName === 'Demolish' && d.MainTarget)
        rec.m.demos.push({ clock: rec.clock, attacker: d.MainTarget.Name,
          victim: (d.SecondaryTarget && d.SecondaryTarget.Name) || null, team: d.MainTarget.TeamNum });
      break;
    case 'MatchEnded':
      if (rec.m){ rec.lastEndedGuid = rec.m.guid || null; rec.m.winnerTeamNum = d.WinnerTeamNum; recWrite(); }
      break;
    case 'MatchDestroyed':
      if (rec.m){ rec.lastEndedGuid = rec.m.guid || null; rec.m.abandoned = true; recWrite(); }
      break;
  }
}
/* The recorder rides the shared feed and never lets go: telemetry keeps
 * recording with no page open, and the feed reconnects on its own. */
function startRecorder(){
  let wasConnected = false;             // a connect that never landed is not a shutdown
  const feed = getFeed(STATS_HOST, STATS_PORT);
  console.log('[feed] spillets strøm læses i ' + (feed.mode === 'worker' ? 'sin egen tråd' : 'hovedtråden'));
  feed.add(recOnMsg, state => {
    if (state === 'connected'){
      wasConnected = true; console.log('[recorder] forbundet til spillet');
      // et levende feed beviser at ini'en virker — rydder et evt. "genstart spillet"-banner
      if (statsGuard) try{ statsGuard.feedConnected(); }catch{}
      return;
    }
    /* Feedet svarer ikke: spillet er lukket — eller en opdatering er i gang og
     * har måske allerede nulstillet ini'en. Vagtens tjek her (debounced) retter
     * filen FØR spillet starter igen, så næste launch virker fra første sekund. */
    if (statsGuard) try{ statsGuard.feedDropped(); }catch{}
    if (!wasConnected) return;
    wasConnected = false;
    if (rec.m){ rec.m.abandoned = true; recWrite(); }
    // an ESTABLISHED connection dropping means the game itself was shut down
    if (director && director.onGameDisconnect){
      try{ director.onGameDisconnect(); }catch(e){ console.log('[session] fejl:', String(e.message || e)); }
    }
  });
}
startRecorder();
// idle watchdog: the session engine closes a session after IDLE_REPORT_MS
// without a new match (session.js keeps it equal to the session gap)
setInterval(() => {
  if (director && director.tick) try{ director.tick(); }catch(e){ console.log('[session] fejl:', String(e.message || e)); }
}, 60e3);

/* Focus meter: measure the focus metric on the match in progress and push it
 * to the open boards. Only while a match is running and someone is watching —
 * with no page open there is nothing to draw. */
const FOCUS_TICK_MS = 3000;
let lastFocusLive = '';
setInterval(() => {
  if (!director || !director.focusLive || !rec.m || !sseClients.size) return;
  let fl = null;
  try{ fl = director.focusLive(rec.m); }catch{ return; }
  if (!fl) return;
  const sig = fl.metricId + '|' + fl.valueText + '|' + fl.samples;
  if (sig === lastFocusLive) return;                 // nothing moved since last tick
  lastFocusLive = sig;
  broadcastSSE({ Event: '_focusLive', Data: fl });
}, FOCUS_TICK_MS);

/* ---------------- http server ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJSON(res, code, obj){
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* Read a small request body. Capped (in BYTES) and destroyed past the cap so a
 * stray or hostile client can't grow the process — the recorder shares it.
 * Chunks are kept as buffers and decoded once at the end (3/9): decoding each
 * TCP chunk on its own turned an æ/ø/å split across two chunks into U+FFFD. */
function readBody(req, max){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', d => {
      n += d.length;
      if (n > max){ req.destroy(); return reject(new Error('body for stor')); }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* Cross-site POST guard (3/9). The server is loopback-only, but every page in
 * the user's browser can reach loopback, and a form POST or a no-cors fetch
 * with a text/plain body is a CORS "simple request" that needs NO preflight —
 * so the old comment "a JSON POST needs a preflight a foreign origin will not
 * get" was wrong. Two checks, both cheap:
 *   - Sec-Fetch-Site, when a browser sends it, must be same-origin or none
 *   - an Origin header, when present, must name this server's host and port
 * A request with neither header (curl, scripts, the overlay host) passes: it
 * is not a browser carrying somebody else's page. */
function sameOrigin(req){
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  const o = req.headers.origin;
  if (!o) return true;
  let u, h;
  try{ u = new URL(o); h = new URL('http://' + (req.headers.host || '')); }catch{ return false; }
  const port = x => x.port || (x.protocol === 'https:' ? '443' : '80');
  return u.hostname === h.hostname && port(u) === (h.port || String(PORT));
}
/* The routes that parse a body only accept JSON, said out loud in the header:
 * the same guard keeps a text/plain "simple request" from being parsed as
 * JSON, and gives a scripted client a clear 415 instead of a 400. */
function isJsonBody(req){
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
}
function requireJson(req, res){
  if (isJsonBody(req)) return true;
  sendJSON(res, 415, { ok: false, reason: 'Content-Type skal være application/json' });
  return false;
}

/* Static files with revalidation instead of no-store: the tracker page is
 * ~120 KB and ds.css another 42 KB, and the board gets reloaded a lot. An
 * ETag turns each reload into a 304 with no body, while 'no-cache' still
 * forces a check every time, so an edited file is never served stale.
 * Text is gzipped for LAN devices; the ETag identifies the file, not the
 * encoding, so Vary keeps a proxy from mixing the two up. */
const TEXTUAL = /^(text\/|application\/(javascript|json)|image\/svg)/;

/* This server listens on 0.0.0.0 so LAN devices can open the board — which
 * means everything it serves is readable by anything on the network. The app
 * directory is NOT a web root: rank-cache.json holds the user's RapidAPI key,
 * profile.json and matches/ hold personal telemetry, and the .bat/.ps1
 * launchers have no business being downloadable. Serve the page's own assets
 * and the generated reports; refuse the rest. */
/* Hvilken overlay-vaert kan serveren starte? (Linux-sporet 6/9, RADAR-DESIGN §8 +
 * docs/LINUX-OVERLAY.md.) Ren funktion — platform, miljoe og "findes filen"
 * gives udefra, saa linux-paths.test.js kan koere den paa Windows.
 *   win32: RLOverlay.exe ved siden af serveren (uaendret siden 25/8)
 *   linux: RL_OVERLAY_CMD (en shell-linje brugeren selv ejer) — ellers
 *          linux-overlay/ i ROOT eller lige over ROOT med Electron installeret
 *          (node_modules/electron findes = `npm install` er koert)
 *   alt andet (darwin): ingen vaert, knappen skjules som foer. */
function findOverlayLauncher(platform, env, root, exists){
  if (platform === 'win32'){
    const exe = path.join(root, 'RLOverlay.exe');
    return exists(exe) ? { kind: 'exe', exe } : null;
  }
  if (platform !== 'linux') return null;
  if (env.RL_OVERLAY_CMD) return { kind: 'cmd', cmd: String(env.RL_OVERLAY_CMD) };
  for (const dir of [path.join(root, 'linux-overlay'), path.join(root, '..', 'linux-overlay')]){
    if (exists(path.join(dir, 'main.js')) && exists(path.join(dir, 'node_modules', 'electron')))
      return { kind: 'electron', dir };
  }
  return null;
}
/* pgrep-moenster for Electron-vaerten: `electron .` / `electron --no-sandbox .` /
 * `electron /sti/linux-overlay`. Renderer-boern matcher ikke (ingen "." som eget
 * argument), men det er ligegyldigt — de lever kun mens hovedprocessen goer.
 * RL_OVERLAY_PGREP overstyrer for den der starter vaerten paa sin egen maade. */
const OVERLAY_PGREP = 'electron[^ ]* (.* )?(\\.|[^ ]*linux-overlay[^ ]*)( |$)';
/* Koerer overlayet? Samme greb som statsapi-guard bruger paa spillet: tasklist
 * (Windows) / pgrep (Linux) er det eneste svar, der ikke kraever rettigheder.
 * "Ved det ikke" behandles som "koerer ikke" — at starte en kopi mere er
 * ufarligt (begge vaerter er single-instance). Windows-grenen er uaendret. */
function overlayRunning(){
  return new Promise(resolve => {
    if (process.platform === 'linux'){
      try{
        require('child_process').execFile('pgrep', ['-f', process.env.RL_OVERLAY_PGREP || OVERLAY_PGREP],
          { timeout: 8e3 },
          (err, stdout) => resolve(!err && String(stdout).trim().length > 0));
      }catch{ resolve(false); }
      return;
    }
    if (process.platform !== 'win32') return resolve(false);
    try{
      require('child_process').execFile('tasklist',
        ['/FI', 'IMAGENAME eq RLOverlay.exe', '/NH', '/FO', 'CSV'],
        { windowsHide: true, timeout: 8e3 },
        (err, stdout) => resolve(!err && /RLOverlay\.exe/i.test(String(stdout))));
    }catch{ resolve(false); }
  });
}
/* Vaertens statusfil (7/9): RLOverlay.exe skriver overlay-status.json ved siden
 * af sig selv (= ROOT) ved hvert skift og som puls hvert 10. sekund:
 * {version, fullscreen, game, shown, at}. fullscreen = spillet koerer exclusive
 * fullscreen, og vaerten holder kortene parkeret (et vindue over spillet ville
 * sparke det ud paa skrivebordet — overlay-host/Program.cs). Ren funktion: tekst
 * + "nu" ind, dom ud. En fil aeldre end 30 s (vaerten lukket haardt) er ingen dom,
 * og daarlig JSON (halvt skrevet) er ingen dom. Vaerten sletter filen ved lukning. */
const OVERLAY_STATUS_FILE = 'overlay-status.json';
const OVERLAY_STATUS_MAX_AGE = 30e3;
function readOverlayStatus(text, now){
  let j;
  try{ j = JSON.parse(String(text || '')); }catch{ return null; }
  if (!j || typeof j !== 'object' || !Number.isFinite(j.at)) return null;
  const age = now - j.at;
  if (age < -60e3 || age > OVERLAY_STATUS_MAX_AGE) return null;
  return { fullscreen: j.fullscreen === true, game: j.game === true, shown: j.shown === true,
           version: typeof j.version === 'string' ? j.version.slice(0, 32) : null, age };
}
function overlayStatus(){
  try{ return readOverlayStatus(fs.readFileSync(path.join(ROOT, OVERLAY_STATUS_FILE), 'utf8'), Date.now()); }
  catch{ return null; }
}
/* Start vaerten loesrevet fra serveren (detached + unref: overlayet skal overleve,
 * at serveren genstartes). 'error' SKAL lyttes paa: en ENOENT fra spawn kommer
 * som asynkron event og vaelter processen trods try/catch (maalt 6/9, crit R3-G1). */
function spawnOverlay(launcher){
  const { spawn } = require('child_process');
  let child;
  if (launcher.kind === 'exe'){
    child = spawn(launcher.exe, [], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  } else {
    const env = Object.assign({}, process.env);
    if (!env.RL_OVERLAY_URL) env.RL_OVERLAY_URL = 'http://localhost:' + PORT + '/?overlay&glass';
    // Statusfilen skal ligge i ROOT (den laeses her) — vaerten bor i linux-overlay/ (docs/LINUX-OVERLAY.md §10).
    if (!env.RL_OVERLAY_STATUS) env.RL_OVERLAY_STATUS = path.join(ROOT, OVERLAY_STATUS_FILE);
    if (launcher.kind === 'cmd')
      child = spawn('/bin/sh', ['-c', launcher.cmd], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
    else
      child = spawn(path.join(launcher.dir, 'node_modules', '.bin', 'electron'), ['.'],
        { cwd: launcher.dir, env, detached: true, stdio: 'ignore' });
  }
  child.on('error', e => console.log('[overlay] kunne ikke starte vaerten: ' + String((e && e.code) || e)));
  child.unref();
}

const PUBLIC_FILES = new Set(['RLLiveTracker.html', 'ds.css', 'icons.svg', 'icon.ico',
  /* Stadium night-skinnets assets (26/8): CC0-teksturer (ambientCG Fabric004 +
   * Metal009) og Archivo variabel-font (OFL) — statiske, ingen spillerdata. */
  'skin-carbon.jpg', 'skin-metal.jpg', 'skin-stadium.jpg', 'archivo-var.woff2']);

/* ---------- Event-radar: aggregat over alle digests (26/8) -----------------
 * Laeser matches/*.json og bygger banetryk langs laengdeaksen: ejerens egne
 * beroeringer, medspilleres og modstanderes, hver i 44 buckets over
 * [-5500, 5500] uu (banen er ±5120, resten er maalzonen). Kampene vendes saa
 * ejerens forsvar ALTID ligger i minus-enden — på tvaers af hold-tildeling.
 * Cache paa (antal filer + nyeste filnavn): en ny kamp invaliderer, alt andet
 * er gratis. Ejeren = director.getTracked() (pid foerst, navn som fallback);
 * kampe hvor ejeren ikke er på banen (gaester m.v.) taelles ikke med. */
/* Traeningsbane-daekket: alle tre kataloger foldet til eet traek-daek.
 * Cachet for evigt pr. proces — katalogerne aendrer sig kun ved deploy. */
let packDeckCache = null;
function packDeck(){
  if (packDeckCache) return packDeckCache;
  const out = [];
  for (const f of ['pack-catalog.json', 'pack-catalog-variety.json', 'pack-catalog-prejump.json']){
    try{
      const c = JSON.parse(fs.readFileSync(path.join(DIR_ROOT, 'director', f), 'utf8'));
      const arr = Array.isArray(c) ? c : (c.packs || []);
      for (const p of arr){
        if (!p || !p.code || !p.name) continue;
        out.push({ name: String(p.name), code: String(p.code),
                   creator: p.creator || p.from || null,
                   difficulty: p.difficulty || (p.rating != null ? p.rating + '/50' : null) });
      }
    }catch{}
  }
  packDeckCache = out;
  return out;
}

/* Selve aggregatet bor i director/pitch.js (3/9): per-fil-cache, kun nye
 * kampe laeses, og director/test/pitch.test.js beviser at det giver samme
 * svar som den gamle fulde genlaesning. Her bestemmes kun HVEM ejeren er. */
function pitchAggregate(){
  if (!pitch) throw new Error('banekortet er ikke indlaest (director/pitch.js)');
  const tr = director && director.getTracked ? (director.getTracked() || {}) : {};
  return pitch.aggregate(path.join(ROOT, 'matches'), {
    pid: tr.ownerPid || tr.trackedPid || tr.pid || '',
    name: tr.ownerName || tr.trackedName || tr.name || '' });
}

/* ---------- Baneradarens zoner paa /api/pitch (7/9, RADAR-DESIGN.md §3/§6) ----
 * Rene hjaelpere (ingen I/O): director/test/pitch-radar.test.js klipper dem ud
 * af kildeteksten som server-fns.test.js goer. Formen er STABIL — HTML'ens
 * radar-panel laeser den:
 *
 *   radar: {
 *     week: { key, from, to,               // ISO-spilleugen (06:00-reglen) der er talt
 *             located, noX, ko, n,         // stedfaestede / uden x / heraf kickoff-maal / alle bundne
 *             zones: { D1:{n,share} … D6 },   // share = n/located
 *             offense: { zones:{ O1:{goals,touches,per100} … }, front:{per100} } | null },
 *     marked: { def: { zone, n, located, share } | null,   // kun naar gaten er bestaaet
 *               off: { zone, goals, touches, per100 } | null,
 *               fromWeek: '2026-W36' | null },   // sat naar ugen var for tynd og forrige uge blev talt
 *     gate: { ok, reason } | null,          // trin B's dom; null = trin B mangler (kun taellinger)
 *     longRun: { located, noX, ko, zones:{…}, excluded, unbound },   // hele arkivet
 *     excluded: { private, mutators }, unbound,   // ugens
 *     orientationVerified: false            // ±x er IKKE set i spillet endnu (§1)
 *   }
 *
 * Uden trin B (profile/offenseProfile mangler eller kaster 'not implemented')
 * bliver zone-TAELLINGERNE stadig leveret, marked er tomt og gate null — saa
 * overlayet kan tegne tallene i aften og zonerne naar trin B lander. */
const RADAR_WEEK_MIN_LOCATED = 10;   // under dette (fx mandag morgen) tælles forrige lukkede uge (§3 'fra uge N')
const RADAR_WEEK_GATE = { min: 40, zoneMin: 10, zoneShare: 0.25 };   // kontraktens uge-gate, bruges hvis trin B ikke eksporterer sin egen

/* Zone-taellinger for en liste skudsteder [x|null, y, minut, z|null, day, ko]. */
function radarZoneCounts(entries, R, family){
  const p = family === 'off' ? 'O' : 'D';
  const zones = {};
  for (let i = 1; i <= 6; i++) zones[p + i] = { n: 0, share: 0 };
  let located = 0, noX = 0, ko = 0, n = 0;
  for (const e of (entries || [])){
    if (!Array.isArray(e)) continue;
    n++;
    let z = null;
    try{ z = R && R.zoneOf ? R.zoneOf(e[0], e[1], e[3], family) : null; }catch{ z = null; }
    if (!z){ noX++; continue; }
    located++;
    zones[z].n++;
    if (e[5]) ko++;
  }
  if (located) for (const k of Object.keys(zones)) zones[k].share = zones[k].n / located;
  return { n, located, noX, ko, zones };
}

/* Kampfiler der hoerer til spilleugen wk ({from,to} som YYYY-MM-DD). Filnavnet
 * er UTC-stemplet startedAt (YYYY-MM-DDTHH-MM-SS-…); spilledoegnet regnes med
 * weekly.playDay (06:00 lokal) — samme regel som resten af ugerapporten. */
function radarFilesOfWeek(files, wk, playDay){
  const out = [];
  for (const f of (files || [])){
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f);
    if (!m) continue;
    const day = playDay(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z');
    if (day && day >= wk.from && day <= wk.to) out.push(f);
  }
  return out;
}

/* Selve blokken. agg = hele arkivets aggregat (pitch.aggregate), week =
 * {key,from,to} + weekFold = pitch.foldEntries for ugens filer; prevWeek/
 * prevFold = forrige lukkede uge (kun brugt naar ugen er for tynd; maa vaere
 * null). R = director/radar.js (maa vaere null). Kaster aldrig. */
function radarBlock(agg, week, weekFold, prevWeek, prevFold, R){
  const empty = { matches: 0, scoredFrom: [], concededFrom: [], mineZones: {}, excluded: { private: 0, mutators: 0 }, unbound: 0 };
  let wk = week, fold = weekFold || empty, fromWeek = null;
  let counts = radarZoneCounts(fold.concededFrom, R, 'def');
  if (counts.located < RADAR_WEEK_MIN_LOCATED && prevWeek && prevFold){
    const pc = radarZoneCounts(prevFold.concededFrom, R, 'def');
    if (pc.located > counts.located){ wk = prevWeek; fold = prevFold; counts = pc; fromWeek = prevWeek.key; }
  }
  // trin B: profil + gate. Mangler den, eller kaster den, staar taellingerne alene.
  let prof = null, off = null, gate = null;
  try{ if (R && typeof R.profile === 'function') prof = R.profile(fold.concededFrom, R.WEEK_GATE || RADAR_WEEK_GATE) || null; }catch{ prof = null; }
  try{ if (R && typeof R.offenseProfile === 'function') off = R.offenseProfile(fold.scoredFrom, fold.mineZones) || null; }catch{ off = null; }
  if (prof && prof.gate && typeof prof.gate.ok === 'boolean') gate = { ok: prof.gate.ok, reason: prof.gate.reason || null };
  // trin B's egne tal vinder for zonerne naar de findes (samme geometri; profilen kan bære noZ m.m.)
  const zones = prof && prof.zones ? prof.zones : counts.zones;
  const located = prof && Number.isFinite(prof.located) ? prof.located : counts.located;
  const zoneId = v => typeof v === 'string' ? v : (v && (v.id || v.zone)) || null;
  let def = null;
  if (gate && gate.ok){
    const d = zoneId(prof.dominant);
    const zc = d && zones[d] ? zones[d] : null;
    if (d && zc) def = { zone: d, n: zc.n, located, share: Number.isFinite(zc.share) ? zc.share : (located ? zc.n / located : 0) };
  }
  let offMarked = null, offense = null;
  if (off && off.zones){
    offense = { zones: off.zones, front: off.front || null };
    const w = Array.isArray(off.weak) && off.weak.length ? zoneId(off.weak[0]) : null;
    const gateOff = !off.gate || off.gate.ok !== false;
    if (w && off.zones[w] && gateOff)
      offMarked = { zone: w, goals: off.zones[w].goals, touches: off.zones[w].touches, per100: off.zones[w].per100 };
  }
  const lr = radarZoneCounts(agg && agg.concededFrom, R, 'def');
  return {
    week: { key: wk ? wk.key : null, from: wk ? wk.from : null, to: wk ? wk.to : null,
            located, noX: prof && Number.isFinite(prof.noX) ? prof.noX : counts.noX,
            ko: prof && Number.isFinite(prof.kickoff) ? prof.kickoff : counts.ko, n: counts.n,
            zones, offense },
    marked: { def, off: offMarked, fromWeek },
    gate,
    longRun: { located: lr.located, noX: lr.noX, ko: lr.ko, zones: lr.zones,
               excluded: (agg && agg.excluded) || { private: 0, mutators: 0 }, unbound: (agg && agg.unbound) || 0 },
    excluded: fold.excluded || { private: 0, mutators: 0 }, unbound: fold.unbound || 0,
    orientationVerified: !!(R && R.ORIENTATION_VERIFIED)
  };
}

/* /api/pitch-svaret: arkivets aggregat + radar-blokken. Ugefoldet er lille
 * (contributionsFor slaar op i den per-fil-cache aggregate() lige har fyldt,
 * saa ingen fil laeses igen) og maa aldrig vaelte banekortet: fejler noget i
 * radar-delen, sendes aggregatet uden `radar`. */
function pitchWithRadar(){
  const agg = pitchAggregate();
  let block = null;
  try{
    if (weeklyFns && pitch.contributionsFor && pitch.foldEntries){
      const tr = director && director.getTracked ? (director.getTracked() || {}) : {};
      const owner = { pid: tr.ownerPid || tr.trackedPid || tr.pid || '', name: tr.ownerName || tr.trackedName || tr.name || '' };
      const dir = path.join(ROOT, 'matches');
      const files = pitch.listFiles(dir);
      const wk = weeklyFns.currentWeek();
      const fold = pitch.foldEntries(pitch.contributionsFor(dir, radarFilesOfWeek(files, wk, weeklyFns.playDay), owner));
      let prevWk = null, prevFold = null;
      if (radarZoneCounts(fold.concededFrom, radar, 'def').located < RADAR_WEEK_MIN_LOCATED){
        const [y, m, d] = wk.from.split('-').map(Number);
        const pd = new Date(y, m - 1, d - 1);
        prevWk = weeklyFns.isoWeekOf(pd.getFullYear() + '-' + String(pd.getMonth() + 1).padStart(2, '0') + '-' + String(pd.getDate()).padStart(2, '0'));
        prevFold = pitch.foldEntries(pitch.contributionsFor(dir, radarFilesOfWeek(files, prevWk, weeklyFns.playDay), owner));
      }
      block = radarBlock(agg, wk, fold, prevWk, prevFold, radar);
    } else block = radarBlock(agg, null, null, null, null, radar);
  }catch(e){ console.log('[radar] blokken fejlede (banekortet sendes uden):', String(e.message || e)); block = null; }
  return block ? Object.assign({}, agg, { radar: block }) : agg;
}
function isPublic(rel){
  // A NUL byte reaches here via %00 and makes fs.* throw SYNCHRONOUSLY
  // (ERR_INVALID_ARG_VALUE) — inside an async handler that took the whole
  // process down, recorder and all. Reject the byte before it touches fs.
  if (rel.includes('\0')) return false;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some(p => p === '..' || p.startsWith('.'))) return false;
  if (parts.length === 1) return PUBLIC_FILES.has(parts[0]);
  if (parts.length === 2) return parts[0] === 'reports' && /\.(html|json)$/i.test(parts[1]);
  // a guest's reports (guest mode, 19/8): guests/<id>/reports/<file> — the
  // id is the director's own sanitised form, letters/digits/underscore only
  return parts.length === 4 && parts[0] === 'guests' && /^[A-Za-z0-9_]{1,80}$/.test(parts[1])
      && parts[2] === 'reports' && /\.(html|json)$/i.test(parts[3]);
}

function sendStatic(req, res, full){
  try{
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()){ res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + st.size.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '"';
    const head = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'ETag': etag, 'Vary': 'Accept-Encoding' };
    const inm = req.headers['if-none-match'];
    if (inm === etag || inm === etag.slice(0, -1) + '-gz"'){ res.writeHead(304, { ...head, 'ETag': inm }); return res.end(); }
    fs.readFile(full, (e2, buf) => {
      if (e2){ res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      const gzipOK = TEXTUAL.test(type) && buf.length > 1024
        && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      if (!gzipOK){ res.writeHead(200, head); return res.end(buf); }
      zlib.gzip(buf, (e3, gz) => {
        if (e3){ res.writeHead(200, head); return res.end(buf); }
        // distinct ETag per content-coding (RFC 9110) so a cache can't pair a
        // stored gzip body with a 304 from an identity request
        res.writeHead(200, { ...head, 'ETag': etag.slice(0, -1) + '-gz"',
          'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
        res.end(gz);
      });
    });
  });
  }catch(e){                                   // fs can throw synchronously on bad paths
    try{ res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }catch{}
  }
}

const server = http.createServer(async (req, res) => {
  // a request line the URL parser rejects ("//[") used to throw here, inside
  // an async handler: logged as an unhandled rejection, response never ended
  let url;
  try{ url = new URL(req.url, 'http://x'); }
  catch{ res.writeHead(400); return res.end(); }
  if (req.method === 'POST' && !sameOrigin(req)) return sendJSON(res, 403, { ok: false, reason: 'cross-site POST afvist' });
  if (url.pathname === '/api/stream') return handleStream(url, req, res);
  const rankImg = url.pathname.match(/^\/api\/rankimg\/([A-Za-z_]{1,40})\.png$/);
  if (rankImg){
    const png = rankImage(rankImg[1]);
    if (!png){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(png);
  }
  try{
    /* Reach: hvilke coach-data bliver overhovedet hentet (panelåbninger og
     * boardets pulls). Kun arten tælles — aldrig indholdet. */
    if (reach && req.method === 'GET' && /^\/api\/(debrief|session|weekly|focus)$/.test(url.pathname))
      reach.hit('api_' + url.pathname.slice(5));
    /* Boardets chrome følger motorens sprog (backlog 11/8, implementeret 14/8).
     * KUN language-feltet forlader processen — director-ai.json bærer også
     * brugerens Anthropic-nøgle og må aldrig serveres i sin helhed. */
    if (url.pathname === '/api/lang'){
      /* Motorens sprog vinder KUN når det faktisk er valgt (director-ai.json
       * findes). Uden config svares null, og klienten følger maskinens eget
       * sprog — en frisk engelsk tester må aldrig møde dansk chrome
       * (Reddit-testrunden 26/8; K4W's danske Windows giver stadig dansk). */
      let lang = null;
      try{ lang = JSON.parse(fs.readFileSync(path.join(ROOT, 'director-ai.json'), 'utf8')).language === 'en' ? 'en' : 'da'; }catch{}
      return sendJSON(res, 200, { lang });
    }
    /* StatsAPI-vagtens dom — til fejlsøgning og /rl-tracker-status. iniPath er
     * en lokal spilsti, ingen hemmelighed; nøglefiler rører vagten aldrig. */
    if (url.pathname === '/api/statsapi')
      return sendJSON(res, 200, statsGuard ? (statsGuard.status() || { pending: true }) : { ok: null, reason: 'vagt ikke indlæst' });
    if (url.pathname === '/api/update')
      return sendJSON(res, 200, updateCheck ? (updateCheck.status() || { pending: true, appVersion: APP_VERSION })
                                            : { disabled: true, appVersion: APP_VERSION });
    /* PsyNet reader account (18/8). Status is readable from any board; the
     * login code and logout are loopback-only POSTs — the code is a one-shot
     * credential for the reader account and must not be settable from a LAN
     * page. The auth file itself is never served (not in PUBLIC_FILES). */
    if (url.pathname === '/api/psynet')
      return sendJSON(res, 200, { ...(psynet ? psynet.status() : { configured: false, connected: false, disabled: true }),
        relay: rankRelay ? rankRelay.status() : null });
    if (url.pathname === '/api/psynet/login' || url.pathname === '/api/psynet/logout'){
      if (!psynet) return sendJSON(res, 503, { ok: false, reason: 'psynet ikke indlæst' });
      if (req.method !== 'POST'){ res.writeHead(405); return res.end(); }
      if (!isLocalReq(req)) return sendJSON(res, 403, { ok: false, reason: 'kun fra denne maskine' });
      if (url.pathname.endsWith('/logout')) return sendJSON(res, 200, psynet.logout());
      if (!requireJson(req, res)) return;
      let body;
      try{ body = await readBody(req, 8192); }
      catch{ return sendJSON(res, 413, { ok: false, reason: 'body for stor' }); }
      let j = null; try{ j = JSON.parse(body); }catch{}
      if (!j || typeof j !== 'object') return sendJSON(res, 400, { ok: false, reason: 'ugyldig JSON' });
      const r = await psynet.loginWithCode(j.code);
      return sendJSON(res, r.ok ? 200 : 400, { ...r, status: psynet.status() });
    }
    /* Event-radaren (26/8): historisk banetryk fra digests. AERLIGHEDS-REGLEN:
     * gamle kampe kender kun laengdeaksen (y) og tegnes som scanlinjer;
     * beroeringer med x (gemt fra 26/8) returneres som praecise prikker.
     * Alt normaliseres saa ejerens eget maal ligger i minus-enden. */
    if (url.pathname === '/api/pitch') return sendJSON(res, 200, timed('pitchAggregate', pitchWithRadar));
    /* Tilfaeldig traeningsbane (26/8): uniform traek fra HELE kartoteket
     * (kerne + variety + prejump-arkivet). Kun navn/kode/ophav — ingen
     * anbefalings-paastand: knappen ER en terning og siger det selv. */
    if (url.pathname === '/api/pack/random'){
      const d = packDeck();
      if (!d.length) return sendJSON(res, 503, { error: 'kartoteket kunne ikke laeses' });
      return sendJSON(res, 200, { pack: d[Math.floor(Math.random() * d.length)], of: d.length });
    }
    if (url.pathname === '/api/playerranks') return sendJSON(res, 200, await playerRanks(url, req));
    if (url.pathname === '/api/debrief')     return sendJSON(res, 200, {
      debrief: director ? director.lastDebrief() : null,
      previous: director && director.prevDebrief ? director.prevDebrief() : null });
    /* Who the coach follows. POST rather than a query parameter on purpose:
     * the server is loopback-only, but any page in the user's browser can
     * reach loopback — a GET with parameters could be fired from an <img>.
     * The POST is guarded by sameOrigin() + requireJson() at the top. */
    if (url.pathname === '/api/tracked'){
      if (!director) return sendJSON(res, 503, { ok: false, reason: 'director ikke indlæst' });
      if (req.method === 'GET') return sendJSON(res, 200, director.getTracked());
      if (req.method === 'POST'){
        if (!requireJson(req, res)) return;
        let body;
        try{ body = await readBody(req, 2048); }
        catch{ return sendJSON(res, 413, { ok: false, reason: 'body for stor' }); }
        let j = null;
        try{ j = JSON.parse(body); }catch{}
        if (!j || typeof j !== 'object') return sendJSON(res, 400, { ok: false, reason: 'ugyldig JSON' });
        const r = director.setTracked(j.pid, j.name);
        return sendJSON(res, r.ok ? 200 : 400, r);
      }
      res.writeHead(405); return res.end();
    }
    /* Overlayet startet fra appen (25/8). Produktloven: hver flade skal have ét
     * oplagt næste skridt, og overlayet havde ingen — man skulle vide, at der lå
     * en .bat i vaerktoejer\. GET siger om det overhovedet kan lade sig gøre
     * (exe'en ligger ved siden af serveren) og om det allerede kører; POST
     * starter det. POST, ikke GET, af samme grund som /api/tracked: serveren er
     * loopback-only, men enhver side i brugerens browser kan nå loopback —
     * sameOrigin() øverst i handleren afviser fremmede origins. */
    if (url.pathname === '/api/overlay'){
      /* Linux (6/9): samme svar, anden vaert — findOverlayLauncher() ovenfor
       * vaelger RLOverlay.exe (win32) eller Electron-vaerten i linux-overlay/. */
      const launcher = findOverlayLauncher(process.platform, process.env, ROOT, fs.existsSync);
      const have = !!launcher;
      if (req.method === 'GET'){
        /* fullscreen (7/9): vaertens egen dom fra overlay-status.json — spillet
         * koerer exclusive fullscreen, kortene er parkeret, boardet viser chippen.
         * ?status er den stille udgave til chippens 5-sekunders-poll: kun filen,
         * ingen tasklist (den koster en proces pr. kald). */
        const st = have ? overlayStatus() : null;
        const fullscreen = !!(st && st.fullscreen);
        if (url.searchParams.has('status'))
          return sendJSON(res, 200, { available: have, fullscreen, host: st });
        return sendJSON(res, 200, { available: have, running: have ? await overlayRunning() : false, fullscreen, host: st });
      }
      if (req.method === 'POST'){
        if (!have) return sendJSON(res, 501, { ok: false, reason: process.platform === 'linux'
          ? 'ingen overlay-vaert: saet RL_OVERLAY_CMD eller koer `npm install` i linux-overlay/ (se docs/LINUX-OVERLAY.md)'
          : 'RLOverlay.exe ligger ikke ved siden af serveren' });
        if (await overlayRunning()) return sendJSON(res, 200, { ok: true, already: true });
        try{ spawnOverlay(launcher); }
        catch(e){ return sendJSON(res, 500, { ok: false, reason: String(e.message || e) }); }
        return sendJSON(res, 200, { ok: true, started: true });
      }
      res.writeHead(405); return res.end();
    }
    /* Speed unit (M4b). Stored server-side because the unit is FORMATTING and
     * every number the coach says is formatted in director/ — converting in the
     * browser would put a second authority on what a number means. */
    if (url.pathname === '/api/unit'){
      if (!director || !director.getUnit) return sendJSON(res, 503, { ok: false, reason: 'director ikke indlæst' });
      if (req.method === 'GET') return sendJSON(res, 200, director.getUnit());
      if (req.method === 'POST'){
        if (!requireJson(req, res)) return;
        let body;
        try{ body = await readBody(req, 512); }
        catch{ return sendJSON(res, 413, { ok: false, reason: 'body for stor' }); }
        let j = null; try{ j = JSON.parse(body); }catch{}
        if (!j || typeof j !== 'object') return sendJSON(res, 400, { ok: false, reason: 'ugyldig JSON' });
        const r = director.setUnit(j.unit);
        return sendJSON(res, r.ok ? 200 : 400, r);
      }
      res.writeHead(405); return res.end();
    }
    /* The one-tap label (M4b §5b). Write-only from the page's point of view —
     * nothing is ever shown back, because a score, a streak or a "you skipped
     * 3" would turn a free answer into an obligation, and an obligated answer
     * measures the obligation. */
    if (url.pathname === '/api/label'){
      if (!director || !director.setMatchLabel) return sendJSON(res, 503, { ok: false, reason: 'director ikke indlæst' });
      if (req.method !== 'POST'){ res.writeHead(405); return res.end(); }
      if (!requireJson(req, res)) return;
      let body;
      try{ body = await readBody(req, 512); }
      catch{ return sendJSON(res, 413, { ok: false, reason: 'body for stor' }); }
      let j = null; try{ j = JSON.parse(body); }catch{}
      if (!j || typeof j !== 'object') return sendJSON(res, 400, { ok: false, reason: 'ugyldig JSON' });
      const r = director.setMatchLabel(j.file, j.label);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    /* Testrunden (25/8, gate 6). POST, ikke GET-parametre, af samme grund som
     * /api/tracked: en fremmed origin i brugerens browser kan nå loopback;
     * sameOrigin() + requireJson() holder den ude. */
    if (url.pathname === '/api/testround'){
      if (!testround) return sendJSON(res, 503, { ok: false, reason: 'testround ikke indlæst' });
      if (req.method === 'GET') return sendJSON(res, 200, testround.status());
      if (req.method === 'POST'){
        if (!requireJson(req, res)) return;
        let body;
        try{ body = await readBody(req, 2048); }
        catch{ return sendJSON(res, 413, { ok: false, reason: 'body for stor' }); }
        let j = null; try{ j = JSON.parse(body); }catch{}
        if (!j || typeof j !== 'object' || typeof j.join !== 'boolean')
          return sendJSON(res, 400, { ok: false, reason: 'ugyldig JSON (join skal være true/false)' });
        const r = testround.choose(j.join, j.tester);
        return sendJSON(res, r.ok ? 200 : 400, r);
      }
      res.writeHead(405); return res.end();
    }
    if (url.pathname === '/api/feedback'){
      if (!testround) return sendJSON(res, 503, { ok: false, reason: 'testround ikke indlæst' });
      if (req.method !== 'POST'){ res.writeHead(405); return res.end(); }
      if (!requireJson(req, res)) return;
      let body;
      try{ body = await readBody(req, 8192); }
      catch{ return sendJSON(res, 413, { ok: false, reason: 'body for stor' }); }
      let j = null; try{ j = JSON.parse(body); }catch{}
      if (!j || typeof j.text !== 'string') return sendJSON(res, 400, { ok: false, reason: 'text mangler' });
      const r = await testround.send(j.text, { app: APP_VERSION, userAgent: UA });
      return sendJSON(res, r.ok ? 200 : 502, r);
    }
    if (url.pathname === '/api/session')     return sendJSON(res, 200, {
      report: director && director.sessionLatest ? director.sessionLatest() : null,
      current: director && director.sessionCurrent ? director.sessionCurrent() : null });
    // "Ugens fremgang": `current` is the running week (rebuilt per request),
    // `latest` the last CLOSED week, which is the one with an HTML report.
    if (url.pathname === '/api/weekly')      return sendJSON(res, 200, {
      current: director && director.weeklyCurrent ? director.weeklyCurrent() : null,
      latest:  director && director.weeklyLatest  ? director.weeklyLatest()  : null
    });
    // Form (23/8): the body barometer — local state, never uploaded
    if (url.pathname === '/api/form')        return sendJSON(res, 200, {
      form: director && director.formCurrent ? director.formCurrent() : null });
    if (url.pathname === '/api/focus')       return sendJSON(res, 200, {
      focus: director && director.focus ? director.focus() : null,
      live:  director && director.focusLive ? director.focusLive(rec.m) : null });
  }catch(e){
    return sendJSON(res, 503, { error: String(e.message || e) });
  }
  let rel = url.pathname === '/' || url.pathname === '/index.html' ? 'RLLiveTracker.html' : url.pathname.slice(1);
  try{ rel = decodeURIComponent(rel); }catch{ res.writeHead(400); return res.end(); }
  // resolve first, then require the result to sit INSIDE ROOT. A bare
  // startsWith(ROOT) also accepts a sibling like "rl-live-stats-backup".
  // Holds even when the server is opened to the network with HOST=0.0.0.0.
  const full = path.resolve(ROOT, rel);
  // both checks matter: isPublic names what may be served, the prefix test
  // makes sure a crafted path can't land outside ROOT (or in a sibling
  // directory, which a bare startsWith(ROOT) would have allowed)
  if (!isPublic(rel) || (full !== ROOT && !full.startsWith(ROOT + path.sep))){
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  /* Reach: sideåbninger pr. flade + rapportåbninger pr. rapporttype. */
  if (reach){
    if (rel === 'RLLiveTracker.html')
      reach.hit(url.searchParams.has('board') ? 'page_board'
              : url.searchParams.has('overlay') ? 'page_overlay' : 'page_main');
    else if (/^reports\//.test(rel) && /\.html$/i.test(rel))
      reach.hit(/^reports\/weekly-/.test(rel) ? 'report_weekly'
              : /^reports\/session-/.test(rel) ? 'report_session' : 'report_other');
  }
  sendStatic(req, res, full);
});

/* The recorder shares this process: an unhandled error anywhere would stop
 * telemetry mid-match and lose the digest. Log and keep running instead —
 * a broken request must never cost the user a match. */
process.on('uncaughtException', e => console.log('[server] uventet fejl:', String((e && e.stack) || e)));
process.on('unhandledRejection', e => console.log('[server] uventet afvisning:', String((e && e.stack) || e)));

/* A second launch must die, not linger.
 *
 * The uncaughtException handler above (added to keep a bad request from
 * killing the recorder mid-match) also swallows EADDRINUSE from listen — so a
 * second instance kept running WITHOUT the port: invisible to the board, but
 * with its own feed to the game, racing the real server on profile.json and
 * the match archive. That cost real debriefs on 2026-07-27. Handle the bind
 * error explicitly and exit before the generic handler can rescue us.
 */
server.on('error', e => {
  if (e && e.code === 'EADDRINUSE'){
    console.log('[server] port ' + PORT + ' er optaget — RL Tracker koerer allerede. Lukker denne instans.');
    process.exit(1);
  }
  // any other bind error (EACCES, EADDRNOTAVAIL) used to be rethrown into the
  // uncaughtException handler above, which kept the process alive without a
  // port: a recorder nobody can reach. Say why, then exit.
  console.log('[server] kunne ikke lytte paa ' + HOST + ':' + PORT + ': ' + String((e && e.code) || e));
  process.exit(1);
});

/* Browser-aabneren pr. platform (6/9): win32 `cmd /c start`, macOS `open`,
 * ellers `xdg-open`. Ren funktion — testes i linux-paths.test.js. */
function browserOpenCommand(platform, url){
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

server.listen(PORT, HOST, () => {
  console.log('RL Live Tracker server');
  console.log('  Local:   http://localhost:' + PORT + '/');
  if (LAN_OPEN) console.log('  Network: http://<this-machine-ip>:' + PORT + '/   (LAN-adgang slået til via HOST)');
  else console.log('  Network: slået fra (kun denne maskine). Sæt HOST=0.0.0.0 for LAN-boards.');
  /* Onboarding-loven (15/8, walkthrough-fund 2): dobbeltklik på EXE'EN er den
   * indgang, en fremmed faktisk vælger — så skal exe'en også selv åbne UI'et.
   * Launcherne/deploy sætter RL_NO_OPEN=1 og beholder egen åbne-logik; dev
   * (RL_ROOT) åbner aldrig — en dev-genstart skal ikke stjæle fokus. */
  if (process.env.RL_NO_OPEN !== '1' && !process.env.RL_ROOT){
    console.log('');
    console.log('  Boardet åbner nu i din browser. Luk DETTE vindue for at stoppe trackeren.');
    console.log('  (The board opens in your browser. Close THIS window to stop the tracker.)');
    try{
      const o = browserOpenCommand(process.platform, 'http://localhost:' + PORT + '/');
      const child = require('child_process').spawn(o.cmd, o.args, { detached: true, stdio: 'ignore', windowsHide: true });
      /* ENOENT (ingen xdg-open, ingen cmd) kommer som asynkron 'error' — uden
       * lytter vaelter den hele serveren trods try/catch (maalt 6/9, R3-G1). */
      child.on('error', () => {});
      child.unref();
    }catch{}
  }
});
