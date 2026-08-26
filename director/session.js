/* RL Director — after-session report engine.
 * Groups consecutive valid matches into a play session and, when the session
 * ends (game closed, IDLE_REPORT_MS idle, or a stale session found at startup),
 * writes a deterministic Danish report (JSON + self-contained dark HTML)
 * to <root>/reports/ and broadcasts a short summary over SSE.
 *
 * Contract: every number quoted in the report is measured — either in
 * tonight's matches or in the player's own EWMA baselines (profile.json).
 * No invented benchmarks; training packs come from the curated bank (packs.js)
 * plus at most one variety pack from pack-catalog-variety.json — codes are
 * lifted verbatim from those files, never generated.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./metrics');
const { RULES } = require('./rules');
const persona = require('./persona');
const bank = require('./packs');
const EN = () => M.currentLanguage && M.currentLanguage() === 'en';
const store = require('./store');

const SESSION_GAP_MS = 45 * 60e3;   // silence between match end and next start that splits sessions
const IDLE_REPORT_MS = SESSION_GAP_MS;  // must equal the gap rule, or tick() splits sessions the gap rule keeps whole
const MIN_MATCHES = 2;              // fewer than this: the session is dropped silently
const PACK_HISTORY_CAP = 20;
const DEFAULT_PID = 'Epic|b92ea9ec6fda4deda90ffe8a15a90054|0';

/* Variety catalog (13/8-2026). The player reported he had stopped opening the
 * suggested packs: packHistory held the same three codes for twenty reports —
 * the same habituation the advice lines went through on 30/7. The catalog is
 * curated data (pack-catalog-variety.json, codes verbatim, never invented) and
 * its own rule rides along: at most ONE variety pack per report, never instead
 * of the primary measured coupling. Loaded in init with its own try/catch —
 * the recorder shares this process, and a missing or hand-broken catalog must
 * degrade to "no variety pack", never to a crash. */
let VARIETY = [];
const PACK_CODE_RX = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/i;
function loadVariety(){
  VARIETY = [];
  try{
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'pack-catalog-variety.json'), 'utf8'));
    for (const p of (raw && raw.packs) || []){
      // a malformed code is worse than a missing pack: it would be shown, typed
      // in and fail in-game — exactly the invented-code failure the bank forbids
      if (!p || typeof p.name !== 'string' || typeof p.code !== 'string' || !PACK_CODE_RX.test(p.code)) continue;
      VARIETY.push({ name: p.name, code: p.code, what: String(p.what || ''), coupling: String(p.coupling || '') });
    }
  }catch(e){ log('[session] afvekslings-katalog kunne ikke læses (rotation kører videre uden): ' + (e.message || e)); }
}

let ROOT = null, log = () => {}, broadcast = () => {};
let trackedPid = DEFAULT_PID;
let state = null;
let matchInProgressAt = 0;   // set on MatchCreated; keeps tick() from closing mid-match

function statePath(){ return path.join(ROOT, 'session-state.json'); }
function defaultState(){ return { schema: 'session-state/1', open: null, packHistory: [], lastReport: null }; }
/* Where this store's reports are served from. The owner's live at /reports/;
 * a guest's under /guests/<id>/reports/ (see rehome). */
let URL_BASE = '/reports/';
/* Guest on a seeded standard (seed.js): the report's sentences say "standarden"
 * where the owner's say "din normal". Same relabel list as director.js —
 * numbers untouched, only the word for what they are judged against. */
let SEEDED = false;
const RELABEL = [
  [/din egen normal/gi, 'standarden'], [/din normal/gi, 'standarden'], [/\bnormalen\b/g, 'standarden'], [/\bnormalt\b/g, 'standard'],
  [/end du plejer/g, 'end standarden'], [/your own normal/gi, 'the standard'], [/your normal/gi, 'the standard'], [/than usual/gi, 'than the standard'], [/\bnormally\b/gi, 'standard']
];
function relabel(t){ if (typeof t !== 'string') return t; for (const [rx, to] of RELABEL) t = t.replace(rx, to); return t; }
function relabelReport(r){
  r.headline = relabel(r.headline);
  if (Array.isArray(r.lines)) r.lines = r.lines.map(relabel);
  for (const x of r.notes || []){ x.text = relabel(x.text); x.advice = relabel(x.advice); }
  for (const x of r.missions || []) x.text = relabel(x.text);
  for (const x of r.packs || []) x.reason = relabel(x.reason);
  if (r.tilt && r.tilt.stopText) r.tilt.stopText = relabel(r.tilt.stopText);
  r.seeded = true;
  return r;
}

/* Guest mode (19/8-2026): point the session engine at another data directory
 * — its own session-state.json and reports/ — and at another tracked player.
 * The current store is saved first; an open session in it stays open on disk
 * and is closed by the idle rule when that store is loaded again. Nothing of
 * the previous player's evening leaks into the next player's report, and the
 * owner's weekly (which reads ROOT/reports) never sees a guest's sessions. */
function rehome(dir, pid, urlBase, opts){
  if (state) save();
  ROOT = dir;
  URL_BASE = urlBase || '/reports/';
  SEEDED = !!(opts && opts.seeded);
  trackedPid = pid || trackedPid;
  matchInProgressAt = 0;
  state = store.readJSON(statePath(), defaultState);
  if (state.schema !== 'session-state/1') state = defaultState();
  if (state.open && Date.now() - lastActivity(state.open) >= SESSION_GAP_MS) finish('rehome');
  return module.exports;
}

/* Crash-safe persist: write aside, then atomically swap in. */
function save(){ store.writeJSON(statePath(), state); }

function lastActivity(open){
  const last = open.matches[open.matches.length - 1];
  const lastMatch = Date.parse((last && last.endedAt) || open.startedAt) || 0;
  return Math.max(lastMatch, matchInProgressAt);   // a running match counts as activity
}

/* Called on MatchCreated so the idle watchdog can never fire mid-match
 * (a match can run well past the idle window after a long queue). */
function onMatchStart(){ matchInProgressAt = Date.now(); }

function init(opts){
  ROOT = opts.root;
  log = opts.log || log;
  broadcast = opts.broadcast || broadcast;
  loadVariety();
  state = store.readJSON(statePath(), defaultState);
  if (state.schema !== 'session-state/1') state = defaultState();
  try{
    const prof = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8'));
    if (prof && prof.trackedPid) trackedPid = prof.trackedPid;
  }catch{}
  // a session left open across a restart is reported once it has gone stale
  if (state.open && Date.now() - lastActivity(state.open) >= SESSION_GAP_MS) finish('init');
  return module.exports;
}

/* Called by director.onDigest after every valid match (collecting included). */
function onMatch(ev){
  if (!state) return;
  const digest = ev.digest || {}, debrief = ev.debrief || {};
  const startedAt = digest.startedAt || new Date().toISOString();
  const endedAt = digest.endedAt || startedAt;
  if (state.open && Date.parse(startedAt) - lastActivity(state.open) >= SESSION_GAP_MS)
    finish('gap');                                 // long silence: the previous session ends here
  if (!state.open) state.open = { startedAt, matches: [] };

  const me = (digest.players || []).find(p => p.pid === trackedPid) || {};
  // Keep the PRE-match baseline the debrief was judged against. Reading
  // profile.json at report time would compare the session with a baseline
  // the session has already been folded into (EWMA), understating every delta.
  const metrics = {};
  for (const s of debrief.metrics || [])
    if (s && Number.isFinite(s.value))
      metrics[s.id] = { v: s.value,
        b: s.baseline && Number.isFinite(s.baseline.mean) ? s.baseline.mean : null,
        bn: s.baseline && Number.isFinite(s.baseline.n) ? s.baseline.n : 0 };   // baseline maturity
  const match = debrief.match || {};
  state.open.matches.push({
    file: ev.file || null,
    // A private lobby stays in the session (it happened, and it is shown) but
    // is kept out of every number below — see buildReport/current. matchType
    // is what the row is called on the page.
    private: !!match.private,
    matchType: match.private ? (match.matchType || null) : null,
    // the BUCKET the debrief measured against ('3v3', '3v3 Tournament', …) —
    // cards and trends below group on it; size/kind are what the game said
    // the match was (director.onDigest stamps them from metrics.bucketOf, 17/8)
    playlist: match.playlist || digest.playlist || 'other',
    size: match.playlistSize || null, kind: match.private ? 'private' : (match.matchKind || null),
    score: Array.isArray(match.score) ? match.score : [0, 0],
    myTeam: typeof match.myTeam === 'number' ? match.myTeam : (typeof me.team === 'number' ? me.team : 0),
    result: match.result || null,
    startedAt, endedAt,
    metrics,
    me: { goals: me.goals | 0, assists: me.assists | 0, saves: me.saves | 0, shots: me.shots | 0, touches: me.touches | 0 },
    // goal events kept for tilt timing: clock counts DOWN from 300, up in OT
    goals: (digest.goals || []).map(g => ({
      clock: typeof g.clock === 'number' ? g.clock : null, ot: !!g.ot, own: g.team === me.team
    }))
  });
  save();
  // Pause-signalet dømmes mellem kampene — dvs. præcis her, ved kampens slut.
  try{ pauseCheck(startedAt); }catch(e){ log('[pause] fejl (fortsætter): ' + (e.message || e)); }
}

/* Idle watchdog (server calls this every minute). */
function tick(){
  if (!state || !state.open) return null;
  if (Date.now() - lastActivity(state.open) >= IDLE_REPORT_MS) return finish('idle');
  return null;
}

/* ---- PAUSE-SIGNALET (25/8-2026, brugerens idé fra 10/8) ----
 * Den bløde bror til rapportens stop-signal — LIVE, mellem kampene, ikke
 * først når aftenen er slut. To niveauer:
 *   pause: 3 nederlag i træk, ELLER 2 i træk med touchkraft-drift under -5 %
 *   stop:  rapportens egen tærskel uændret (drift < -10 % og 2 nederlag i træk)
 * Kun målte belæg vises — aldrig en følelse. Habituering (10/8-kravet): et
 * pauseforslag der ignoreres 3 gange i træk, TIER — indtil ét bliver fulgt.
 * "Fulgt" = mindst 5 minutter til næste kampstart, eller at aftenen slutter
 * dér (den bedste udgang). "Ignoreret" = næste kamp startede før. Udfaldene
 * tælles i reach (pause_shown/followed/ignored + stop_shown), så M5 kan se om
 * signalet overhovedet ændrer adfærd. Stop-niveauet tier aldrig.
 * Begrundelsen er W34: tre sessioner endte med "overvej at stoppe" skrevet
 * BAGEFTER — 0W-7L-fredagen havde fortjent et skilt UNDERVEJS. */
let reach = null;
try{ reach = require('./reach'); }catch{}
const PAUSE_FOLLOW_MS = 5 * 60 * 1000;
const PAUSE_MUTE_AFTER = 3;

function pauseEval(rows){
  const ms = rows.filter(r => !r.private);
  if (ms.length < 3) return null;
  const pavg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const h1 = ms.slice(0, Math.floor(ms.length / 2)), h2 = ms.slice(Math.ceil(ms.length / 2));
  const hp1 = h1.map(r => mval(r.metrics && r.metrics.hit_power_avg)).filter(Number.isFinite);
  const hp2 = h2.map(r => mval(r.metrics && r.metrics.hit_power_avg)).filter(Number.isFinite);
  const drift = hp1.length && hp2.length && pavg(hp1) > 1e-9
    ? (pavg(hp2) - pavg(hp1)) / pavg(hp1) : null;
  let lossStreak = 0;
  for (let i = ms.length - 1; i >= 0 && ms[i].result === 'L'; i--) lossStreak++;
  let earlyConceded = 0;
  for (const r of ms) for (const g of r.goals || [])
    if (!g.own && !g.ot && g.clock !== null && g.clock > 240) earlyConceded++;
  const stop = drift !== null && drift < -0.10 && lossStreak >= 2;
  const pause = !stop && (lossStreak >= 3 || (lossStreak >= 2 && drift !== null && drift < -0.05));
  if (!stop && !pause) return null;
  return { level: stop ? 'stop' : 'pause', drift, lossStreak, earlyConceded, n: ms.length,
           sequence: ms.map(r => r.result || '?').join(' ') };
}

/* Ren beslutning — testbar uden disk/broadcast. ps = {ignoredStreak, pending};
 * fired = open.pauseFired; thisStartIso = den netop AFSLUTTEDE kamps starttid,
 * som dømmer et evt. ventende forslag (fulgt/ignoreret) FØR nyt kan fyres. */
function pauseStep(rows, ps, fired, thisStartIso){
  let resolve = null;
  if (ps.pending && thisStartIso){
    const gap = Date.parse(thisStartIso) - Date.parse(ps.pending.at);
    resolve = Number.isFinite(gap) && gap >= PAUSE_FOLLOW_MS ? 'followed' : 'ignored';
  }
  const streak = resolve === 'followed' ? 0
    : resolve === 'ignored' ? ps.ignoredStreak + 1 : ps.ignoredStreak;
  const ev = pauseEval(rows);
  let fire = null, muted = false;
  if (ev){
    if (ev.level === 'stop'){ if (!fired.stop) fire = ev; }
    else if (!fired.pause){
      if (streak >= PAUSE_MUTE_AFTER) muted = true;
      else fire = ev;
    }
  }
  return { resolve, streak, fire, muted };
}

function pauseTexts(ev){
  const en = EN();
  const evidence = [];
  evidence.push(en ? ev.lossStreak + ' losses in a row' : ev.lossStreak + ' nederlag i træk');
  if (ev.drift !== null && ev.drift < 0){
    const p = Math.abs(Math.round(ev.drift * 100));
    evidence.push(en ? 'touch power down ' + p + '% through the evening'
                     : 'touchkraften er faldet ' + p + ' % gennem aftenen');
  }
  if (ev.earlyConceded >= 2)
    evidence.push(en ? ev.earlyConceded + ' goals conceded in the first minute'
                     : ev.earlyConceded + ' mål ind i kampens første minut');
  const text = ev.level === 'stop'
    ? (en ? 'Consider stopping for tonight — the measurements point down. A break costs less than a tilt streak.'
          : 'Overvej at stoppe for i aften — målingerne peger nedad. En pause koster mindre end en tilt-stribe.')
    : (en ? 'Do something else for 5 minutes — the measurements are behind this.'
          : 'Lav lige noget andet i 5 minutter — målingerne står bag.');
  return { text, evidence };
}

function pauseCheck(justEndedStartIso){
  if (!state || !state.open) return;
  if (!state.pause || typeof state.pause !== 'object') state.pause = { ignoredStreak: 0, pending: null };
  const open = state.open;
  if (!open.pauseFired || typeof open.pauseFired !== 'object') open.pauseFired = {};
  const r = pauseStep(open.matches, state.pause, open.pauseFired, justEndedStartIso);
  if (r.resolve){
    state.pause.pending = null;
    state.pause.ignoredStreak = r.streak;
    try{ if (reach && reach.hit) reach.hit(r.resolve === 'followed' ? 'pause_followed' : 'pause_ignored'); }catch{}
    if (r.resolve === 'ignored' && r.streak === PAUSE_MUTE_AFTER)
      log('[pause] forslag ignoreret ' + r.streak + ' gange i træk — den bløde pause tier, indtil én bliver fulgt');
  }
  if (r.fire){
    const t = pauseTexts(r.fire);
    const at = new Date().toISOString();
    open.pauseFired[r.fire.level] = at;
    state.pause.pending = { at, level: r.fire.level };
    try{ if (reach && reach.hit) reach.hit(r.fire.level === 'stop' ? 'stop_shown' : 'pause_shown'); }catch{}
    try{ broadcast({ Event: '_pause', Data: { level: r.fire.level, at, text: t.text,
      evidence: t.evidence, sequence: r.fire.sequence } }); }catch{}
    log('[pause] ' + r.fire.level + '-signal: ' + t.evidence.join(' · '));
  }
  if (r.resolve || r.fire) save();
}

/* Metric value accessor: entries are {v, b} since the baseline fix, but
 * sessions written by the previous build stored the bare number. */
function mval(m){ return m === null || m === undefined ? null : (typeof m === 'object' ? m.v : m); }
function mbase(m){ return m && typeof m === 'object' && Number.isFinite(m.b) ? m.b : null; }
function mbaseN(m){ return m && typeof m === 'object' && Number.isFinite(m.bn) ? m.bn : 0; }

/* Recorder TCP closed after a real connection = the game was shut down. */
function onGameDisconnect(){
  if (!state || !state.open) return null;
  return finish('disconnect');
}

function latest(){ return (state && state.lastReport) || null; }

/* The session IN PROGRESS — a light preview for the main page's Session panel.
 * Same contract as the report: every number is either measured tonight or the
 * player's own pre-session normal (the {v,b,bn} stored per match). Never
 * written to disk — it would be a report that is wrong one match later. */
function current(){
  if (!state || !state.open || !state.open.matches.length) return null;
  const open = state.open;
  const wl = { w: 0, l: 0, u: 0 };
  let goals = 0, shots = 0, assists = 0, saves = 0, touches = 0, privateN = 0;
  const acc = {};                        // playlist -> id -> {vals, b, bn} (first-seen normal)
  for (const m of open.matches){
    if (m.private){ privateN++; continue; }          // shown as a row, never as a number
    if (m.result === 'W') wl.w++; else if (m.result === 'L') wl.l++; else wl.u++;
    goals += m.me.goals | 0; shots += m.me.shots | 0; assists += m.me.assists | 0;
    saves += m.me.saves | 0; touches += m.me.touches | 0;
    const byPl = acc[m.playlist] || (acc[m.playlist] = {});
    for (const id of Object.keys(m.metrics || {})){
      const v = mval(m.metrics[id]);
      if (!Number.isFinite(v) || !M.DEFS[id]) continue;
      const a = byPl[id] || (byPl[id] = { vals: [], b: null, bn: 0 });
      a.vals.push(v);
      if (a.b === null && mbase(m.metrics[id]) !== null){
        a.b = mbase(m.metrics[id]); a.bn = mbaseN(m.metrics[id]);
      }
    }
  }
  // Trends against the pre-session normal — mature baselines only, the same
  // gate the debrief itself judges behind (MIN_BASELINE).
  const trends = [];
  for (const pl of Object.keys(acc)) for (const id of Object.keys(acc[pl])){
    const a = acc[pl][id];
    if (a.b === null || a.bn < M.MIN_BASELINE || !M.ranked(id)) continue;
    const sAvg = a.vals.reduce((x, y) => x + y, 0) / a.vals.length;
    const deltaPct = Math.abs(a.b) > 1e-9 ? (sAvg - a.b) / Math.abs(a.b) : null;
    if (deltaPct === null) continue;
    const goodness = M.DEFS[id].direction * deltaPct;
    // unit in the label (19/8): '(m)'/'(km/t)' follows every quoted value
    trends.push({ id, playlist: pl, label: M.labelWithUnit(id), n: a.vals.length,
      valueText: M.fmt(id, sAvg), normalText: M.fmt(id, a.b), unit: M.unitFor(id),
      deltaPct, better: goodness > 0, goodness });
  }
  trends.sort((x, y) => Math.abs(y.deltaPct) - Math.abs(x.deltaPct));
  const last = open.matches[open.matches.length - 1];
  return {
    schema: 'session-now/1', startedAt: open.startedAt,
    // `matches` is the COUNTED number; private lobbies are reported beside it
    matches: open.matches.length - privateN, privateMatches: privateN,
    wl, goals, shots, assists, saves, touches,
    conversion: shots ? goals / shots : null,
    trends: trends.slice(0, 8),
    lastMatch: last ? { playlist: last.playlist, result: last.result,
      myScore: (last.myTeam === 1 ? [last.score[1], last.score[0]] : last.score).join('–'),
      endedAt: last.endedAt, private: !!last.private, matchType: last.matchType || null } : null
  };
}

/* Close the open session; report if it holds enough matches, drop silently otherwise. */
function finish(reason){
  // Pause-signalet: sluttede aftenen uden en ny kamp efter et forslag, blev
  // forslaget fulgt — den bedste udgang, og den nulstiller habitueringen.
  if (state && state.pause && state.pause.pending){
    state.pause.pending = null;
    state.pause.ignoredStreak = 0;
    try{ if (reach && reach.hit) reach.hit('pause_followed'); }catch{}
  }
  const open = state.open;
  state.open = null;
  // counted matches decide whether there is a session to report on — an
  // evening of private lobbies alone has nothing measured to say
  if (!open || open.matches.filter(m => !m.private).length < MIN_MATCHES){ save(); return null; }
  let report;
  try{
    report = buildReport(open, reason);
    if (SEEDED) relabelReport(report);
    const dir = path.join(ROOT, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    // atomic: the .html is served over HTTP and may be fetched mid-write
    store.writeJSON(path.join(dir, report.name + '.json'), report, 1);
    store.writeText(path.join(dir, report.name + '.html'), SEEDED ? relabel(renderHTML(report)) : renderHTML(report));
    state.lastReport = report;
    if (report.packs.length){
      // `pack` keeps meaning the primary (older entries carry only that);
      // `variety`/`shown` are additive and feed the two-reports-in-a-row rule
      const v = report.packs.find(p => p.variety);
      state.packHistory.push({ pack: report.packs[0].code, at: report.at,
        variety: v ? v.code : null, shown: report.packs.map(p => p.code) });
      state.packHistory = state.packHistory.slice(-PACK_HISTORY_CAP);
    }
  }catch(e){
    log('[session] rapport-fejl: ' + (e.message || e));
    save();
    return null;
  }
  save();
  log('[session] rapport klar (' + reason + '): ' + report.name + ' — ' + report.headline);
  try{
    broadcast({ Event: '_session', Data: {
      schema: 'session/1', at: report.at,
      summary: { matches: report.matches.length, wl: report.wl.w + '-' + report.wl.l, headline: report.headline },
      lines: report.lines,
      url: URL_BASE + report.name + '.html'
    } });
  }catch(e){ log('[session] broadcast-fejl: ' + (e.message || e)); }
  return report;
}

/* ---------------- report assembly (pure data, no I/O beyond profile read) ---------------- */

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pctS = x => (x >= 0 ? '+' : '-') + Math.abs(Math.round(x * 100)) + '%';
const absPct = x => Math.abs(Math.round(x * 100)) + '%';   // where the sentence already says "faldt"

function localStamp(d){
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/* The variety pack (13/8-2026). Pool = pack-catalog-variety.json; the choice is
 * deterministic, so a replay rebuilds the same report: least-recently-shown
 * first (never-shown before that), catalog order as the tie-break — and never
 * a pack that was in the PREVIOUS report, which is exactly the two-reports-in-
 * a-row repetition the player stopped reading past.
 *
 * The catalog's `coupling` field decides what the reason line may CLAIM: if it
 * names a metric that measurably was weak tonight, the reason says so with
 * tonight's numbers; an aerial pack is the player's own stated goal (we measure
 * no air data — same honesty rule as packs.js); everything else declares itself
 * plain variety. The declaration is the point: a variety pack dressed up as a
 * measured need would break the report's contract. */
function pickVariety(chosen, prevShown, ranked, earlyConceded){
  if (!VARIETY.length) return null;
  const en = EN();
  const taken = new Set(chosen.map(p => p.code).concat(prevShown));
  const lastSeen = {};                             // code -> newest packHistory index it appeared in
  state.packHistory.forEach((h, i) => {
    for (const c of (Array.isArray(h.shown) ? h.shown : [h.pack]).concat(h.variety || []))
      if (c) lastSeen[c] = i;
  });
  const weakBy = {};                               // metric id -> its worst weak trend tonight
  for (const t of ranked) if (t.goodness < 0 && !weakBy[t.id]) weakBy[t.id] = t;
  const cands = [];
  VARIETY.forEach((p, idx) => {
    if (taken.has(p.code)) return;
    const metricId = Object.keys(weakBy).find(id => p.coupling.includes(id)) || null;
    const early = !metricId && earlyConceded >= 1 && p.coupling.includes('earlyConceded');
    cands.push({ p, idx, metricId, hook: !!(metricId || early), early,
      seen: Object.prototype.hasOwnProperty.call(lastSeen, p.code) ? lastSeen[p.code] : -1 });
  });
  if (!cands.length) return null;
  cands.sort((a, b) => (a.seen - b.seen) || ((b.hook ? 1 : 0) - (a.hook ? 1 : 0)) || (a.idx - b.idx));
  const c = cands[0], p = c.p;
  let reason;
  if (c.metricId){
    const t = weakBy[c.metricId];
    reason = en
      ? 'Variety, same measured need as tonight — ' + t.label + ' ' + M.fmt(t.id, t.sessionAvg)
        + ' against your normal ' + M.fmt(t.id, t.baselineAvg) + ' in ' + t.playlist + ': ' + p.what + '.'
      : 'Afveksling, samme målte behov som i aften — ' + t.label + ' ' + M.fmt(t.id, t.sessionAvg)
        + ' mod normalt ' + M.fmt(t.id, t.baselineAvg) + ' i ' + t.playlist + ': ' + p.what + '.';
  } else if (c.early){
    reason = en
      ? 'Variety, same measured need as tonight — ' + earlyConceded + ' goal' + (earlyConceded > 1 ? 's' : '')
        + ' conceded in the first minute of a match: ' + p.what + '.'
      : 'Afveksling, samme målte behov som i aften — ' + earlyConceded
        + ' mål indkasseret i kampens første minut: ' + p.what + '.';
  } else if (p.coupling.includes('aerial')){
    reason = en
      ? 'Variety for your own aerial goal — no measurement behind it (the feed has no air data): ' + p.what + '.'
      : 'Afveksling til dit eget aerial-mål — ingen måling bag (feedet har ingen luftdata): ' + p.what + '.';
  } else {
    reason = en
      ? 'Variety, no measured coupling tonight: ' + p.what + '.'
      : 'Afveksling, ingen målt kobling i aften: ' + p.what + '.';
  }
  return { name: p.name, code: p.code, reason, variety: true };
}

function buildReport(open, reason){
  // `all` is the evening as it happened (timing, the match list); `ms` is what
  // is MEASURED. Private lobbies live in the first and never in the second.
  const all = open.matches;
  const ms = all.filter(r => !r.private);
  const privateMs = all.filter(r => r.private);
  const now = new Date();
  // named after the session's own start (a restart-triggered report can run days later)
  const base = 'session-' + localStamp(new Date(Date.parse(all[0].startedAt) || now));
  let name = base;
  try{                                            // never overwrite an existing report silently
    const dir = path.join(ROOT, 'reports');
    // suffix the base, never rewrite it: the stamp ends in -HHMM, so a
    // /(-\d+)?$/ replace ate the time itself (…-25-1939 -> …-25-2)
    // check BOTH extensions: a kept .html whose .json was deleted would
    // otherwise be overwritten without warning
    const taken = n => fs.existsSync(path.join(dir, n + '.json')) || fs.existsSync(path.join(dir, n + '.html'));
    for (let i = 2; taken(name); i++) name = base + '-' + i;
  }catch{}

  let profile = null;
  try{ profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8')); }catch{}

  // --- W/L + per-playlist summary (player's own goals/shots/conversion)
  const wl = { w: 0, l: 0, u: 0 };
  const playlists = {};
  for (const r of ms){
    if (r.result === 'W') wl.w++; else if (r.result === 'L') wl.l++; else wl.u++;
    const pl = playlists[r.playlist] || (playlists[r.playlist] = { w: 0, l: 0, u: 0, goals: 0, shots: 0, matches: [] });
    if (r.result === 'W') pl.w++; else if (r.result === 'L') pl.l++; else pl.u++;
    pl.goals += r.me.goals; pl.shots += r.me.shots;
    pl.matches.push({ startedAt: r.startedAt, result: r.result, score: r.score,
      myTeam: typeof r.myTeam === 'number' ? r.myTeam : 0, me: r.me });
  }
  for (const k of Object.keys(playlists))
    playlists[k].conversion = playlists[k].shots ? playlists[k].goals / playlists[k].shots : null;
  const totGoals = ms.reduce((a, r) => a + r.me.goals, 0);
  const totShots = ms.reduce((a, r) => a + r.me.shots, 0);
  const totTouches = ms.reduce((a, r) => a + r.me.touches, 0);
  const conv = totShots ? totGoals / totShots : null;

  // --- metric trends, PER PLAYLIST. Mixing them averages 1v1 and 2v2 into a
  // "normal" that is neither: the player's own off_touch_share normals differ
  // by 13 points across playlists, and a blended target can be unreachable in
  // both. Baselines are the pre-fold ones each match was judged against.
  const accum = {};
  for (const r of ms){
    const pl = r.playlist || 'other';
    const byPl = accum[pl] || (accum[pl] = {});
    for (const id of Object.keys(r.metrics)){
      if (!M.DEFS[id]) continue;
      const v = mval(r.metrics[id]);
      if (!Number.isFinite(v)) continue;
      const a = byPl[id] || (byPl[id] = { vals: [], bases: [], baseNs: [] });
      a.vals.push(v);
      // no baseline in the debrief = the metric's very first match. Falling back
      // to profile.json here would read a baseline this session is already
      // folded into — leave it out instead.
      const b = mbase(r.metrics[id]);
      if (b !== null){ a.bases.push(b); a.baseNs.push(mbaseN(r.metrics[id])); }
    }
  }
  const trends = [];
  for (const pl of Object.keys(accum)) for (const id of Object.keys(M.DEFS)){
    const a = accum[pl][id];
    if (!a || !a.vals.length) continue;
    const sessionAvg = avg(a.vals);
    const baselineAvg = a.bases.length ? avg(a.bases) : null;
    // Baseline maturity = how many matches the normal rests on NOW (the last
    // match's baseline, which is the largest since it only grows). Downstream
    // (missions, focus) must not aim at a normal built on a handful of matches.
    const baselineN = a.baseNs.length ? Math.max(...a.baseNs) : 0;
    // noPct metrics (signed counts near zero) compare in absolute terms only —
    // a percentage against a ~0 baseline is noise, not a finding.
    const deltaPct = baselineAvg !== null && M.ranked(id) && Math.abs(baselineAvg) > 1e-9
      ? (sessionAvg - baselineAvg) / Math.abs(baselineAvg) : null;
    // unit in the label (19/8): '(m)'/'(km/t)' follows every quoted value
    trends.push({ id, playlist: pl, label: M.labelWithUnit(id), direction: M.DEFS[id].direction,
      n: a.vals.length, baselineN, mature: baselineN >= M.MIN_BASELINE,
      sessionAvg, baselineAvg, deltaPct,
      delta: baselineAvg === null ? null : sessionAvg - baselineAvg,
      goodness: deltaPct === null ? null : deltaPct * M.DEFS[id].direction });
  }
  // Only MATURE trends may drive advice: an immature baseline is a guess, and
  // the per-match debrief already refuses to judge below MIN_BASELINE.
  const ranked = trends.filter(t => t.goodness !== null && t.mature).sort((a, b) => a.goodness - b.goodness);
  const key = t => t.playlist + '|' + t.id;                    // trends are per playlist now
  // sign matters: only metrics actually below/above normal may be tagged
  const weakest = ranked.filter(t => t.goodness < 0).slice(0, 2).map(key);
  const strongest = ranked.filter(t => t.goodness > 0).slice(-2).reverse().map(key);
  const byKey = {}; for (const t of trends) byKey[key(t)] = t;

  // --- tilt analysis: measured patterns only, phrased as measurements
  const sequence = ms.map(r => r.result || '?').join(' ');
  const h1 = ms.slice(0, Math.floor(ms.length / 2)), h2 = ms.slice(Math.ceil(ms.length / 2));
  const hp1 = h1.map(r => mval(r.metrics.hit_power_avg)).filter(Number.isFinite);
  const hp2 = h2.map(r => mval(r.metrics.hit_power_avg)).filter(Number.isFinite);
  const drift = hp1.length && hp2.length
    ? { firstAvg: avg(hp1), secondAvg: avg(hp2),
        pct: avg(hp1) > 1e-9 ? (avg(hp2) - avg(hp1)) / avg(hp1) : 0 }
    : null;
  let earlyConceded = 0, lateOwn = 0;
  for (const r of ms) for (const g of r.goals || []){
    if (!g.own && !g.ot && g.clock !== null && g.clock > 240) earlyConceded++;   // conceded in the match's first minute
    if (g.own && (g.ot || (g.clock !== null && g.clock < 60))) lateOwn++;        // scored in the final minute or overtime
  }
  let lossStreak = 0;
  for (let i = ms.length - 1; i >= 0 && ms[i].result === 'L'; i--) lossStreak++;
  const stop = !!(drift && drift.pct < -0.10 && lossStreak >= 2);
  const tilt = { sequence, drift, earlyConceded, lateOwn, lossStreak, stop,
    stopText: EN()
      ? (stop
        ? 'Consider stopping for tonight: touch power fell ' + absPct(drift.pct) + ' from the first half of the session to the last, and the last ' + lossStreak + ' matches ended in losses. The measurements point down — a break costs less than a tilt streak.'
        : 'No stop signal in the measurements' + (drift ? ' (touch power drift ' + pctS(drift.pct) + (lossStreak >= 2 ? ', ' + lossStreak + ' losses in a row' : '') + ')' : '') + '.')
      : (stop
        ? 'Overvej at stoppe for i aften: touchkraften faldt ' + absPct(drift.pct) + ' fra sessionens første til sidste halvdel, og de sidste ' + lossStreak + ' kampe endte i nederlag. Målingerne peger nedad — en pause koster mindre end en tilt-stribe.'
        : 'Intet stop-signal i målingerne' + (drift ? ' (touchkraft-drift ' + pctS(drift.pct) + (lossStreak >= 2 ? ', ' + lossStreak + ' nederlag i træk' : '') + ')' : '') + '.') };

  // --- missions: measurable targets from the weakest baselined metrics
  const missions = [];
  for (const t of ranked.filter(t => t.goodness < 0).slice(0, 3))
    missions.push({ id: t.id, playlist: t.playlist,
      text: EN()
        ? cap(t.label) + ' ' + (t.direction > 0 ? '≥' : '≤') + ' ' +
          M.fmt(t.id, t.baselineAvg) + ' in ' + t.playlist + ' (today ' + M.fmt(t.id, t.sessionAvg) + ')'
        : cap(t.label) + ' ' + (t.direction > 0 ? '≥' : '≤') + ' ' +
          M.fmt(t.id, t.baselineAvg) + ' i ' + t.playlist + ' (i dag ' + M.fmt(t.id, t.sessionAvg) + ')' });
  if (missions.length < 2)
    for (const t of ranked.filter(t => t.goodness >= 0).slice(0, 2 - missions.length))
      missions.push({ id: t.id, playlist: t.playlist,
        text: EN()
          ? cap(t.label) + ' in ' + t.playlist + ': stay ' + (t.direction > 0 ? 'above' : 'below') +
            ' your normal ' + M.fmt(t.id, t.baselineAvg) + ' again (today ' + M.fmt(t.id, t.sessionAvg) + ')'
          : cap(t.label) + ' i ' + t.playlist + ': hold dig ' + (t.direction > 0 ? 'over' : 'under') +
            ' din normal ' + M.fmt(t.id, t.baselineAvg) + ' igen (i dag ' + M.fmt(t.id, t.sessionAvg) + ')' });

  // --- training packs: measured couplings from the curated bank (packs.js),
  // worst weakness first. The four hardcoded packs this section carried since
  // M1 are retired 13/8-2026: packHistory showed the same three codes twenty
  // reports running, and the player had stopped opening them (the advice-line
  // habituation again). The bank got wider, the grounding did not get looser —
  // every candidate below is still justified with tonight's measured numbers.
  const cands = [];
  const en = EN();
  for (const t of ranked){
    if (t.goodness >= 0) continue;
    for (const p of bank.forMetric(t.id)){
      if (cands.some(c => c.code === p.code)) continue;
      cands.push({ ...p, score: -t.goodness,
        reason: en
          ? cap(t.label) + ' in ' + t.playlist + ': ' + M.fmt(t.id, t.sessionAvg) + ' on average tonight against your normal '
            + M.fmt(t.id, t.baselineAvg) + ' (' + pctS(t.deltaPct) + ') — ' + p.what + '.'
          : cap(t.label) + ' i ' + t.playlist + ': ' + M.fmt(t.id, t.sessionAvg) + ' i snit i aften mod normalt '
            + M.fmt(t.id, t.baselineAvg) + ' (' + pctS(t.deltaPct) + ') — ' + p.what + '.' });
    }
  }
  if (earlyConceded >= 1)
    for (const p of bank.forSignal('earlyConceded')){
      if (cands.some(c => c.code === p.code)) continue;
      cands.push({ ...p, score: earlyConceded * 0.05,
        reason: en
          ? earlyConceded + ' goal' + (earlyConceded > 1 ? 's' : '') + ' conceded in the first minute of a match (cold start) — ' + p.what + '.'
          : earlyConceded + ' mål indkasseret i kampens første minut (kold start) — ' + p.what + '.' });
    }
  if (totShots >= 5 && conv !== null && conv <= 0.30)
    for (const p of bank.forSignal('conversion')){
      if (cands.some(c => c.code === p.code)) continue;
      cands.push({ ...p, score: 0.32 - conv,
        reason: en
          ? totGoals + ' goals on ' + totShots + ' shots (' + Math.round(conv * 100) + '%) tonight — ' + p.what + '.'
          : totGoals + ' mål på ' + totShots + ' skud (' + Math.round(conv * 100) + '%) i aften — ' + p.what + '.' });
    }
  // "Slå din egen score" var en falsk lovning: spillet viser INGEN score/tid i
  // træningspakker (brugerens rettelse 30/7 — det gælder alle pakker). Det
  // eneste målbare er trackerens egen registrering af runden.
  if (!cands.some(c => c.id === 'ground_shots'))
    cands.push({ ...bank.byId('ground_shots'), score: 0.01,
      reason: en
        ? (totShots ? totGoals + ' goals on ' + totShots + ' shots tonight — ' : totTouches + ' touches tonight — ') +
          'placement practice; the game shows no score in packs, but the tracker measures your round itself.'
        : (totShots ? totGoals + ' mål på ' + totShots + ' skud i aften — ' : totTouches + ' touches i aften — ') +
          'placeringstræning; spillet viser ingen score i pakker, men trackeren måler selv din runde.' });
  cands.sort((a, b) => b.score - a.score);   // stable, so equal scores keep worst-weakness-first order
  let packs = cands.slice(0, 3);
  // rotation: never repeat the primary pack from the previous report
  const prevEntry = state.packHistory.length ? state.packHistory[state.packHistory.length - 1] : null;
  const lastPack = prevEntry ? prevEntry.pack : null;
  if (packs.length && packs[0].code === lastPack){
    if (packs.length > 1){ const t = packs[0]; packs[0] = packs[1]; packs[1] = t; }
    else packs = [{ ...bank.byId('bronze_silver'), score: 0,
      reason: en
        ? ms.length + ' matches tonight — basic first-touch training as variation.'
        : ms.length + ' kampe i aften — grundtræning af første touch som variation.' }, packs[0]];
  }
  // at most ONE variety pack, appended AFTER the measured picks — spice, never
  // the main course, and never the same pack two reports in a row
  const prevShown = prevEntry
    ? (Array.isArray(prevEntry.shown) ? prevEntry.shown : [prevEntry.pack]).concat(prevEntry.variety || [])
    : [];
  const variety = pickVariety(packs, prevShown, ranked, earlyConceded);
  if (variety) packs.push(variety);
  packs = packs.map(p => p.variety
    ? { name: p.name, code: p.code, reason: p.reason, variety: true }
    : { name: p.name, code: p.code, reason: p.reason });

  // --- strategy notes: max 2, only from the source-backed rule library.
  // The instruction itself comes from the bank (19/8): a deterministic pick
  // seeded by the session name, so the report reads the same every time it
  // is rebuilt, and a new evening may draw another guide for the same
  // metric. Its verbatim quote rides along (null when the entry has none);
  // the rule's own advice stays the fallback.
  const notes = [];
  for (const t of ranked){
    if (notes.length >= 2) break;
    if (t.goodness >= 0) continue;
    const rule = RULES.find(r => r.metric === t.id);
    if (!rule) continue;
    const lang = EN() ? 'en' : 'da';
    const guide = persona.guideFor(t.id, (name || '') + '|' + t.id);
    const entry = guide ? persona.BANK_BY_ID.get(guide.id) : null;
    const adv = entry ? persona.adviceFrom(entry, lang, rule.id) : null;
    notes.push({
      text: EN()
        ? cap(t.label) + ' (' + t.playlist + '): ' + M.fmt(t.id, t.sessionAvg) + ' on average tonight against your normal ' + M.fmt(t.id, t.baselineAvg) + '.'
        : cap(t.label) + ' (' + t.playlist + '): ' + M.fmt(t.id, t.sessionAvg) + ' i snit i aften mod normalt ' + M.fmt(t.id, t.baselineAvg) + '.',
      advice: adv ? adv.text
        : ((EN() && rule.advice_en) || rule.advice)({ value: t.sessionAvg, baseline: { mean: t.baselineAvg }, evidence: {} }),
      source: adv ? adv.source : rule.source,
      quote: adv ? adv.quote : null
    });
  }
  // Cold starts (19/8): goals conceded in a match's first minute are counted
  // above (tilt.earlyConceded) and already pick the Saves pack; two or more
  // in one evening also earn a warm-up note from the bank — the player's own
  // measurement (27/7: an hour of packs, then a rank-up in two lists the same
  // evening) is the reason the warm-up is a standing recommendation.
  if (earlyConceded >= 2){
    const g = persona.guideFor('earlyConceded', (name || '') + '|earlyConceded');
    const e = g ? persona.BANK_BY_ID.get(g.id) : null;
    const adv = e ? persona.adviceFrom(e, EN() ? 'en' : 'da', null) : null;
    if (adv) notes.push({
      text: EN()
        ? earlyConceded + ' goals conceded in the first minute of a match tonight (cold start).'
        : earlyConceded + ' mål indkasseret i kampens første minut i aften (kold start).',
      advice: adv.text, source: adv.source, quote: adv.quote
    });
  }

  // --- headline + SSE lines (3 short Danish lines)
  const strongT = strongest.length ? byKey[strongest[0]] : null;
  const weakT = weakest.length ? byKey[weakest[0]] : null;
  const plStr = Object.keys(playlists).map(k => playlists[k].matches.length + '× ' + k).join(', ');
  // Phrase deltas by goodness, not raw sign: for "time under 15 boost" a -5%
  // change IS the improvement, and "(-5%)" next to "strongest" reads wrong.
  const goodTxt = t => EN() ? absPct(t.goodness) + ' better than your normal in ' + t.playlist
                            : absPct(t.goodness) + ' bedre end normalt i ' + t.playlist;
  const badTxt = t => EN() ? absPct(t.goodness) + ' below your normal in ' + t.playlist
                           : absPct(t.goodness) + ' under normalt i ' + t.playlist;
  const headline = EN()
    ? (stop
      ? wl.w + 'W-' + wl.l + 'L — touch power fell ' + absPct(drift.pct) + ' along the way. Consider stopping.'
      : weakT
        ? wl.w + 'W-' + wl.l + 'L — weakest: ' + weakT.label + ' (' + badTxt(weakT) + ').'
        : wl.w + 'W-' + wl.l + 'L across ' + ms.length + ' matches.')
    : (stop
      ? wl.w + 'W-' + wl.l + 'L — touchkraften faldt ' + absPct(drift.pct) + ' undervejs. Overvej at stoppe.'
      : weakT
        ? wl.w + 'W-' + wl.l + 'L — svagest: ' + weakT.label + ' (' + badTxt(weakT) + ').'
        : wl.w + 'W-' + wl.l + 'L over ' + ms.length + ' kampe.');
  const strongBit = strongT ? (EN() ? 'Strongest: ' : 'Stærkest: ') + strongT.label + ' (' + goodTxt(strongT) + ')' : '';
  const weakBit = weakT ? (EN() ? 'weakest: ' : 'svagest: ') + weakT.label + ' (' + badTxt(weakT) + ')' : '';
  const lines = EN()
    ? [
      'Session over: ' + ms.length + ' matches, ' + wl.w + 'W-' + wl.l + 'L (' + plStr + ').',
      strongT || weakT
        ? cap([strongBit, weakBit].filter(Boolean).join(' · ')) + '.'
        : 'Baseline still building — metric trends arrive once your normal is in place.',
      packs.length ? 'Primary training pack: ' + packs[0].name + ' (' + packs[0].code + ').' : 'The report is ready.'
    ]
    : [
      'Session slut: ' + ms.length + ' kampe, ' + wl.w + 'W-' + wl.l + 'L (' + plStr + ').',
      strongT || weakT                              // show whichever side exists
        ? cap([strongBit, weakBit].filter(Boolean).join(' · ')) + '.'
        : 'Baseline under opbygning — metrik-trends kommer, når din normal er på plads.',
      packs.length ? 'Primær træningsbane: ' + packs[0].name + ' (' + packs[0].code + ').' : 'Rapporten er klar.'
    ];

  const durationMin = Math.max(0, Math.round((Date.parse(all[all.length - 1].endedAt) - Date.parse(all[0].startedAt)) / 60000));
  if (privateMs.length)
    lines[0] = lines[0].replace(/\.$/, '') + (EN()
      ? ' · ' + privateMs.length + ' private lobb' + (privateMs.length === 1 ? 'y' : 'ies') + ' shown, not counted.'
      : ' · ' + privateMs.length + ' privat' + (privateMs.length === 1 ? '' : 'e') + ' lobby' + (privateMs.length === 1 ? '' : 'er') + ' vist, ikke talt.');

  return {
    schema: 'session/1',
    packVersion: (profile && profile.packVersion) || null,
    at: now.toISOString(), name, reason,
    url: URL_BASE + name + '.html',
    startedAt: all[0].startedAt, endedAt: all[all.length - 1].endedAt, durationMin,
    matches: ms.map(r => ({ file: r.file, playlist: r.playlist, score: r.score, result: r.result,
      startedAt: r.startedAt, endedAt: r.endedAt, me: r.me })),
    // shown, never counted (user's decision 15/8): what the evening also held
    privateMatches: privateMs.map(r => ({ file: r.file, playlist: r.playlist, matchType: r.matchType || null,
      score: r.score, myTeam: typeof r.myTeam === 'number' ? r.myTeam : 0, result: r.result,
      startedAt: r.startedAt, endedAt: r.endedAt, me: r.me })),
    wl, playlists, totals: { goals: totGoals, shots: totShots, conversion: conv },
    trends, strongest, weakest, tilt, missions, packs, notes, headline, lines
  };
}

/* ---------------- HTML rendering (single dark self-contained page, Danish) ---------------- */

function esc(s){
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* Score from the player's perspective ("dig–dem"), so a win never reads 3–4. */
function myScore(m){
  const s = m.score || [0, 0];
  return m.myTeam === 1 ? s[1] + '–' + s[0] : s[0] + '–' + s[1];
}
function hhmm(iso){
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
function danishDate(iso){
  const d = new Date(iso);
  return d.getDate() + '. ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

function renderHTML(r){
  const durText = r.durationMin >= 60
    ? Math.floor(r.durationMin / 60) + ' t ' + (r.durationMin % 60) + ' min'
    : r.durationMin + ' min';

  const stopBanner = r.tilt.stop
    ? '<div class="card stop"><strong>Tilt-vagt</strong><p>' + esc(r.tilt.stopText) + '</p></div>'
    : '';

  const plCards = Object.keys(r.playlists).map(k => {
    const pl = r.playlists[k];
    const rows = pl.matches.map(m =>
      '<tr><td>' + hhmm(m.startedAt) + '</td>' +
      '<td class="' + (m.result === 'W' ? 'W' : m.result === 'L' ? 'L' : 'muted') + '">' + (m.result || '–') + '</td>' +
      '<td class="num">' + myScore(m) + '</td>' +
      '<td class="num">' + m.me.goals + '</td><td class="num">' + m.me.assists + '</td>' +
      '<td class="num">' + m.me.saves + '</td><td class="num">' + m.me.shots + '</td>' +
      '<td class="num">' + m.me.touches + '</td></tr>').join('');
    return '<div class="card"><div class="plhead"><strong>' + esc(k) + '</strong>' +
      '<span class="chip">' + pl.w + 'W–' + pl.l + 'L' + (pl.u ? '–' + pl.u + '?' : '') + '</span>' +
      '<span class="chip">' + pl.goals + ' mål / ' + pl.shots + ' skud' +
      (pl.conversion !== null ? ' · ' + Math.round(pl.conversion * 100) + '% konvertering' : '') + '</span></div>' +
      '<div class="scroll"><table><thead><tr><th>Start</th><th>Res.</th><th>Score</th><th>Mål</th><th>Ass.</th><th>Redn.</th><th>Skud</th><th>Touch</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }).join('');
  // Private lobbies: shown so the evening is told whole, tagged so nobody
  // reads them into the numbers above (they are in none of them).
  const privRows = (r.privateMatches || []).map(m =>
    '<tr><td>' + hhmm(m.startedAt) + '</td><td>' + esc(m.playlist || '–') + ' <span class="tag">privat</span></td>' +
    '<td>' + esc(m.matchType || 'privat') + '</td>' +
    '<td class="' + (m.result === 'W' ? 'W' : m.result === 'L' ? 'L' : 'muted') + '">' + (m.result || '–') + '</td>' +
    '<td class="num">' + myScore(m) + '</td>' +
    '<td class="num">' + m.me.goals + '</td><td class="num">' + m.me.shots + '</td><td class="num">' + m.me.touches + '</td></tr>').join('');
  const privCard = privRows
    ? '<div class="card"><div class="plhead"><strong>Private lobbyer</strong><span class="chip">vist, ikke talt</span></div>' +
      '<div class="scroll"><table><thead><tr><th>Start</th><th>Playlist</th><th>Type</th><th>Res.</th><th>Score</th><th>Mål</th><th>Skud</th><th>Touch</th></tr></thead>' +
      '<tbody>' + privRows + '</tbody></table></div>' +
      '<p class="muted" style="font-size:12.5px">En privat lobby er hvem værten inviterede, på det niveau værten valgte — den indgår hverken i W/L, trends, missioner eller din normal.</p></div>'
    : '';

  const trendRows = r.trends.length ? r.trends.map(t => {
    const k = (t.playlist || '') + '|' + t.id;
    const mark = r.weakest.includes(k) ? ' <span class="tag bad">svagest</span>'
      : r.strongest.includes(k) ? ' <span class="tag good">stærkest</span>'
      : t.mature === false ? ' <span class="tag">baseline ' + t.baselineN + '/' + M.MIN_BASELINE + '</span>' : '';
    const delta = t.deltaPct !== null
      ? '<td class="num ' + (t.goodness >= 0 ? 'b-good' : 'b-bad') + '">' + pctS(t.deltaPct) + '</td>'
      : t.delta !== null && t.delta !== undefined     // absolute for noPct metrics
        ? '<td class="num ' + (t.delta * t.direction >= 0 ? 'b-good' : 'b-bad') + '">' +
          (t.delta >= 0 ? '+' : '') + (Math.round(t.delta * 10) / 10) + '</td>'
        : '<td class="num muted">–</td>';
    return '<tr><td>' + esc(cap(t.label)) + mark + '</td>' +
      '<td>' + esc(t.playlist || '–') + '</td>' +
      '<td class="num">' + M.fmt(t.id, t.sessionAvg) + '</td>' +
      '<td class="num">' + (t.baselineAvg === null ? '–' : M.fmt(t.id, t.baselineAvg)) + '</td>' +
      delta + '<td class="num muted">' + t.n + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="muted">Ingen metrikker med data i denne session.</td></tr>';

  const seqChips = r.tilt.sequence.split(' ').map(x =>
    '<span class="seq ' + (x === 'W' ? 'W' : x === 'L' ? 'L' : '') + '">' + esc(x) + '</span>').join('');
  const driftHtml = r.tilt.drift
    ? 'Touchkraft-snit, kampene i første halvdel: <strong>' + M.fmt('hit_power_avg', r.tilt.drift.firstAvg) +
      '</strong> · sidste halvdel: <strong>' + M.fmt('hit_power_avg', r.tilt.drift.secondAvg) +
      '</strong> (drift <strong>' + pctS(r.tilt.drift.pct) + '</strong>).'
    : 'Touchkraft-drift: for få målinger til at sammenligne sessionens halvdele.';

  const missionsHtml = r.missions.length
    ? '<ol class="missions">' + r.missions.map(m => '<li>' + esc(m.text) + '</li>').join('') + '</ol>'
    : '<p class="muted">Baseline under opbygning — missioner kommer, når din normal er på plads.</p>';

  const packsHtml = r.packs.map((p, i) =>
    '<div class="card"><div class="plhead"><strong>' + (i === 0 ? 'Primær: ' : p.variety ? 'Afveksling: ' : '') + esc(p.name) +
    '</strong><span class="code">' + esc(p.code) + '</span></div>' +
    '<p>' + esc(p.reason) + '</p></div>').join('');

  const notesHtml = r.notes.length ? r.notes.map(n =>
    '<div class="card"><p>' + esc(n.text) + '</p><p class="advice">' + esc(n.advice) + '</p>' +
    (n.quote && n.quote.text ? '<p class="quote">“' + esc(n.quote.text) + '”' + (n.quote.by ? ' <span class="by">— ' + esc(n.quote.by) + '</span>' : '') + '</p>' : '') +
    (n.source ? '<p class="src">Kilde: <a href="' + esc(n.source.url) + '" rel="noopener">' + esc(n.source.title) + '</a></p>' : '') + '</div>').join('')
    : '<p class="muted">Ingen strateginoter i aften — ingen kildebelagt regel matcher sessionens svage punkter.</p>';

  return '<!doctype html>\n<html lang="da"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>Session-rapport — ' + esc(danishDate(r.startedAt)) + '</title>\n' +
    '<style>\n' +
    /* Stadium night (26/8): rapporterne deler brand med tracker/landing/portal */
    ':root{--bg:#0C1424;--panel:#16233E;--panel2:#10192C;--line:#263650;--text:#EAF2FF;--muted:#8CA0BF;--good:#35D08C;--bad:#F85149;--accent:#3FB3FF;--warn:#FFC94A}\n' +
    '*{box-sizing:border-box;margin:0;padding:0}\n' +
    'body{background:var(--bg);color:var(--text);font:15px/1.55 system-ui,"Segoe UI",sans-serif;padding:24px 14px}\n' +
    '.wrap{max-width:880px;margin:0 auto}\n' +
    'h1{font-size:23px;margin-bottom:4px}\n' +
    'h2{font-size:13px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px}\n' +
    '.sub{color:var(--muted);margin-bottom:12px}\n' +
    '.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 15px;margin-bottom:10px}\n' +
    '.card p{margin:6px 0 0}\n' +
    '.stop{border-color:var(--warn);background:#221A0D}\n' +
    '.stop strong{color:var(--warn)}\n' +
    '.chip{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin:2px 6px 2px 0;font-size:13px;white-space:nowrap}\n' +
    '.plhead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px}\n' +
    '.plhead strong{margin-right:auto}\n' +
    'table{width:100%;border-collapse:collapse;font-size:13.5px}\n' +
    'th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}\n' +
    'th{color:var(--muted);font-weight:600}\n' +
    'tr:last-child td{border-bottom:0}\n' +
    '.num{text-align:right;font-variant-numeric:tabular-nums}\n' +
    '.muted{color:var(--muted)}\n' +
    '.b-good{color:var(--good);font-weight:600}.b-bad{color:var(--bad);font-weight:600}\n' +
    '.W{color:var(--good);font-weight:700}.L{color:var(--bad);font-weight:700}\n' +
    '.tag{font-size:11px;border-radius:5px;padding:1px 6px;vertical-align:1px}\n' +
    '.tag.bad{background:#2A1218;color:var(--bad)}.tag.good{background:#0E241D;color:var(--good)}\n' +
    '.seq{display:inline-block;min-width:26px;text-align:center;border-radius:6px;padding:2px 4px;margin-right:4px;background:var(--panel2);border:1px solid var(--line);font-weight:700}\n' +
    '.seq.W{color:var(--good)}.seq.L{color:var(--bad)}\n' +
    '.code{font-family:Consolas,monospace;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:13px}\n' +
    '.missions{margin:4px 0 0 20px}.missions li{margin:5px 0}\n' +
    '.advice{color:var(--accent)}\n' +
    '.quote{font-style:italic;color:var(--text);border-left:3px solid var(--accent);padding-left:10px;margin:8px 0 4px}.quote .by{font-style:normal;color:var(--muted);font-size:12.5px}\n' +
    '.src{font-size:12.5px;color:var(--muted)}\n' +
    '.src a{color:var(--accent);text-decoration:none}\n' +
    '.scroll{overflow-x:auto}\n' +
    'ul.tilt{margin:6px 0 0 20px}ul.tilt li{margin:4px 0}\n' +
    'footer{color:var(--muted);font-size:12.5px;margin-top:26px;border-top:1px solid var(--line);padding-top:12px}\n' +
    '</style></head><body><div class="wrap">\n' +
    '<h1>Aftenens session</h1>\n' +
    '<div class="sub">' + esc(danishDate(r.startedAt)) + ' · ' + hhmm(r.startedAt) + '–' + hhmm(r.endedAt) + '</div>\n' +
    '<div>' +
      '<span class="chip">' + r.matches.length + ' kampe</span>' +
      '<span class="chip">' + r.wl.w + 'W–' + r.wl.l + 'L' + (r.wl.u ? '–' + r.wl.u + '?' : '') + '</span>' +
      '<span class="chip">' + durText + '</span>' +
      '<span class="chip">' + r.totals.goals + ' mål / ' + r.totals.shots + ' skud' +
      (r.totals.conversion !== null ? ' · ' + Math.round(r.totals.conversion * 100) + '%' : '') + '</span>' +
    '</div>\n' + stopBanner +
    '<h2>Resumé pr. playlist</h2>\n' + plCards + privCard +
    '<h2>Metrik-trends mod din normal</h2>\n' +
    '<div class="card"><div class="scroll"><table><thead>' +
    '<tr><th>Metrik</th><th>Playlist</th><th class="num">Session-snit</th><th class="num">Normal</th><th class="num">Δ</th><th class="num">Kampe</th></tr>' +
    '</thead><tbody>' + trendRows + '</tbody></table></div>' +
    '<p class="muted" style="font-size:12.5px">Normal = dit eget løbende EWMA-snit pr. playlist (profile.json) — ikke eksterne benchmarks.</p></div>\n' +
    '<h2>Tilt-analyse (kun målte mønstre)</h2>\n' +
    '<div class="card">' +
    '<div>' + seqChips + '</div>' +
    '<ul class="tilt">' +
    '<li>' + driftHtml + '</li>' +
    '<li>Mål indkasseret i kampens første minut: <strong>' + r.tilt.earlyConceded + '</strong></li>' +
    '<li>Holdets scoringer i sidste minut eller overtid: <strong>' + r.tilt.lateOwn + '</strong></li>' +
    '</ul>' +
    (r.tilt.stop ? '' : '<p class="muted">' + esc(r.tilt.stopText) + '</p>') +
    '</div>\n' +
    '<h2>Missioner til næste session</h2>\n' +
    '<div class="card">' + missionsHtml + '</div>\n' +
    '<h2>Træningsbaner til næste session</h2>\n' + packsHtml +
    '<h2>Strateginoter</h2>\n' + notesHtml +
    '<footer>Genereret ' + esc(danishDate(r.at)) + ' kl. ' + hhmm(r.at) + ' · session-rapport (' + esc(r.reason) + ') · alle tal er målt af trackeren — ingen opfundne benchmarks.</footer>\n' +
    '</div></body></html>\n';
}

module.exports = { init, onMatch, onMatchStart, tick, onGameDisconnect, latest, current, rehome,
  _pauseEval: pauseEval, _pauseStep: pauseStep };   // eksponeret til test-harness
