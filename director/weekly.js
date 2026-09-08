/* RL Director — weekly progression engine (M4).
 *
 * The session report answers "how did tonight go". This one answers the harder
 * question the whole product is judged on: "am I actually getting better, and
 * did the thing you told me to work on move?"
 *
 * Everything here is deterministic and rebuilt from files that already exist:
 * the per-match debriefs in reports/ (each carrying the PRE-match baseline it
 * was judged against) and the session reports (each carrying the focus it
 * produced). Nothing is recomputed from raw digests — the metric engine owns
 * every number, and the debriefs are its output (DESIGN §3).
 *
 * Two honesty rules run through the file:
 *
 *  1. The proof section may say "not measurable" and often will. A focus with
 *     two matches after it proves nothing, and reporting it as progress would
 *     make the product a flatterer. Under PROOF_MIN_MATCHES it says so.
 *  2. The rank curve starts the day the tracker started logging it. It is
 *     shown as context, never as evidence for a metric (DESIGN §8, risk 6).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./metrics');
const store = require('./store');
const reportTheme = require('./report-theme');   // FULD GAS 27/8: de fire temaer
const packs = require('./packs');
const T = require('./tier');   // spillerens tier (8/9): vinduet en bane skal ligge i
const focusEngine = require('./focus');
const voice = require('./voice');
const persona = require('./persona');
const pitch = require('./pitch');       // baneradar (7/9): skudstederne for ugens kampe
const radar = require('./radar');

/* A Rocket League evening routinely runs past midnight, so a calendar day cuts
 * sessions in half: the 02:12 matches on Monday belong to Sunday's play. The
 * play day therefore starts at 06:00 local time — chosen because it is the one
 * hour of the day the user is reliably NOT playing, so no session can straddle
 * it. Weeks are ISO weeks (Mon-Sun) over play days. */
const DAY_START_HOUR = 6;
const MIN_WEEK_MATCHES = 5;      // fewer than this in a week: no report, nothing to say
const PROOF_MIN_MATCHES = 3;     // matches after a focus before its effect may be judged
const RANK_HISTORY_CAP = 400;
const RANK_MIN_GAP_MS = 6 * 3600e3;

let ROOT = null, log = () => {}, broadcast = () => {};
let state = null;
let cache = null;                // { mtimeKey, debriefs, sessions } — reports/ is append-only

function statePath(){ return path.join(ROOT, 'weekly-state.json'); }
function rankPath(){ return path.join(ROOT, 'rank-history.json'); }
const EN = () => M.currentLanguage && M.currentLanguage() === 'en';
/* Verdict ENUM values stay Danish everywhere (stored reports, /rl-coach, code
 * comparisons) — verdictShown is the display word the board renders. */
const VERDICT_EN = { 'opnået': 'achieved', 'på vej': 'on the way', 'ikke rykket': 'no movement',
                     'tilbagegang': 'regressed', 'ikke målbart': 'not measurable' };
const verdictShown = v => (EN() && VERDICT_EN[v]) || v;
function reportsDir(){ return path.join(ROOT, 'reports'); }

function defaultState(){
  return { schema: 'weekly-state/1', lastReport: null, written: [], packHistory: [] };
}
function defaultRank(){ return { schema: 'rank-history/1', points: [] }; }

function init(opts){
  ROOT = opts.root;
  log = opts.log || log;
  broadcast = opts.broadcast || broadcast;
  state = store.readJSON(statePath(), defaultState);
  if (state.schema !== 'weekly-state/1') state = defaultState();
  seedRankFromCache();
  return module.exports;
}

function save(){ try{ store.writeJSON(statePath(), state); }catch(e){ log('[weekly] kunne ikke gemme state: ' + (e.message || e)); } }

/* ---------------- time ---------------- */

const p2 = n => String(n).padStart(2, '0');

/* Local play day of an instant, as YYYY-MM-DD. */
function playDay(iso){
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - DAY_START_HOUR * 3600e3);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/* ISO week of a YYYY-MM-DD play day. Thursday-based, per ISO 8601: the week
 * number is that of the Thursday in the same Mon-Sun week, which is what makes
 * the year roll over correctly at New Year. */
function isoWeekOf(day){
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7;                       // Mon=0 … Sun=6
  const monday = new Date(y, m - 1, d - dow);
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const week = 1 + Math.round((thursday - jan1) / 86400e3 / 7);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const fmt = x => x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate());
  return { year: thursday.getFullYear(), week, key: thursday.getFullYear() + '-W' + p2(week),
           from: fmt(monday), to: fmt(sunday) };
}

function weekOfIso(iso){ const d = playDay(iso); return d ? isoWeekOf(d) : null; }
function currentWeek(){ return isoWeekOf(playDay(new Date().toISOString())); }
/* The instant a play-week is over: DAY_START_HOUR on the Monday after wk.to,
 * local time — the same boundary playDay() draws, seen from the other side. */
function weekEndIso(wk){
  const [y, m, d] = wk.to.split('-').map(Number);
  return new Date(y, m - 1, d + 1, DAY_START_HOUR, 0, 0, 0).toISOString();
}

/* ---------------- loading (reports/ is the archive) ---------------- */

/* reports/ only ever grows, so parse each file ONCE and keep it.
 *
 * This runs in the recorder's process, on the minute tick and again the moment
 * a match ends — the exact instant the debrief is supposed to reach the board.
 * Re-parsing the whole archive there is fine at 60 files and a visible stall at
 * a year's worth, and the stall would land on the one interaction the product
 * is built around. So the directory listing decides what is NEW, and only new
 * files are read. Deleting a report frees its entry on the next pass. */
function loadReports(){
  let names = [];
  try{ names = fs.readdirSync(reportsDir()); }catch{ return { debriefs: [], sessions: [], weeklies: [] }; }
  if (!cache) cache = { seen: new Map(), key: null, debriefs: [], sessions: [], weeklies: [] };

  const present = new Set(names);
  let changed = false;
  for (const f of names){
    if (cache.seen.has(f)) continue;
    const isDebrief = f.endsWith('-debrief.json');
    const isSession = f.startsWith('session-') && f.endsWith('.json');
    // closed weekly reports are part of the focus history too (17/8): their
    // focusNext opens the following week on the card, so the timeline replay
    // needs them in the same order as the sessions
    const isWeekly = f.startsWith('weekly-') && f.endsWith('.json');
    if (!isDebrief && !isSession && !isWeekly){ cache.seen.set(f, null); continue; }
    let j = null;
    try{ j = JSON.parse(fs.readFileSync(path.join(reportsDir(), f), 'utf8')); }catch{ j = null; }
    if (isDebrief && (!j || j.setup || !j.match || !j.at)) j = null;
    if (isSession && !(j && j.at && Array.isArray(j.trends))) j = null;
    if (isWeekly && !(j && j.at && j.closed && j.key)) j = null;
    // null is remembered too: an unparseable file must not be re-read every tick
    cache.seen.set(f, j ? { kind: isDebrief ? 'd' : isSession ? 's' : 'w', j } : null);
    changed = true;
  }
  for (const f of [...cache.seen.keys()]) if (!present.has(f)){ cache.seen.delete(f); changed = true; }

  if (changed || cache.key === null){
    cache.debriefs = [];
    cache.sessions = [];
    cache.weeklies = [];
    for (const v of cache.seen.values()){
      if (!v) continue;
      (v.kind === 'd' ? cache.debriefs : v.kind === 's' ? cache.sessions : cache.weeklies).push(v.j);
    }
    cache.debriefs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    cache.sessions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    cache.weeklies.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    cache.key = names.length;
    // meCache is deliberately NOT cleared: it is keyed by digest filename, and
    // a digest is written once and never touched again. A debrief that gains a
    // `me` field is answered from the debrief itself, before the cache is asked.
  }
  return cache;
}

/* ---------------- rank curve ---------------- */

/* The rank API allows 5 lookups a day, so the curve is built from whatever the
 * board already asked for: every fresh result for the TRACKED player is
 * appended here. Opponents are never logged — this is the player's own
 * progression file, not a database of other people. */
function onRank(isTracked, data){
  if (!isTracked || !data) return;
  const pl = {};
  for (const [k, name] of [['p1', '1v1'], ['p2', '2v2'], ['p3', '3v3']]){
    const r = data[k];
    if (r && Number.isFinite(r.mmr)) pl[name] = { label: r.label || null, division: r.division || null, mmr: r.mmr };
  }
  if (!Object.keys(pl).length) return;
  const hist = store.readJSON(rankPath(), defaultRank);
  const last = hist.points[hist.points.length - 1];
  // Same MMR in every playlist and less than six hours old: nothing happened,
  // and a curve made of identical points is a curve about polling, not rank.
  if (last){
    const same = Object.keys(pl).every(k => last.playlists[k] && last.playlists[k].mmr === pl[k].mmr)
      && Object.keys(last.playlists).length === Object.keys(pl).length;
    if (same && Date.now() - Date.parse(last.at) < RANK_MIN_GAP_MS) return;
  }
  hist.points.push({ at: new Date().toISOString(), playlists: pl });
  hist.points = hist.points.slice(-RANK_HISTORY_CAP);
  try{ store.writeJSON(rankPath(), hist, 1); }catch{}
}

/* The rank cache already holds a fresh lookup for the tracked player from
 * before this file existed. Seed one point from it rather than starting the
 * curve at zero — the timestamp is the cache's own, so the point is not
 * back-dated to something we did not measure. */
function seedRankFromCache(){
  try{
    const hist = store.readJSON(rankPath(), defaultRank);
    if (hist.points.length) return;
    const prof = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8'));
    const cacheFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'rank-cache.json'), 'utf8'));
    const entry = prof && prof.trackedPid && cacheFile.players && cacheFile.players[prof.trackedPid];
    if (!entry || !entry.data || !entry.t) return;
    const pl = {};
    for (const [k, name] of [['p1', '1v1'], ['p2', '2v2'], ['p3', '3v3']]){
      const r = entry.data[k];
      if (r && Number.isFinite(r.mmr)) pl[name] = { label: r.label || null, division: r.division || null, mmr: r.mmr };
    }
    if (!Object.keys(pl).length) return;
    hist.points.push({ at: new Date(entry.t).toISOString(), playlists: pl, seeded: true });
    store.writeJSON(rankPath(), hist, 1);
    log('[weekly] rank-kurven startet fra det seneste opslag i rank-cache');
  }catch{}
}

function rankSection(from, to){
  let hist = defaultRank();
  try{ hist = store.readJSON(rankPath(), defaultRank); }catch{}
  const inWeek = hist.points.filter(p => {
    const d = playDay(p.at);
    return d && d >= from && d <= to;
  });
  const names = ['1v1', '2v2', '3v3'];
  const byPlaylist = {};
  for (const n of names){
    const pts = inWeek.filter(p => p.playlists[n]).map(p => ({ at: p.at, day: playDay(p.at), ...p.playlists[n] }));
    if (!pts.length) continue;
    const first = pts[0], last = pts[pts.length - 1];
    byPlaylist[n] = { points: pts, first, last, deltaMmr: last.mmr - first.mmr, changed: last.mmr !== first.mmr };
  }
  // Points before the week give the curve a starting height even in a week
  // with a single lookup — shown as "sidst målt før ugen", never interpolated.
  const before = hist.points.filter(p => { const d = playDay(p.at); return d && d < from; });
  const priorPoint = before.length ? before[before.length - 1] : null;
  const measured = Object.keys(byPlaylist).length > 0;
  return {
    measured, byPlaylist, prior: priorPoint,
    /* noteKind i stedet for faerdig tekst (26/8): teksten vaelges ved RENDER
     * i rapportens sprog. note beholdes for gamle laesere af JSON'en. */
    noteKind: measured ? 'context' : (hist.points.length ? 'noLookups' : 'noPoints'),
    note: measured
      ? 'Rank er kontekst, ikke bevis: matchmaking og varians flytter MMR uafhængigt af om en vane blev bedre.'
      : (hist.points.length
          ? 'Ingen rank-opslag i denne uge (5 gratis opslag/dag deles med modstander-chippene).'
          : 'Rank-kurven har ingen målepunkter endnu — den starter ved første opslag med din egen konto.')
  };
}

/* Rank-notens tekst i rapportens sprog. Gamle JSON'er uden noteKind falder
 * tilbage til den gemte (danske) note — historik forfalskes ikke. */
const RANK_NOTES = {
  da: { context: 'Rank er kontekst, ikke bevis: matchmaking og varians flytter MMR uafhængigt af om en vane blev bedre.',
        noLookups: 'Ingen rank-opslag i denne uge (5 gratis opslag/dag deles med modstander-chippene).',
        noPoints: 'Rank-kurven har ingen målepunkter endnu — den starter ved første opslag med din egen konto.' },
  en: { context: 'Rank is context, not evidence: matchmaking and variance move MMR regardless of whether a habit improved.',
        noLookups: 'No rank lookups this week (the 5 free lookups per day are shared with the opponent chips).',
        noPoints: 'The rank curve has no data points yet — it starts at the first lookup with your own account.' }
};
function rankNote(rank, en){
  let kind = rank.noteKind;
  if (!kind && rank.note)         // gamle JSON'er: genkend den gemte danske tekst
    for (const k of Object.keys(RANK_NOTES.da)) if (RANK_NOTES.da[k] === rank.note) kind = k;
  const set = RANK_NOTES[en ? 'en' : 'da'];
  return (kind && set[kind]) || rank.note || '';
}

/* The whole curve, for the rank-progression graph (25/8). Points pass through
 * exactly as measured — never resampled, smoothed or trimmed here; the seeded
 * 27/7 anchor keeps its flag so the page can mark it as a starting point
 * rather than a match measurement. Rank stays context, never evidence
 * (DESIGN §8, risk 6) — this is the player's own progression, shown whole. */
function rankHistory(){
  let hist = defaultRank();
  try{ hist = store.readJSON(rankPath(), defaultRank); }catch{}
  if (!hist.points.length) return null;
  return { schema: 'rank-curve/1', points: hist.points };
}

/* ---------------- week aggregation ---------------- */

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pctS = x => (x >= 0 ? '+' : '-') + Math.abs(Math.round(x * 100)) + '%';
const absPct = x => Math.abs(Math.round(x * 100)) + '%';

/* One size's distribution as words: "8 ranked · 3 turnering · 50 uden
 * playlist-id". Kinds in a fixed order so two weeks read alike. */
function kindsText(kinds, en){
  return M.KIND_ORDER.filter(k => kinds[k]).map(k => kinds[k] + ' ' + M.kindLabel(k, en)).join(' · ');
}
/* All sizes: "3v3: 8 ranked · 3 turnering · 50 uden playlist-id; 2v2: …" */
function modesText(modes, en){
  return Object.keys(modes || {}).sort()
    .map(k => k + ': ' + kindsText(modes[k].kinds, en)).join('; ');
}

/* The player's own line for a match.
 *
 * Debriefs only started carrying `me` on 2026-07-26, so every match before that
 * would report 0 goals and 0 shots — a weekly whose totals row is silently
 * wrong for its own first weeks. The digest in matches/ has always had it, so
 * fall back to the archive. Cached: a week re-reads the same files every tick.
 */
let meCache = null;
function meFor(d){
  if (d.me && (d.me.touches !== undefined || d.me.goals !== undefined)) return d.me;
  if (!d.match || !d.match.file) return {};
  if (!meCache){
    meCache = { pid: '', byFile: new Map() };
    try{ meCache.pid = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8')).trackedPid || ''; }catch{}
  }
  if (meCache.byFile.has(d.match.file)) return meCache.byFile.get(d.match.file);
  let me = {};
  try{
    const dig = JSON.parse(fs.readFileSync(path.join(ROOT, 'matches', d.match.file), 'utf8'));
    const p = (dig.players || []).find(p => p.pid === meCache.pid);
    if (p) me = { goals: p.goals | 0, assists: p.assists | 0, saves: p.saves | 0, shots: p.shots | 0, touches: p.touches | 0 };
  }catch{}
  meCache.byFile.set(d.match.file, me);
  return me;
}

/* What kind of match a row was — ranked / tournament / rumble / casual /
 * other / unknown — and the size label it goes under in the distribution.
 *
 * Debriefs carry it from 17/8 (match.matchKind, stamped by director.onDigest
 * from metrics.bucketOf). For the ones written before, the digest is asked,
 * exactly like meFor(): it has carried playlistId since adapter 1.4.0 (15/8),
 * and everything older is id-less by construction and stays 'unknown' under
 * its size label. An unreadable digest is 'unknown' too — "cannot know", never
 * a guess. Cached per digest file for the same reason as meCache. */
let kindCache = null;
function kindFor(d){
  const m = d.match || {};
  if (m.matchKind)
    return { size: m.playlistSize || m.playlist || 'other', kind: m.private ? 'private' : m.matchKind,
             known: m.kindKnown === true, id: typeof m.playlistId === 'number' ? m.playlistId : null };
  const fallback = { size: m.playlist || 'other', kind: m.private ? 'private' : 'unknown', known: false, id: null };
  if (!m.file) return fallback;
  if (!kindCache) kindCache = new Map();
  if (kindCache.has(m.file)) return kindCache.get(m.file);
  let out = fallback;
  try{
    const dig = JSON.parse(fs.readFileSync(path.join(ROOT, 'matches', m.file), 'utf8'));
    const b = M.bucketOf(dig);
    out = { size: b.size, kind: m.private ? 'private' : b.kind, known: b.known, id: b.id };
  }catch{}
  kindCache.set(m.file, out);
  return out;
}

/* Per-match rows for one week, straight from the debriefs. */
function matchesInWeek(debriefs, wk){
  const out = [];
  for (const d of debriefs){
    const day = playDay(d.at);
    if (!day || day < wk.from || day > wk.to) continue;
    // mutators read off the match (6/9): counted in W/L, absent from every
    // boost/movement/touch-power number by the engine's own gate — and a card
    // written before a metric was flagged is filtered by the registry as it
    // stands now (touch power joined the evening of 6/9)
    const mutators = Array.isArray(d.match.mutators) ? d.match.mutators : [];
    const metrics = {};
    for (const m of d.metrics || [])
      if (m && M.DEFS[m.id] && Number.isFinite(m.value) && !M.blockedBy(m.id, mutators))
        metrics[m.id] = { v: m.value,
                          b: m.baseline && Number.isFinite(m.baseline.mean) ? m.baseline.mean : null,
                          bn: m.baseline && Number.isFinite(m.baseline.n) ? m.baseline.n : 0 };
    const kind = kindFor(d);
    out.push({
      at: d.at, day, file: d.match.file || null,
      // private lobbies ride along as rows and are filtered out of every number
      // by buildReport (user's decision 15/8): shown, never counted
      private: !!d.match.private, matchType: d.match.matchType || null,
      mutators,
      // `playlist` is the BUCKET the match was measured against (the debrief's
      // own word for it, so trends group exactly as the coach judged); size and
      // kind are what the game said it was — the distribution is built on those
      playlist: d.match.playlist || 'other',
      size: kind.size, kind: kind.kind, kindKnown: kind.known, playlistId: kind.id,
      result: d.match.result || null,
      score: Array.isArray(d.match.score) ? d.match.score : [0, 0],
      myTeam: typeof d.match.myTeam === 'number' ? d.match.myTeam : null,
      me: meFor(d), metrics, collecting: !!d.collecting
    });
  }
  return out;
}

/* Trends: the week's average against the normal AS IT STOOD when the week
 * began. The debrief carries the pre-match baseline, so the first match of the
 * week holds exactly that number — no need to reconstruct anything, and no risk
 * of comparing the week against a baseline the week itself has been folded
 * into (the M1.5 lesson that cost a whole round of wrong percentages). */
function buildTrends(ms, prevMs){
  const acc = {};
  for (const r of ms){
    const byPl = acc[r.playlist] || (acc[r.playlist] = {});
    for (const id of Object.keys(r.metrics)){
      const a = byPl[id] || (byPl[id] = { vals: [], first: null, firstN: 0, last: null, lastN: 0 });
      a.vals.push(r.metrics[id].v);
      const b = r.metrics[id].b;
      if (b !== null){
        if (a.first === null){ a.first = b; a.firstN = r.metrics[id].bn; }
        a.last = b; a.lastN = r.metrics[id].bn;
      }
    }
  }
  const prev = {};
  for (const r of prevMs || []){
    const byPl = prev[r.playlist] || (prev[r.playlist] = {});
    for (const id of Object.keys(r.metrics)) (byPl[id] || (byPl[id] = [])).push(r.metrics[id].v);
  }

  const trends = [];
  for (const pl of Object.keys(acc)) for (const id of Object.keys(M.DEFS)){
    const a = acc[pl][id];
    if (!a || !a.vals.length) continue;
    const weekAvg = avg(a.vals);
    const normStart = a.first;
    /* Maturity is measured on the baseline the week is COMPARED AGAINST — the
     * one that stood at the week's first match — not on the one that exists by
     * Sunday night. Using the end-of-week count (which only grows) called a
     * 3v3 week "575% over normal" because its "normal" was a single early match
     * from the day the baselines were born. The session report may use the
     * larger count because it judges a single evening against a normal built
     * before it; a week judged against its own opening baseline may not. */
    const baselineN = a.firstN;
    const baselineNEnd = a.lastN;
    const deltaPct = normStart !== null && M.ranked(id) && Math.abs(normStart) > 1e-9
      ? (weekAvg - normStart) / Math.abs(normStart) : null;
    const prevAvg = prev[pl] && prev[pl][id] && prev[pl][id].length ? avg(prev[pl][id]) : null;
    const vsPrevPct = prevAvg !== null && M.ranked(id) && Math.abs(prevAvg) > 1e-9
      ? (weekAvg - prevAvg) / Math.abs(prevAvg) : null;
    trends.push({
      // unit in the label (19/8): '(m)'/'(km/t)' follows every quoted value
      id, playlist: pl, label: M.labelWithUnit(id), direction: M.DEFS[id].direction,
      n: a.vals.length, weekAvg, normStart, normEnd: a.last,
      baselineN, baselineNEnd, mature: baselineN >= M.MIN_BASELINE,
      delta: normStart === null ? null : weekAvg - normStart,
      deltaPct, goodness: deltaPct === null ? null : deltaPct * M.DEFS[id].direction,
      prevWeekAvg: prevAvg, vsPrevPct,
      vsPrevGoodness: vsPrevPct === null ? null : vsPrevPct * M.DEFS[id].direction
    });
  }
  return trends;
}

/* ---------------- the proof section ---------------- */

/* Every focus the coach has ever put on the board, with the window it was in
 * force. Reconstructed from the reports rather than logged, so the section
 * works on the archive that already exists — and so it can never disagree with
 * what the focus card actually said: the archive is replayed in report order
 * through focusEngine.pick(), the one function director.focus() also calls,
 * with the same two inputs it gets live (latest session, latest closed weekly).
 *
 * Two kinds of event move the card: a session report landing and a weekly
 * report landing (its focusNext opens the week — the M4 coupling, 17/8). A
 * report that yields no focus leaves the previous one standing, exactly as the
 * board keeps its card when nothing new is broadcast.
 *
 * The window is per PLAYLIST (6/9-2026). A focus is a promise about one
 * playlist's matches, so only a later focus in the SAME playlist can end it —
 * or the end of the play-week it was set in (Monday 06:00), because each week
 * is judged in its own report. A card that moves to a 2v2 metric says nothing
 * about the 3v3 focus that stood before it; until 6/9 it closed that window
 * anyway, and three 3v3 matches played straight into a "2v2 window" counted
 * nowhere — the week's focus read "not measurable" with the proof on disk. */
function focusTimeline(sessions, weeklies){
  const events = []
    .concat((sessions || []).map(s => ({ t: Date.parse(s.at), kind: 's', r: s })))
    .concat((weeklies || []).map(w => ({ t: Date.parse(w.at), kind: 'w', r: w })))
    .filter(e => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const out = [];
  const lanes = new Map();          // playlist -> the focus in force there
  const weekOfEntry = new Map();    // entry -> play-week it was set in
  let session = null, weekly = null;
  for (const e of events){
    if (e.kind === 's') session = e.r; else weekly = e.r;
    let f = null;
    try{ f = focusEngine.pick(session, weekly); }catch{ f = null; }
    if (!f) continue;
    const lane = f.playlist || null;
    const wk = weekOfIso(e.r.at);
    const prev = lanes.get(lane) || null;
    // The same focus surviving two reports is one continuous attempt, not two —
    // within one week. Carried across Monday 06:00 it is a new attempt, judged
    // in the new week's report.
    if (prev && prev.metricId === f.metricId && weekOfEntry.get(prev) === (wk ? wk.key : null)){
      if (e.kind === 's') prev.sessions.push(e.r.name || null);
      continue;
    }
    const entry = { metricId: f.metricId, playlist: f.playlist, label: f.label, direction: f.direction,
                    target: f.target, targetText: f.targetText, setAt: e.r.at,
                    source: f.source || 'session', weekKey: f.weekKey || null,
                    // what the focus was reacting to: the session's (or week's) own average
                    triggerValue: Number.isFinite(f.triggerValue) ? f.triggerValue : null,
                    sessions: e.kind === 's' ? [e.r.name || null] : [],
                    sessionUrl: (f.session && f.session.url) || e.r.url || null,
                    until: null };
    if (prev && prev.until === null) prev.until = e.r.at;      // replaced in its own playlist
    lanes.set(lane, entry);
    weekOfEntry.set(entry, wk ? wk.key : null);
    out.push(entry);
  }
  // ...and never past the week it was set in
  for (const x of out){
    const wk = weekOfIso(x.setAt);
    if (!wk) continue;
    const end = weekEndIso(wk);
    if (x.until === null || Date.parse(x.until) > Date.parse(end)) x.until = end;
  }
  return out;
}

function proofFor(timeline, allMatches, wk){
  const rows = [];
  for (const f of timeline){
    /* Matches measured against this focus, INSIDE this week.
     *
     * The week bound is load-bearing in both directions. Without an upper
     * bound, a focus still in force (until === null) pulls in every later
     * match, so last week's report would silently credit progress made this
     * week — and would say something different every time it was rebuilt.
     * focusTimeline() now ends every window with its own play-week (6/9), so a
     * focus set on a Sunday evening reads "ikke målbart" here and is not
     * carried into next week's report. Each week reports its own play. */
    const after = allMatches.filter(m =>
      m.playlist === f.playlist &&
      m.day >= wk.from && m.day <= wk.to &&
      Date.parse(m.at) > Date.parse(f.setAt) &&
      (f.until === null || Date.parse(m.at) <= Date.parse(f.until)) &&
      Number.isFinite(m.metrics[f.metricId] && m.metrics[f.metricId].v));
    // The focus belongs in this week's report if it was set in the week, or if
    // matches played in the week were measured against it.
    const setDay = playDay(f.setAt);
    const touchesWeek = (setDay >= wk.from && setDay <= wk.to) || after.length > 0;
    if (!touchesWeek) continue;

    const vals = after.map(m => m.metrics[f.metricId].v);
    const n = vals.length;
    const afterAvg = n ? avg(vals) : null;
    const dir = f.direction;
    let verdict, verdictText;
    if (n < PROOF_MIN_MATCHES){
      verdict = 'ikke målbart';
      verdictText = EN()
        ? (n === 0
          ? 'No matches in ' + f.playlist + ' this week after the focus was set — nothing to measure.'
          : 'Only ' + n + ' match' + (n === 1 ? '' : 'es') + ' in ' + f.playlist + ' this week after the focus — too little for a verdict (requires ' + PROOF_MIN_MATCHES + ').')
        : (n === 0
          ? 'Ingen kampe i ' + f.playlist + ' i denne uge efter fokus blev sat — intet at måle på.'
          : 'Kun ' + n + ' kamp' + (n === 1 ? '' : 'e') + ' i ' + f.playlist + ' i denne uge efter fokus — for lidt til en dom (kræver ' + PROOF_MIN_MATCHES + ').');
    } else {
      const reached = dir > 0 ? afterAvg >= f.target : afterAvg <= f.target;
      const gap = f.triggerValue !== null ? (f.target - f.triggerValue) * dir : null;
      const moved = f.triggerValue !== null ? (afterAvg - f.triggerValue) * dir : null;
      const progress = gap !== null && Math.abs(gap) > 1e-9 ? moved / gap : null;
      if (reached) verdict = 'opnået';
      else if (progress !== null && progress >= 0.25) verdict = 'på vej';
      else if (progress !== null && progress < 0) verdict = 'tilbagegang';
      else verdict = 'ikke rykket';
      verdictText = EN()
        ? cap(f.label) + ' in ' + f.playlist + ': ' + M.fmt(f.metricId, afterAvg) + ' across ' + n + ' matches in the week after the focus'
          + (f.triggerValue !== null ? ' (triggered at ' + M.fmt(f.metricId, f.triggerValue) + ')' : '')
          + ' — target ' + f.targetText + '. '
          + (verdict === 'opnået' ? 'The target was reached.'
            : verdict === 'på vej' ? 'The movement goes the right way; the target is still ahead.'
            : verdict === 'tilbagegang' ? 'The number went the wrong way.'
            : 'The number stands still.')
        : cap(f.label) + ' i ' + f.playlist + ': ' + M.fmt(f.metricId, afterAvg) + ' over ' + n + ' kampe i ugen efter fokus'
          + (f.triggerValue !== null ? ' (udløst ved ' + M.fmt(f.metricId, f.triggerValue) + ')' : '')
          + ' — mål ' + f.targetText + '. '
          + (verdict === 'opnået' ? 'Målet er nået.'
            : verdict === 'på vej' ? 'Bevægelsen går den rigtige vej, målet er ikke nået endnu.'
            : verdict === 'tilbagegang' ? 'Tallet gik den forkerte vej.'
            : 'Tallet står stille.');
    }
    rows.push({
      metricId: f.metricId, playlist: f.playlist, label: f.label, direction: dir,
      setAt: f.setAt, sessions: f.sessions, sessionUrl: f.sessionUrl,
      source: f.source || 'session', weekKey: f.weekKey || null,
      target: f.target, targetText: f.targetText, triggerValue: f.triggerValue,
      n, afterAvg, verdict, verdictShown: verdictShown(verdict), verdictText
    });
  }
  return rows;
}

/* ---------------- pack + mission picking ---------------- */

/* Erstatningens tillaeg til begrundelsen (8/9): hvad den erstatter, og vinduet
 * ("baner paa Champion-niveau (±1)"). Tom for bankens egne baner. */
function subReason(p, info, en){
  if (!p || !p.substitute) return '';
  const f = p.substitute.for;
  const tiers = f && f.tiers && f.tiers.length ? (f.tiers.length > 1 ? f.tiers[0] + '–' + f.tiers[f.tiers.length - 1] : f.tiers[0]) : null;
  return en
    ? ' Replaces ' + (f ? f.name + (tiers ? ' (' + tiers + ' pack)' : '') : "the bank's pack") + ': ' + info.short.en + '.'
    : ' Erstatter ' + (f ? f.name + (tiers ? ' (' + tiers + '-bane)' : '') : 'bankens bane') + ': ' + info.short.da + '.';
}

/* Kortets form for en bank-bane eller dens erstatning (difficulty/substitute
 * kun paa erstatninger, saa aeldre rapporter og ejerens er uaendrede). */
function packCard(p, extra){
  const o = Object.assign({ id: p.id, name: p.name, code: p.code, source: p.source }, extra || {});
  if (p.difficulty) o.difficulty = p.difficulty;
  if (p.substitute) o.substitute = p.substitute;
  return o;
}

/* One primary pack, justified by a measured number, plus the warm-up (the
 * player measured its effect himself) and at most one goal-based pack.
 * Tier (8/9, tier.js): hver bank-bane skal passe spillerens vindue [tier-1,
 * tier+1]; ellers svarer en Prejump-bane med SAMME behov paa hans niveau
 * (packs.NEEDS). Ejeren (Silver) faar praecis de baner han fik foer. */
function pickPacks(trends, signals, lastPrimary, info){
  const tierInfo = info || T.DEFAULT_INFO;
  const cands = [];
  const taken = () => new Set(cands.map(c => c.code));
  const fitOrSub = (p, need) => packs.fitOrSubstitute(p, need, tierInfo, { exclude: taken() });
  const mature = trends.filter(t => t.mature && t.goodness !== null && t.goodness < 0)
    .sort((a, b) => a.goodness - b.goodness);
  const en = EN();
  for (const t of mature){
    for (const p0 of packs.forMetric(t.id)){
      const p = fitOrSub(p0, t.id);
      if (!p || cands.some(c => c.id === p.id)) continue;
      cands.push({ ...p, score: -t.goodness,
        reason: (en
          ? cap(t.label) + ' in ' + t.playlist + ': ' + M.fmt(t.id, t.weekAvg) + ' on average this week against your normal '
            + M.fmt(t.id, t.normStart) + ' (' + pctS(t.deltaPct) + ') — ' + (p.whatEn || p.what) + '.'
          : cap(t.label) + ' i ' + t.playlist + ': ' + M.fmt(t.id, t.weekAvg) + ' i snit i ugen mod normalt '
            + M.fmt(t.id, t.normStart) + ' (' + pctS(t.deltaPct) + ') — ' + p.what + '.') + subReason(p, tierInfo, en) });
    }
  }
  if (signals.conversion !== null && signals.shots >= 10 && signals.conversion <= 0.30)
    for (const p0 of packs.forSignal('conversion')){
      const p = fitOrSub(p0, 'conversion');
      if (!p || cands.some(c => c.id === p.id)) continue;
      cands.push({ ...p, score: 0.32 - signals.conversion,
        reason: (en
          ? signals.goals + ' goals on ' + signals.shots + ' shots this week ('
            + Math.round(signals.conversion * 100) + '%) — ' + (p.whatEn || p.what) + '.'
          : signals.goals + ' mål på ' + signals.shots + ' skud i ugen ('
            + Math.round(signals.conversion * 100) + '%) — ' + p.what + '.') + subReason(p, tierInfo, en) });
    }
  if (signals.earlyConceded >= 3)
    for (const p0 of packs.forSignal('earlyConceded')){
      const p = fitOrSub(p0, 'earlyConceded');
      if (!p || cands.some(c => c.id === p.id)) continue;
      cands.push({ ...p, score: signals.earlyConceded * 0.03,
        reason: (en
          ? signals.earlyConceded + ' goals conceded in the first minute of a match this week — ' + (p.whatEn || p.what) + '.'
          : signals.earlyConceded + ' mål indkasseret i kampens første minut i ugen — ' + p.what + '.') + subReason(p, tierInfo, en) });
    }
  cands.sort((a, b) => b.score - a.score);

  // rotation: the same primary two weeks running reads as a stuck record
  if (cands.length > 1 && cands[0].code === lastPrimary){ const t = cands[0]; cands[0] = cands[1]; cands[1] = t; }

  const out = cands.slice(0, 2).map(p => packCard(p, { reason: p.reason }));
  // opvarmningen: bankens naar den passer vinduet, ellers en Prejump-Warmup-bane
  // paa spillerens niveau — ejerens maaling 27/7 gaelder KUN ejerens egen bane
  const warm0 = packs.byId('ultimate_warmup');
  const warm = packs.fitOrSubstitute(warm0, 'warmup', tierInfo, { exclude: new Set(out.map(p => p.code)) });
  if (warm && !out.some(p => p.code === warm.code))
    out.push(packCard(warm, { reason: warm.substitute
      ? (en
        ? 'Warm-up before queueing — ' + (warm.whatEn || warm.what) + '.'
        : 'Opvarmning før kø — ' + warm.what + '.') + subReason(warm, tierInfo, en)
      : (en
        ? 'Warm-up before queueing: you measured the effect yourself on 27/7 — one hour in the training packs, and a rank-up in both 2v2 and 1v1 the same evening.'
        : 'Opvarmning før kø: du målte selv effekten 27/7 — en time i træningsbanerne, og rank-up i både 2v2 og 1v1 samme aften.') }));
  // maal-banen: ejerens erklaerede aerial-maal, aldrig en maaling — paa hans niveau
  const aer0 = packs.byId('aerial_shots_pass');
  const aer = packs.fitOrSubstitute(aer0, 'aerials', tierInfo, { exclude: new Set(out.map(p => p.code)) });
  if (aer && !out.some(p => p.code === aer.code))
    out.push(packCard(aer, { goalOnly: true,
      reason: (en
        ? 'Your own goal, never a measurement: the tracker measures nothing about aerials (the feed has no height or air data), so this one is here because you said you want to learn it — ' + (aer.whatEn || aer.what) + '.'
        : 'Dit eget mål, ikke en måling: trackeren måler intet om aerials (feedet har ingen højde eller luftdata), så denne står her fordi du har sagt du vil lære det — ' + aer.what + '.') + subReason(aer, tierInfo, en) }));
  return out;
}

/* ---------------- baneradar (RADAR-DESIGN.md §5/§6, trin C2, 7/9-2026) ----------------
 *
 * Ugens skudsteder: pitch.contributionsFor over ugens kampfiler (de samme
 * raekker matchesInWeek allerede har fundet — private lobbyer og mutator-
 * kampe gaar med ind og holdes ude af pitch.js selv, talt i `excluded`),
 * foldet, profileret med uge-gaten, og ET forsvarsvalg + HOEJST eet
 * angrebsvalg fra radar.js. Motoren ejer alle tal; teksten er radar.reason.
 * Langtiden (hele arkivet) bruges kun som tie-break og som "langtidsandel"
 * i tabellen. Fejler noget herinde, staar ugerapporten uden radar — aldrig
 * uden rapport (samme regel som stemmen). */

/* pack-positions.json + katalogerne laeses EEN gang pr. proces: et byg kan
 * mangle filen (§4a — data maa ikke i kilde-spejlet foer licensen er afklaret),
 * og saa er puljen tag-niveauet alene. */
let radarPosCache = null;
function radarPositions(){
  if (radarPosCache) return radarPosCache;
  let positions = {}, source = null;
  try{
    const readJ = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    const raw = readJ('pack-positions.json');
    const cats = [];
    for (const f of ['pack-catalog-prejump.json', 'pack-catalog.json', 'pack-catalog-variety.json']){ try{ cats.push(readJ(f)); }catch{} }
    positions = radar.packZones(raw, cats) || {};
    const first = raw[Object.keys(raw)[0]];
    if (first && first.source && first.source.repo) source = { repo: String(first.source.repo), fetched: first.source.fetched || null };
  }catch{ positions = {}; source = null; }
  radarPosCache = { positions, source };
  return radarPosCache;
}
/* Puljerne for EEN rapport (8/9): positions + bank filtreret til spillerens vindue,
 * og Prejump-erstatninger for de bank-baner vinduet tog (packs.substitutesForZone). */
function radarPools(info){
  const positions = radarPositions().positions;
  return zone => radar.poolFor(zone, { positions, bank: packs.BANK, tier: info,
    substitute: (z, n, ex) => packs.substitutesForZone(z, info, { count: n, exclude: ex }) });
}

/* Ejeren i pitch.js' forstand: den sporede spiller i rodens profil (i
 * gaestetilstand er roden gaestens egen mappe, saa det er stadig "ham"). */
function radarOwner(){
  try{
    const prof = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8'));
    return { pid: prof.trackedPid || '', name: prof.trackedName || '' };
  }catch{ return { pid: '', name: '' }; }
}

/* Kilden for en radar-bane: BANK-posten naar koden er der (tag-niveauet), ellers
 * positions-importens repo. Aldrig opfundet — mangler begge, ingen kildelinje. */
function radarSource(pack){
  if (pack && pack.source) return pack.source;   // en Prejump-erstatning baerer sin egen kilde (8/9)
  const bankP = packs.BANK.find(b => b.code === pack.code);
  if (bankP && bankP.source) return bankP.source;
  const src = radarPositions().source;
  if (pack.confidence === 'positions' && src && src.repo)
    return { title: src.repo + (EN() ? ' (measured shot positions' : ' (målte skudpositioner') + (src.fetched ? (EN() ? ', fetched ' : ', hentet ') + src.fetched : '') + ')',
             url: 'https://github.com/' + src.repo };
  return null;
}

function radarPackEntry(pick){
  const lang = EN() ? 'en' : 'da';
  const e = { id: pick.pack.id, name: pick.pack.name, code: pick.pack.code,
              reason: radar.reason(pick, lang), source: radarSource(pick.pack),
              radar: true, family: pick.family, zone: pick.zone, confidence: pick.pack.confidence };
  if (pick.pack.difficulty) e.difficulty = pick.pack.difficulty;   // Prejump-erstatning (8/9)
  if (pick.pack.substitute) e.substitute = pick.pack.substitute;
  return e;
}

/* Ugens radar: {radar, entries}. `rows` er matchesInWeek-raekkerne (alle,
 * ogsaa private). */
function buildRadar(wk, rows, info){
  const owner = radarOwner();
  const dir = path.join(ROOT, 'matches');
  const files = rows.map(r => r.file).filter(Boolean).sort();
  const fold = pitch.foldEntries(pitch.contributionsFor(dir, files, owner));
  const agg = pitch.aggregate(dir, owner);
  const longRun = radar.profile(agg.concededFrom, radar.WEEK_GATE);
  const longOff = radar.offenseProfile(agg.scoredFrom, agg.mineZones, { window: 'week' });
  const prof = radar.profile(fold.concededFrom, Object.assign({}, radar.WEEK_GATE, { week: wk.week }));
  const off = radar.offenseProfile(fold.scoredFrom, fold.mineZones, { window: 'week', week: wk.week });
  const pools = radarPools(info || T.DEFAULT_INFO);
  // rotation over ugerapporternes egen historik (pack/shown/radar), kontrakten §5
  const ctx = { pools, history: state.packHistory };
  const pick = radar.pickDefensive(prof, longRun, ctx);
  const whyDef = pick ? null : radar.whyNoPick(prof, longRun, ctx);
  // angrebet maa ikke lande paa forsvarets bane (en positions-bane kan daekke baade D og O)
  const ctxO = pick ? { pools: z => pools(z).filter(p => p.code !== pick.pack.code), history: state.packHistory } : ctx;
  const pickO = radar.pickOffensive(off, ctxO);
  const whyOff = pickO ? null : radar.whyNoPick(off, null, ctxO);

  const zones = {};
  for (const z of Object.keys(prof.zones))
    zones[z] = { n: prof.zones[z].n, share: prof.zones[z].share,
                 longShare: longRun.zones[z] ? longRun.zones[z].share : null, longN: longRun.zones[z] ? longRun.zones[z].n : null };
  const offZones = {};
  for (const z of Object.keys(off.zones))
    offZones[z] = Object.assign({}, off.zones[z], { longPer100: longOff.zones[z] ? longOff.zones[z].per100 : null });
  // markeret = VALGETS zone (pick.zone), aldrig profilens dominerende: ved
  // lighed kan tie-break/rotation have valgt en anden zone end den foerste
  const marked = {
    def: pick ? { zone: pick.zone, n: pick.counts.zoneN, located: pick.counts.located, share: pick.counts.share,
                  longShare: zones[pick.zone].longShare, label: radar.zoneLabel(pick.zone) } : null,
    off: pickO ? { zone: pickO.zone, goals: pickO.counts.goals, touches: pickO.counts.touches, per100: pickO.counts.per100,
                   frontPer100: pickO.counts.frontPer100, label: radar.zoneLabel(pickO.zone) } : null
  };
  const entries = [];
  if (pick) entries.push(radarPackEntry(pick));
  if (pickO) entries.push(radarPackEntry(pickO));
  return {
    radar: {
      window: 'week', key: wk.key, week: wk.week, matches: fold.matches, files: files.length,
      conceded: { n: prof.n, located: prof.located, noX: prof.noX, noZ: prof.noZ, ko: prof.ko, zones, dominant: prof.dominant, gate: prof.gate },
      offense: { n: off.n, located: off.located, noX: off.noX, ko: off.ko, zones: offZones, front: off.front, weak: off.weak, gate: off.gate },
      longRun: { matches: agg.matches, n: longRun.n, located: longRun.located, front: longOff.front },
      marked, excluded: fold.excluded, unbound: fold.unbound,
      gate: { ok: prof.gate.ok, reason: prof.gate.reason },
      // radar.pickDefensive/pickOffensive-formen: {family, zone, pack:{id,name,code,confidence}, counts, reason:{da,en}}
      picks: { def: pick, off: pickO },
      why: { def: whyDef, off: whyOff },
      orientationVerified: radar.ORIENTATION_VERIFIED
    },
    entries
  };
}

/* Radar-banerne ind i listen (§5): forsvaret paa plads 2 efter den primaere
 * maalte kobling — plads 1 kun naar ingen maalt bane er valgt — og angrebet
 * lige efter forsvaret; begge foer opvarmningen og maal-banen. Staar samme
 * kode allerede som MAALT bane (fx Saves via earlyConceded-signalet), vises
 * den EEN gang: den maalte kobling beholder pladsen, og radar-begrundelsen
 * rider med paa den. Er dubletten maal-banen (aerial-oensket, goalOnly),
 * rykker radar-kortet op i dens sted: radaren HAR maalt noget om den, saa
 * maal-kortets "trackeren maaler intet" er ikke sandt laengere og maa IKKE
 * genbruges (det ville modsige radar-begrundelsen paa samme kort, og §5
 * forbyder aerial-ordet paa et radar-kort). Oensket staar som EEN kort
 * linje uden maale-paastand (`goalReason`). */
function placeRadarPacks(packList, entries){
  const out = packList.slice();
  const firstNonMeasured = () => { const i = out.findIndex(p => p.radar || p.id === 'ultimate_warmup' || p.goalOnly); return i < 0 ? out.length : i; };
  let after = -1;   // indekset for det seneste radar-kort: angrebet foelger forsvaret
  for (const e of entries){
    const di = out.findIndex(p => p.code === e.code);
    if (di >= 0 && !out[di].goalOnly){
      Object.assign(out[di], { radar: true, family: e.family, zone: e.zone, confidence: e.confidence, radarReason: e.reason });
      after = di;
      continue;
    }
    if (di >= 0){
      e.goalReason = EN() ? 'Also your own wish: you said you want to learn this one.' : 'Står også som dit eget ønske: du har sagt du vil lære den.';
      if (!e.source) e.source = out[di].source;
      out.splice(di, 1);
    }
    const at = after >= 0 ? after + 1 : Math.min(1, firstNonMeasured());
    out.splice(at, 0, e);
    after = at;
  }
  return out;
}

/* ---------------- report ---------------- */

function buildReport(wk, opts){
  const { debriefs, sessions, weeklies } = loadReports();
  const allInWeek = matchesInWeek(debriefs, wk);
  if (!allInWeek.length) return null;
  // `ms` is what the week MEASURES; private lobbies are listed, never counted
  const ms = allInWeek.filter(r => !r.private);
  const privateMs = allInWeek.filter(r => r.private);

  const prevKeyDate = new Date(Date.parse(wk.from + 'T12:00:00') - 7 * 86400e3);
  const prevWk = isoWeekOf(prevKeyDate.getFullYear() + '-' + p2(prevKeyDate.getMonth() + 1) + '-' + p2(prevKeyDate.getDate()));
  const prevMs = matchesInWeek(debriefs, prevWk).filter(r => !r.private);

  const wl = { w: 0, l: 0, u: 0 };
  const playlists = {}, days = {};
  let goals = 0, shots = 0, touches = 0, saves = 0, assists = 0;
  for (const r of ms){
    if (r.result === 'W') wl.w++; else if (r.result === 'L') wl.l++; else wl.u++;
    const pl = playlists[r.playlist] || (playlists[r.playlist] = { w: 0, l: 0, u: 0, goals: 0, shots: 0, n: 0 });
    if (r.result === 'W') pl.w++; else if (r.result === 'L') pl.l++; else pl.u++;
    pl.goals += r.me.goals | 0; pl.shots += r.me.shots | 0; pl.n++;
    const d = days[r.day] || (days[r.day] = { day: r.day, n: 0, w: 0, l: 0 });
    d.n++; if (r.result === 'W') d.w++; else if (r.result === 'L') d.l++;
    goals += r.me.goals | 0; shots += r.me.shots | 0; touches += r.me.touches | 0;
    saves += r.me.saves | 0; assists += r.me.assists | 0;
  }
  for (const k of Object.keys(playlists))
    playlists[k].conversion = playlists[k].shots ? playlists[k].goals / playlists[k].shots : null;
  const conversion = shots ? goals / shots : null;

  /* The distribution behind the size labels (17/8): "3v3: 8 ranked · 3
   * turnering · 2 rumble · 50 uden playlist-id". Counted on what the game said
   * (row.kind), never on the bucket — a 3v3 tournament folded into '3v3' before
   * the split still counts as a tournament here, and an id-less match is
   * listed as exactly that. Private lobbies are not in `ms` and keep their own
   * chip. `coverage` is the transition meter: how much of each stored normal
   * rests on id-stamped matches today (profile.playlists[key].idWeight). */
  const modes = {};
  for (const r of ms){
    const s = modes[r.size] || (modes[r.size] = { n: 0, kinds: {} });
    s.n++; s.kinds[r.kind] = (s.kinds[r.kind] | 0) + 1;
  }
  const coverage = {};
  try{
    const prof = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8'));
    for (const k of Object.keys(prof.playlists || {})){
      const p = prof.playlists[k];
      if (!p || typeof p !== 'object') continue;
      coverage[k] = { n: p.n | 0, idWeight: Number.isFinite(p.idWeight) ? p.idWeight : 0, kinds: p.kinds || {} };
    }
  }catch{}

  /* Week extremes for the Weekly panel — aggregated from the metric engine's
   * own per-match values, never recomputed here. Distance recovers each match's
   * engine total (dist_per_touch × touches) and is only reported when EVERY
   * match in the week carries the metric — a partial sum shown as "the week's
   * distance" would be a wrong number with a confident face. */
  // Unlimited boost (6/9): those matches carry no speed or distance at all —
  // not a partial sum, a different sport — so the week's extremes are read
  // over the matches that could be measured, and the chip says how many
  // could not.
  const mutatorMs = ms.filter(r => r.mutators && r.mutators.length);
  const measurable = ms.filter(r => !(r.mutators && r.mutators.length));
  let topSpeed = null, hardestHit = null, distSum = 0,
      distComplete = measurable.length > 0 && M.UNITS[M.currentUnit()] && M.UNITS[M.currentUnit()].dist === 'm';
  for (const r of measurable){
    const sp = r.metrics.speed_max, hp = r.metrics.hit_power_max, dt = r.metrics.dist_per_touch;
    if (sp && (topSpeed === null || sp.v > topSpeed)) topSpeed = sp.v;
    if (hp && (hardestHit === null || hp.v > hardestHit)) hardestHit = hp.v;
    if (dt && (r.me.touches | 0) > 0) distSum += dt.v * (r.me.touches | 0);
    else distComplete = false;
  }
  const extremes = {
    topSpeedText:   topSpeed === null   ? null : M.fmt('speed_max', topSpeed),
    topSpeedUnit:   topSpeed === null   ? null : M.unitFor('speed_max'),
    hardestHitText: hardestHit === null ? null : M.fmt('hit_power_max', hardestHit),
    hardestHitLabel: M.DEFS.hit_power_max ? M.DEFS.hit_power_max.label : 'hårdeste touch',
    distanceText:   distComplete ? (distSum >= 10000
                      ? (Math.round(distSum / 100) / 10) + ' km'
                      : Math.round(distSum) + ' m') : null
  };

  const trends = buildTrends(ms, prevMs);
  const ranked = trends.filter(t => t.goodness !== null && t.mature).sort((a, b) => a.goodness - b.goodness);
  const key = t => t.playlist + '|' + t.id;
  const weakest = ranked.filter(t => t.goodness < 0).slice(0, 2).map(key);
  const strongest = ranked.filter(t => t.goodness > 0).slice(-2).reverse().map(key);
  const byKey = {}; for (const t of trends) byKey[key(t)] = t;

  // sessions that belong to the week, with their own tilt verdicts
  // by when he PLAYED, not when the report was generated: a session that ended
  // at 04:58 Monday is Sunday's play (see DAY_START_HOUR)
  const weekSessions = sessions.filter(s => { const d = playDay(s.startedAt || s.at); return d && d >= wk.from && d <= wk.to; });
  let earlyConceded = 0, lateOwn = 0, stops = 0;
  for (const s of weekSessions){
    earlyConceded += (s.tilt && s.tilt.earlyConceded) | 0;
    lateOwn += (s.tilt && s.tilt.lateOwn) | 0;
    if (s.tilt && s.tilt.stop) stops++;
  }

  // Only weeklies that CLOSED before this week's end may have moved the card
  // inside it; the report being built (if it is a rebuild) is not an input to
  // its own proof — the same "no week folded into its own baseline" rule.
  const priorWeeklies = (weeklies || []).filter(w => w.key < wk.key);
  const timeline = focusTimeline(sessions, priorWeeklies);
  // a private lobby can neither prove nor disprove a focus — it was never a
  // measurement against the player's normal
  const allMatches = matchesInWeek(debriefs, { from: '0000-00-00', to: '9999-99-99' }).filter(r => !r.private);
  const proof = proofFor(timeline, allMatches, wk);

  const signals = { conversion, goals, shots, earlyConceded };
  const lastPrimary = state.packHistory.length ? state.packHistory[state.packHistory.length - 1].pack : null;
  // spillerens tier (8/9): ugerapporten er ejerens, saa hans kurve taeller med;
  // ukendt → Silver, og rapporten siger det (report.tier)
  const tierInfo = T.load(ROOT, radarOwner().pid, { history: true });
  let packList = pickPacks(trends, signals, lastPrimary, tierInfo);

  // baneradaren (7/9): ugens skudsteder → een forsvarsbane + hoejst een angrebsbane
  let radarSec = null;
  try{
    const rr = buildRadar(wk, allInWeek, tierInfo);
    radarSec = rr.radar;
    packList = placeRadarPacks(packList, rr.entries);
  }catch(e){ log('[weekly] radar fejlede (rapporten staar uden): ' + (e && e.message || e)); radarSec = null; }

  // next week's focus: the worst mature trend, aiming at the player's own normal.
  // Not just printed: once this report is closed, focus.pick() puts it on the
  // board as the week's opening focus (17/8) — so it carries the numbers the
  // card and the proof row need as DATA, not only in the sentence.
  const worst = ranked.filter(t => t.goodness < 0)[0] || null;
  const focusNext = worst ? {
    metricId: worst.id, playlist: worst.playlist, label: worst.label, direction: worst.direction,
    target: worst.normStart, targetText: (worst.direction > 0 ? '≥ ' : '≤ ') + M.fmt(worst.id, worst.normStart),
    weekAvg: worst.weekAvg, n: worst.n, baselineN: worst.baselineN,
    headline: cap(worst.label) + ' ' + (worst.direction > 0 ? '≥ ' : '≤ ') + M.fmt(worst.id, worst.normStart) + ' (' + worst.playlist + ')',
    why: EN()
       ? 'The week\'s average: ' + M.fmt(worst.id, worst.weekAvg) + ' against your normal ' + M.fmt(worst.id, worst.normStart)
         + ' in ' + worst.playlist + ' across ' + worst.n + ' matches.'
       : 'Ugens snit: ' + M.fmt(worst.id, worst.weekAvg) + ' mod normalt ' + M.fmt(worst.id, worst.normStart)
         + ' i ' + worst.playlist + ' over ' + worst.n + ' kampe.',
    // a guide's own words on the focus metric (19/8) — seeded by the week, so
    // a rebuilt report shows the same quote. Decoration: focus.fromWeekly()
    // reads none of it, and a report without it is still a complete report.
    guide: persona.guideFor(worst.id, wk.key + '|' + worst.id)
  } : null;

  const missions = [];
  for (const t of ranked.filter(t => t.goodness < 0).slice(0, 3))
    missions.push({ id: t.id, playlist: t.playlist,
      text: EN()
        ? cap(t.label) + ' ' + (t.direction > 0 ? '≥' : '≤') + ' ' + M.fmt(t.id, t.normStart)
          + ' in ' + t.playlist + ' (this week: ' + M.fmt(t.id, t.weekAvg) + ' across ' + t.n + ' matches)'
        : cap(t.label) + ' ' + (t.direction > 0 ? '≥' : '≤') + ' ' + M.fmt(t.id, t.normStart)
          + ' i ' + t.playlist + ' (ugen: ' + M.fmt(t.id, t.weekAvg) + ' over ' + t.n + ' kampe)' });

  const rank = rankSection(wk.from, wk.to);
  const dayList = Object.values(days).sort((a, b) => a.day < b.day ? -1 : 1);

  // headline + the three SSE lines
  const strongT = strongest.length ? byKey[strongest[0]] : null;
  const weakT = weakest.length ? byKey[weakest[0]] : null;
  const proved = proof.filter(p => p.verdict === 'opnået').length;
  const judged = proof.filter(p => p.verdict !== 'ikke målbart').length;
  const headline = EN()
    ? wl.w + 'W-' + wl.l + 'L across ' + ms.length + ' matches'
      + (weakT ? ' — weakest: ' + weakT.label + ' (' + absPct(weakT.goodness) + ' below your normal in ' + weakT.playlist + ')' : '') + '.'
    : wl.w + 'W-' + wl.l + 'L over ' + ms.length + ' kampe'
      + (weakT ? ' — svagest: ' + weakT.label + ' (' + absPct(weakT.goodness) + ' under normalt i ' + weakT.playlist + ')' : '') + '.';
  const lines = EN()
    ? [
      'Week ' + wk.week + ': ' + ms.length + ' matches on ' + dayList.length + (dayList.length === 1 ? ' day, ' : ' days, ') + wl.w + 'W-' + wl.l + 'L'
        + (conversion !== null ? ' · ' + goals + ' goals on ' + shots + ' shots' : '') + '.',
      strongT || weakT
        ? cap([strongT ? 'strongest: ' + strongT.label + ' (' + absPct(strongT.goodness) + ' above your normal in ' + strongT.playlist + ')' : '',
               weakT ? 'weakest: ' + weakT.label + ' (' + absPct(weakT.goodness) + ' below your normal in ' + weakT.playlist + ')' : '']
          .filter(Boolean).join(' · ')) + '.'
        : 'Baseline still building — the week\'s metric trends wait for your normal to mature.',
      judged
        ? 'Proof: ' + proved + ' of ' + judged + ' judged focuses reached the target.'
        : (proof.length ? 'Proof: too few matches after the week\'s focus for a verdict.' : 'Proof: no focus was set this week.')
    ]
    : [
      'Uge ' + wk.week + ': ' + ms.length + ' kampe på ' + dayList.length + (dayList.length === 1 ? ' dag, ' : ' dage, ') + wl.w + 'W-' + wl.l + 'L'
        + (conversion !== null ? ' · ' + goals + ' mål på ' + shots + ' skud' : '') + '.',
      strongT || weakT
        ? cap([strongT ? 'stærkest: ' + strongT.label + ' (' + absPct(strongT.goodness) + ' over normalt i ' + strongT.playlist + ')' : '',
               weakT ? 'svagest: ' + weakT.label + ' (' + absPct(weakT.goodness) + ' under normalt i ' + weakT.playlist + ')' : '']
          .filter(Boolean).join(' · ')) + '.'
        : 'Baseline under opbygning — ugens metrik-trends venter på at din normal er moden.',
      judged
        ? 'Bevis: ' + proved + ' af ' + judged + ' bedømte fokus nåede målet.'
        : (proof.length ? 'Bevis: for få kampe efter ugens fokus til en dom.' : 'Bevis: intet fokus var sat i denne uge.')
    ];

  let packVersion = null;
  try{ packVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.json'), 'utf8')).packVersion || null; }catch{}
  if (privateMs.length)
    lines[0] = lines[0].replace(/\.$/, '') + (EN()
      ? ' · ' + privateMs.length + ' private lobb' + (privateMs.length === 1 ? 'y' : 'ies') + ' shown, not counted.'
      : ' · ' + privateMs.length + ' privat' + (privateMs.length === 1 ? '' : 'e') + ' lobby' + (privateMs.length === 1 ? '' : 'er') + ' vist, ikke talt.');
  if (mutatorMs.length)
    lines[0] = lines[0].replace(/\.$/, '') + (EN()
      ? ' · ' + mutatorMs.length + ' with unlimited boost — boost, distance and touch power not measured.'
      : ' · ' + mutatorMs.length + ' med ubegrænset boost — boost, afstand og slagkraft ikke målt.');

  const name = 'weekly-' + wk.key;
  return {
    schema: 'weekly/1', packVersion, at: new Date().toISOString(),
    name, key: wk.key, year: wk.year, week: wk.week,
    from: wk.from, to: wk.to, closed: !!(opts && opts.closed),
    url: '/reports/' + name + '.html',
    totals: { matches: ms.length, days: dayList.length, sessions: weekSessions.length,
              wl, goals, shots, assists, saves, touches, conversion,
              private: privateMs.length,
              // counted, but with no boost/movement numbers (6/9)
              mutators: mutatorMs.length },
    // shown, never counted (user's decision 15/8)
    privateMatches: privateMs.map(r => ({ at: r.at, day: r.day, file: r.file, playlist: r.playlist,
      matchType: r.matchType, result: r.result, score: r.score, myTeam: r.myTeam, me: r.me })),
    extremes,
    // what the game said the week's matches were, per size label (17/8) — and
    // how far each stored normal has come in resting on id-stamped matches
    modes, modesText: modesText(modes, EN()), coverage,
    days: dayList, playlists, trends, strongest, weakest, byKeyOrder: Object.keys(byKey),
    proof, rank, focusNext, missions, packs: packList,
    // baneradaren (RADAR-DESIGN.md §6): hvor de scorer paa ham, hvor han sjaeldent scorer fra
    radar: radarSec,
    // spillerens tier og vindue (8/9): hvilket niveau banerne er valgt til, og hvorfra ranken kom
    tier: tierInfo,
    // startedAt, not `at`: `at` is when the report was GENERATED, which for a
    // session that ran past midnight is the next calendar day — a session
    // stamped "27. juli" inside a report titled 20.–26. juli looks like a bug
    // and is not one (the play day is Sunday). Show when he actually played.
    sessionSummaries: weekSessions.map(s => ({ name: s.name, url: s.url, at: s.at,
      startedAt: s.startedAt || s.at, endedAt: s.endedAt || s.at, day: playDay(s.startedAt || s.at),
      matches: s.matches ? s.matches.length : 0, wl: s.wl ? s.wl.w + 'W-' + s.wl.l + 'L' : '',
      headline: s.headline || '', stop: !!(s.tilt && s.tilt.stop) })),
    tilt: { earlyConceded, lateOwn, stops },
    prevWeek: prevMs.length ? { key: prevWk.key, matches: prevMs.length } : null,
    headline, lines,
    narrative: null                       // filled by the voice layer when available
  };
}

/* ---------------- lifecycle ---------------- */

/* Build and store any closed week that has enough matches and no report yet.
 * Called from the minute tick and after every session report, so the weekly
 * lands by itself on the first play of a new week — the user never has to ask
 * for it, which is the whole point of a weekly. */
function ensure(){
  if (!ROOT) return null;
  const { debriefs } = loadReports();
  if (!debriefs.length) return null;
  const cur = currentWeek();
  const weeks = new Map();
  for (const d of debriefs){
    const w = weekOfIso(d.at);
    if (!w || w.key === cur.key) continue;              // the open week is not closed yet
    weeks.set(w.key, w);
  }
  const pending = [...weeks.values()]
    .filter(w => !state.written.includes(w.key))
    .sort((a, b) => a.key < b.key ? -1 : 1);
  let last = null;
  for (const w of pending){
    const r = buildReport(w, { closed: true });
    if (!r || r.totals.matches < MIN_WEEK_MATCHES){
      state.written.push(w.key);                         // too thin to report: remember, don't retry every minute
      save();
      continue;
    }
    if (!write(r)) continue;
    last = r;
  }
  return last;
}

function write(r){
  try{
    fs.mkdirSync(reportsDir(), { recursive: true });
    store.writeJSON(path.join(reportsDir(), r.name + '.json'), r, 1);
    store.writeText(path.join(reportsDir(), r.name + '.html'), renderHTML(r));
  }catch(e){ log('[weekly] rapport-fejl: ' + (e.message || e)); return false; }
  state.lastReport = r;
  if (!state.written.includes(r.key)) state.written.push(r.key);
  if (r.packs && r.packs.length){
    // `pack` = plads 1 (aeldre poster har kun den): den primaere maalte
    // kobling — eller RADAR-koden, naar ugen ingen maalt bane har (saa staar
    // radaren paa plads 1, §5). pickPacks' lastPrimary-bytte laeser den
    // uaendret. `shown` og `radar` er additive (7/9) og foeder radar.js'
    // rotation: aldrig forrige rapports radar-kode, mindst-nyligt-vist i
    // zonens pulje
    const rd = r.packs.find(p => p.radar && p.family === 'def') || r.packs.find(p => p.radar) || null;
    state.packHistory.push({ pack: r.packs[0].code, at: r.at, shown: r.packs.map(p => p.code), radar: rd ? rd.code : null });
  }
  state.packHistory = state.packHistory.slice(-20);
  save();
  log('[weekly] ugerapport klar: ' + r.name + ' — ' + r.headline);
  try{ broadcast({ Event: '_weekly', Data: summary(r) }); }catch{}

  /* The narrative is the one place a whole week gets to be prose. Same contract
   * as the debrief and for the same reason: the report above is finished,
   * stored and linked BEFORE the model is asked anything, so a failure costs a
   * paragraph and never a report. Not awaited — ensure() is called from the
   * minute tick, and a tick must not sit on a network call. */
  try{
    if (voice.ready && voice.ready() && voice.speakWeekly)
      voice.speakWeekly(r)
        .then(n => { if (n){ applyNarrative(r, n); log('[weekly] narrativ skrevet (' + n.model + ', forsøg ' + n.attempt + ')'); } })
        .catch(e => log('[weekly] narrativ-fejl (rapporten står uden): ' + (e && e.message || e)));
  }catch(e){ log('[weekly] narrativ-fejl: ' + (e && e.message || e)); }
  return true;
}

/* Small shape for SSE and the board corner: the page never gets the full
 * report over the wire, only what the corner shows plus the link. */
function summary(r){
  // rank, missions and extremes ride along for the Weekly panel. Guarded with
  // fallbacks: summary() also runs on reports STORED before these fields
  // existed (state.lastReport), and a missing field must read as "not
  // measured", never crash the whole summary.
  const rankByPl = {};
  if (r.rank && r.rank.measured && r.rank.byPlaylist)
    for (const pl of Object.keys(r.rank.byPlaylist)){
      const b = r.rank.byPlaylist[pl];
      if (b && Number.isFinite(b.deltaMmr)) rankByPl[pl] = b.deltaMmr;
    }
  return { schema: 'weekly-summary/1', at: r.at, key: r.key, week: r.week, closed: !!r.closed,
    from: r.from, to: r.to, url: r.closed ? r.url : null,
    totals: { matches: r.totals.matches, days: r.totals.days,
              wl: r.totals.wl.w + '-' + r.totals.wl.l, goals: r.totals.goals, shots: r.totals.shots,
              conversion: r.totals.conversion !== undefined ? r.totals.conversion : null,
              private: r.totals.private | 0,                // shown, not counted
              mutators: r.totals.mutators | 0 },            // counted, boost/distance/touch power not measured (6/9)
    extremes: r.extremes || null,
    // "3v3: 8 ranked · 3 turnering · 50 uden playlist-id" — null on reports
    // stored before the field existed
    modesText: r.modesText || null,
    rankDelta: Object.keys(rankByPl).length ? rankByPl : null,
    missions: Array.isArray(r.missions)
      ? r.missions.map(m => ({ id: m.id, playlist: m.playlist, text: m.text })) : [],
    headline: r.headline, lines: r.lines,
    focusNext: r.focusNext ? { headline: r.focusNext.headline, why: r.focusNext.why } : null,
    // baneradaren til boardet (7/9): de markerede zoner + valgene; null paa
    // rapporter gemt foer feltet fandtes
    radar: r.radar ? {
      key: r.radar.key, marked: r.radar.marked, gate: r.radar.gate,
      excluded: r.radar.excluded, unbound: r.radar.unbound,
      picks: { def: r.radar.picks && r.radar.picks.def ? { code: r.radar.picks.def.pack.code, name: r.radar.picks.def.pack.name, zone: r.radar.picks.def.zone, confidence: r.radar.picks.def.pack.confidence } : null,
               off: r.radar.picks && r.radar.picks.off ? { code: r.radar.picks.off.pack.code, name: r.radar.picks.off.pack.name, zone: r.radar.picks.off.zone, confidence: r.radar.picks.off.pack.confidence } : null },
      why: r.radar.why || null, orientationVerified: !!r.radar.orientationVerified } : null,
    proof: r.proof.map(p => ({ label: p.label, playlist: p.playlist, verdict: p.verdict,
                               verdictShown: p.verdictShown || verdictShown(p.verdict),
                               afterText: p.afterAvg === null ? null : M.fmt(p.metricId, p.afterAvg),
                               targetText: p.targetText })),
    trends: r.trends.filter(t => t.mature && t.goodness !== null)
      .sort((a, b) => b.goodness - a.goodness)
      .map(t => ({ id: t.id, label: t.label, playlist: t.playlist, n: t.n,
                   valueText: M.fmt(t.id, t.weekAvg), normalText: t.normStart === null ? null : M.fmt(t.id, t.normStart),
                   deltaPct: t.deltaPct, better: t.goodness > 0 })),
    narrative: r.narrative || null };
}

/* The week in progress — for the board corner. Never written to disk: it would
 * be a report that is wrong five minutes later. */
function current(){
  if (!ROOT) return null;
  try{
    const r = buildReport(currentWeek(), { closed: false });
    return r ? summary(r) : null;
  }catch(e){ log('[weekly] kunne ikke bygge ugens status: ' + (e.message || e)); return null; }
}

function latest(){ return (state && state.lastReport) || null; }
function latestSummary(){ const r = latest(); return r ? summary(r) : null; }

/* Attach a voiced narrative to the stored report (same contract as the debrief:
 * the deterministic report exists first and stays if anything fails). */
function applyNarrative(r, narrative){
  r.narrative = narrative;
  try{
    store.writeJSON(path.join(reportsDir(), r.name + '.json'), r, 1);
    store.writeText(path.join(reportsDir(), r.name + '.html'), renderHTML(r));
  }catch(e){ log('[weekly] kunne ikke gemme narrativ: ' + (e.message || e)); return; }
  if (state.lastReport && state.lastReport.key === r.key) state.lastReport = r;
  save();
  try{ broadcast({ Event: '_weekly', Data: summary(r) }); }catch{}
}

/* ---------------- HTML ---------------- */

function esc(s){
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
/* i18n (26/8): rapportens RAMME foelger motorens sprog, praecis som resten af
 * appen — W34 beviste at engelsk motor + dansk ramme foeder blandede rapporter.
 * Engine-foedt indhold (missioner, verdictText, headlines) er allerede paa
 * motorens sprog naar det gemmes; her oversaettes kun rammen ved render.
 * Verdict-tokens i DATA forbliver danske kanoniske vaerdier ('opnået' osv.,
 * jf. bevisOpsamling-laeren 17/8) — EN er alene et visningslag. */
/* EN()/VERDICT_EN/verdictShown findes allerede oeverst i filen (panelet) —
 * her genbruges de; kun dato-hjaelperne er nye. */
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WD_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function vlabel(v, en){ return en ? (VERDICT_EN[v] || v) : v; }

function danishDay(day, en){
  const [y, m, d] = day.split('-').map(Number);
  return en ? d + ' ' + MONTHS_EN[m - 1] : d + '. ' + MONTHS[m - 1];
}
function danishDate(iso, en){
  const d = new Date(iso);
  return en ? d.getDate() + ' ' + MONTHS_EN[d.getMonth()] + ' ' + d.getFullYear()
            : d.getDate() + '. ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}
function hhmm(iso){ const d = new Date(iso); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
const WD = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
function weekdayOf(day, en){
  const [y, m, d] = day.split('-').map(Number);
  return (en ? WD_EN : WD)[(new Date(y, m - 1, d).getDay() + 6) % 7];
}

const VERDICT_CLASS = { 'opnået': 'v-good', 'på vej': 'v-part', 'ikke rykket': 'v-bad', 'tilbagegang': 'v-bad', 'ikke målbart': 'v-none' };

function renderHTML(r){
  const en = M.currentLanguage && M.currentLanguage() === 'en';
  const EN = !!en;                 // lokal konstant; skygger bevidst fil-hjaelperen EN()
  const t = r.totals;
  const chips = [
    t.matches + (EN ? ' matches' : ' kampe'),
    t.wl.w + 'W–' + t.wl.l + 'L' + (t.wl.u ? '–' + t.wl.u + '?' : ''),
    t.days + (EN ? ' play days' : ' spilledage'),
    t.sessions + (EN ? ' sessions' : ' sessioner'),
    t.goals + (EN ? ' goals / ' : ' mål / ') + t.shots + (EN ? ' shots' : ' skud') + (t.conversion !== null ? ' · ' + Math.round(t.conversion * 100) + '%' : '')
  ].concat(t.private ? [EN
      ? t.private + ' private ' + (t.private === 1 ? 'lobby' : 'lobbies') + ' (not counted)'
      : t.private + ' privat' + (t.private === 1 ? '' : 'e') + ' lobby' + (t.private === 1 ? '' : 'er') + ' (ikke talt)'] : [])
   .concat(t.mutators ? [t.mutators + ' × ' + M.mutatorLabel(['unlimited_boost'], EN)] : [])
   .map(c => '<span class="chip">' + esc(c) + '</span>').join('');
  // Unlimited boost (6/9): named where the numbers are, not hidden
  const mutNote = t.mutators
    ? '<p class="muted" style="font-size:12.5px">' + (EN
      ? t.mutators + (t.mutators === 1 ? ' match' : ' matches') + ' this week ran with <strong>unlimited boost</strong> (mutator): boost, distance and touch power are not measured for ' + (t.mutators === 1 ? 'it' : 'them') + ' — with the boost pinned at 100 the car is always at full speed, so a hard touch is the mutator’s — and enter neither trends, evidence, extremes nor your normal. W/L, goals, first touches on kickoffs, touches and demos count as usual.'
      : t.mutators + (t.mutators === 1 ? ' kamp' : ' kampe') + ' i ugen kørte med <strong>ubegrænset boost</strong> (mutator): boost, afstand og slagkraft er ikke målt for ' + (t.mutators === 1 ? 'den' : 'dem') + ' — med boosten låst på 100 kører bilen altid i fuld fart, så et hårdt touch er mutatorens — og indgår hverken i trends, bevis, ekstremer eller din normal. W/L, mål, førstetouch på kickoffs, touches og demoer tæller som normalt.') + '</p>'
    : '';
  const privRows = (r.privateMatches || []).map(m => {
    const s = Array.isArray(m.score) ? m.score : [0, 0];
    const my = m.myTeam === 1 ? s[1] + '–' + s[0] : s[0] + '–' + s[1];
    return '<tr><td>' + esc(weekdayOf(m.day, EN) + ' ' + danishDay(m.day, EN)) + ' ' + hhmm(m.at) + '</td>' +
      '<td>' + esc(m.playlist || '–') + ' <span class="tag">' + (EN ? 'private' : 'privat') + '</span></td><td>' + esc(m.matchType || (EN ? 'private' : 'privat')) + '</td>' +
      '<td class="' + (m.result === 'W' ? 'W' : m.result === 'L' ? 'L' : 'muted') + '">' + (m.result || '–') + '</td>' +
      '<td class="num">' + my + '</td><td class="num">' + ((m.me && m.me.goals) | 0) + '</td><td class="num">' + ((m.me && m.me.shots) | 0) + '</td></tr>';
  }).join('');
  const privHtml = mutNote + (privRows
    ? '<div class="card"><div class="plhead"><strong>' + (EN ? 'Private lobbies' : 'Private lobbyer') + '</strong><span class="chip">' + (EN ? 'shown, not counted' : 'vist, ikke talt') + '</span></div>' +
      '<div class="scroll"><table><thead><tr><th>' + (EN ? 'Played' : 'Spillet') + '</th><th>Playlist</th><th>Type</th><th>Res.</th><th class="num">Score</th><th class="num">' + (EN ? 'Goals' : 'Mål') + '</th><th class="num">' + (EN ? 'Shots' : 'Skud') + '</th></tr></thead>' +
      '<tbody>' + privRows + '</tbody></table></div>' +
      '<p class="muted" style="font-size:12.5px">' + (EN
        ? 'A private lobby is whoever the host invited, at whatever level the host chose — it enters neither W/L, trends, evidence nor your normal.'
        : 'En privat lobby er hvem værten inviterede, på det niveau værten valgte — den indgår hverken i W/L, trends, bevis eller din normal.') + '</p></div>\n'
    : '');

  const maxDay = Math.max(1, ...r.days.map(d => d.n));
  const dayRows = r.days.map(d =>
    '<tr><td>' + weekdayOf(d.day, EN) + ' ' + esc(danishDay(d.day, EN)) + '</td>' +
    '<td class="num">' + d.n + '</td>' +
    '<td class="num"><span class="W">' + d.w + '</span>–<span class="L">' + d.l + '</span></td>' +
    '<td class="barcell"><span class="bar" style="width:' + Math.round(d.n / maxDay * 100) + '%"></span></td></tr>').join('');

  const plRows = Object.keys(r.playlists).map(k => {
    const p = r.playlists[k];
    return '<tr><td><strong>' + esc(k) + '</strong></td><td class="num">' + p.n + '</td>' +
      '<td class="num"><span class="W">' + p.w + '</span>–<span class="L">' + p.l + '</span></td>' +
      '<td class="num">' + p.goals + '</td><td class="num">' + p.shots + '</td>' +
      '<td class="num">' + (p.conversion === null ? '–' : Math.round(p.conversion * 100) + '%') + '</td></tr>';
  }).join('');

  /* The distribution behind the size labels, and the transition meter (17/8).
   * `modes` is per SIZE (what the game said each match was); the table above
   * is per BUCKET (which normal it was measured against) — the two differ
   * exactly where the split matters, and the note says why. */
  const modes = r.modes || {};
  const cov = r.coverage || {};
  const modeRows = Object.keys(modes).sort().map(k => {
    const s = modes[k];
    const c = cov[k];
    const covTxt = c
      ? (c.idWeight >= M.ID_COVERAGE_OK
          ? '<span class="b-good">' + Math.round(c.idWeight * 100) + '%</span>'
          : '<span class="muted">' + Math.round(c.idWeight * 100) + '%</span>')
        + ' <span class="muted">(' + (EN ? 'of ' : 'af ') + c.n + (EN ? ' folded: ' : ' foldede: ') + esc(kindsText(c.kinds, EN) || '–') + ')</span>'
      : '<span class="muted">–</span>';
    return '<tr><td><strong>' + esc(k) + '</strong></td><td class="num">' + s.n + '</td>' +
      '<td>' + esc(kindsText(s.kinds, EN)) + '</td><td>' + covTxt + '</td></tr>';
  }).join('');
  const modesHtml = modeRows
    ? '<h2>' + (EN ? 'What the matches were' : 'Hvad kampene var') + '</h2>\n<div class="card"><div class="scroll"><table><thead><tr><th>' + (EN ? 'Team size' : 'Holdstørrelse') + '</th>' +
      '<th class="num">' + (EN ? 'Matches' : 'Kampe') + '</th><th>' + (EN ? 'Distribution (the game’s own playlist id)' : 'Fordeling (spillets eget playlist-id)') + '</th><th>' + (EN ? 'The normal’s id coverage today' : 'Normalens id-dækning i dag') + '</th></tr></thead><tbody>' +
      modeRows + '</tbody></table></div>' +
      '<p class="muted" style="font-size:12.5px">' + (EN
        ? 'The game’s playlist id is written to match files from 15 Aug 2026 (adapter 1.4.0); older matches stand as <em>without a playlist id</em> and are never guessed. ' +
          'Ranked, tournament (and rumble) count together in the normal under the team size (e.g. <em>3v3</em> = competitive 3 on 3 — your own decision, 17 Aug); casual is measured against its own normal (<em>4v4 Casual</em>) ' +
          'and private lobbies do not count. Id coverage = how much of the normal’s weight today comes from matches with a measured id — ' +
          'from ' + Math.round(M.ID_COVERAGE_OK * 100) + ' % the distribution behind the normal is known, not estimated.'
        : 'Spillets playlist-id skrives i kampfilerne fra 15/8-2026 (adapter 1.4.0); ' +
          'ældre kampe står som <em>uden playlist-id</em> og gættes aldrig om. Ranked, turnering (og rumble) tæller sammen i normalen under ' +
          'holdstørrelsen (fx <em>3v3</em> = konkurrencespil 3 mod 3 — din egen beslutning 17/8); casual måles mod sin egen normal (<em>4v4 Casual</em>) ' +
          'og private lobbyer tæller ikke. Id-dækning = hvor stor en del af normalens vægt der i dag stammer fra kampe med målt id — ' +
          'fra ' + Math.round(M.ID_COVERAGE_OK * 100) + ' % er fordelingen bag normalen kendt, ikke skønnet.') + '</p></div>\n'
    : '';

  const trendRows = r.trends.length ? r.trends.map(t2 => {
    const k = t2.playlist + '|' + t2.id;
    const mark = r.weakest.includes(k) ? ' <span class="tag bad">' + (EN ? 'weakest' : 'svagest') + '</span>'
      : r.strongest.includes(k) ? ' <span class="tag good">' + (EN ? 'strongest' : 'stærkest') + '</span>'
      // "1 → 25" says what the tag means: the normal this row is measured
      // against rested on 1 match when the week began, whatever it grew into
      : !t2.mature ? ' <span class="tag">baseline ' + t2.baselineN + '/' + M.MIN_BASELINE
                     + (t2.baselineNEnd > t2.baselineN ? ' → ' + t2.baselineNEnd : '') + '</span>' : '';
    /* An immature row still shows its numbers — hiding them would be its own
     * kind of dishonesty — but its Δ is greyed rather than coloured. A red
     * "-43%" against a "normal" that was one match old reads as a verdict, and
     * it is not one. The absolute column is only for noPct metrics (signed
     * counts): printing a raw 0.3 next to a percentage metric was read as
     * "0.3%" when it meant 30 percentage points. */
    const dCls = t2.mature ? (t2.goodness >= 0 ? 'b-good' : 'b-bad') : 'muted';
    const dCell = t2.deltaPct !== null
      ? '<td class="num ' + dCls + '">' + pctS(t2.deltaPct) + '</td>'
      : (t2.delta !== null && M.DEFS[t2.id].noPct)
        ? '<td class="num ' + (t2.mature ? (t2.delta * t2.direction >= 0 ? 'b-good' : 'b-bad') : 'muted') + '">' +
          (t2.delta >= 0 ? '+' : '') + (Math.round(t2.delta * 10) / 10) + '</td>'
        : '<td class="num muted">–</td>';
    const pCell = t2.vsPrevPct !== null
      ? '<td class="num ' + (t2.mature ? (t2.vsPrevGoodness >= 0 ? 'b-good' : 'b-bad') : 'muted') + '">' + pctS(t2.vsPrevPct) + '</td>'
      : '<td class="num muted">–</td>';
    return '<tr><td>' + esc(cap(t2.label)) + mark + '</td><td>' + esc(t2.playlist) + '</td>' +
      '<td class="num">' + M.fmt(t2.id, t2.weekAvg) + '</td>' +
      '<td class="num">' + (t2.normStart === null ? '–' : M.fmt(t2.id, t2.normStart)) + '</td>' +
      dCell + pCell + '<td class="num muted">' + t2.n + '</td></tr>';
  }).join('') : '<tr><td colspan="7" class="muted">' + (EN ? 'No metrics with data this week.' : 'Ingen metrikker med data i denne uge.') + '</td></tr>';

  const proofHtml = r.proof.length ? r.proof.map(p => {
    const cls = VERDICT_CLASS[p.verdict] || 'v-none';
    const bar = p.afterAvg !== null && p.triggerValue !== null && Number.isFinite(p.target)
      ? '<div class="prow"><span class="plabel">' + (EN ? 'When the focus was set' : 'Da fokus blev sat') + '</span><span class="pnum">' + M.fmt(p.metricId, p.triggerValue) + '</span></div>' +
        '<div class="prow"><span class="plabel">' + (EN ? 'After (' + p.n + ' matches)' : 'Efter (' + p.n + ' kampe)') + '</span><span class="pnum strong">' + M.fmt(p.metricId, p.afterAvg) + '</span></div>' +
        '<div class="prow"><span class="plabel">' + (EN ? 'Target (your own normal)' : 'Målet (din egen normal)') + '</span><span class="pnum">' + esc(p.targetText) + '</span></div>'
      : '';
    // a focus the weekly declared ("Fokus til næste uge") links back to that
    // report; one the evening's report picked links to the session report
    const fromWeekly = /\/weekly-/.test(p.sessionUrl || '');
    return '<div class="card"><div class="plhead"><strong>' + esc(cap(p.label)) + ' · ' + esc(p.playlist) + '</strong>' +
      (p.source === 'weekly' ? '<span class="chip">' + (EN ? 'the week’s focus' : 'ugens fokus') + '</span>' : '') +
      '<span class="verdict ' + cls + '">' + esc(vlabel(p.verdict, EN)) + '</span></div>' +
      bar + '<p>' + esc(p.verdictText) + '</p>' +
      '<p class="src">' + (EN ? 'Set ' : 'Sat ') + esc(danishDate(p.setAt, EN)) + (EN ? ' at ' : ' kl. ') + hhmm(p.setAt) +
      (p.sessionUrl ? ' · <a href="' + esc(p.sessionUrl) + '" rel="noopener">' + (fromWeekly ? (EN ? 'the weekly report' : 'ugerapporten') : (EN ? 'the session report' : 'sessionsrapporten')) + '</a>' : '') + '</p></div>';
  }).join('') : '<p class="muted">' + (EN
    ? 'No focus was in force this week — the evidence section needs a focus to measure against.'
    : 'Der var intet fokus i kraft i denne uge — bevis-sektionen kræver et fokus at måle imod.') + '</p>';

  const rankHtml = r.rank.measured
    ? Object.keys(r.rank.byPlaylist).map(k => {
        const b = r.rank.byPlaylist[k];
        const pts = b.points.map(p => '<span class="chip">' + esc(danishDay(p.day, EN)) + ': ' + esc(p.label || '?') +
          (p.division ? ' div ' + p.division : '') + ' · ' + p.mmr + '</span>').join('');
        return '<div class="card"><div class="plhead"><strong>' + esc(k) + '</strong>' +
          '<span class="' + (b.deltaMmr > 0 ? 'b-good' : b.deltaMmr < 0 ? 'b-bad' : 'muted') + '">' +
          (b.deltaMmr > 0 ? '+' : '') + b.deltaMmr + (EN ? ' MMR this week' : ' MMR i ugen') + '</span></div>' + pts + '</div>';
      }).join('')
    : '';

  const missionsHtml = r.missions.length
    ? '<ol class="missions">' + r.missions.map(m => '<li>' + esc(m.text) + '</li>').join('') + '</ol>'
    : '<p class="muted">' + (EN
      ? 'No mature trends below your normal — no missions invented to fill the space.'
      : 'Ingen modne trends under din normal — ingen missioner opfundet for at fylde pladsen ud.') + '</p>';

  /* Kildetitlen er citat-kroms: Lander-listens danske ord oversaettes ved
   * render (Dignitas-titlerne er engelske i forvejen). */
  const srcTitle = st => EN
    ? st.replace('Lander1984s ratede masterliste', 'Lander1984’s rated master list').replace('begynder-venlig', 'beginner-friendly')
    : st;
  /* Radar-baner (7/9): praefiks "Radar:" som afvekslingens "Afveksling:", og
   * kilde-niveauet som chip — 'tags' er katalogets ord, 'skudpositioner' er
   * maalte skud. En maalt bane der OGSAA er radarens (samme kode) beholder
   * sin plads og faar radar-begrundelsen som ekstra afsnit. Et RENT radar-
   * kort hedder "Radar:" uanset plads — ogsaa paa plads 1, naar ugen ingen
   * maalt bane har (§6); "Primær:" er den maalte koblings ord. */
  const confChip = p => p.radar
    ? '<span class="chip">' + (p.confidence === 'positions' ? (EN ? 'shot positions' : 'skudpositioner') : 'tags') + '</span>' : '';
  const prefix = (p, i) => p.radar && !p.radarReason ? 'Radar: ' : i === 0 && !p.goalOnly ? (EN ? 'Primary: ' : 'Primær: ') : '';
  // spillerens niveau (8/9): een linje over banerne — vinduet, og hvor ranken kom fra;
  // en Prejump-erstatning baerer sit eget niveau som chip
  const tierHtml = r.tier && r.tier.reason ? '<p class="muted">' + esc(r.tier.reason[EN ? 'en' : 'da']) + '</p>' : '';
  const diffChip = p => p.difficulty ? '<span class="chip">' + esc(p.difficulty) + '</span>' : '';
  const packsHtml = tierHtml + r.packs.map((p, i) =>
    '<div class="card"><div class="plhead"><strong>' + prefix(p, i) + esc(p.name) + '</strong>' +
    diffChip(p) + confChip(p) + '<span class="code">' + esc(p.code) + '</span></div><p>' + esc(p.reason) + '</p>' +
    (p.radarReason ? '<p>Radar: ' + esc(p.radarReason) + '</p>' : '') +
    (p.goalReason ? '<p class="muted">' + esc(p.goalReason) + '</p>' : '') +
    (p.source ? '<p class="src">' + (EN ? 'Source: ' : 'Kilde: ') + '<a href="' + esc(p.source.url) + '" rel="noopener">' + esc(srcTitle(p.source.title)) + '</a></p>' : '') +
    '</div>').join('');

  /* Baneradarens kort (RADAR-DESIGN.md §6): to zonetabeller (tal, andel,
   * langtidsandel), de markerede zoner, kilde-chip, gate-/hvorfor-tekst og
   * aerlighedschips (§9). Zonernes ord er radar.js' egne: siderne hedder
   * "(+x)/(−x)" i tabellen og "siden af dit forsvar" i teksten — aldrig
   * venstre/hoejre foer orienteringen er set i spillet. Ingen saetning om
   * rotation eller hvor spilleren stod: positionen er BOLDENS ved skyttens
   * sidste beroering. */
  const rd = r.radar || null;
  const pc = x => Math.round((x || 0) * 100) + ' %';
  const rate = v => Number.isFinite(v) ? (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10).replace('.', EN ? '.' : ',')) : '–';
  const zl = z => { const lbl = radar.ZONES.find(x => x.id === z); return lbl ? (EN ? lbl.label.en : lbl.label.da) : z; };
  let radarHtml = '';
  if (rd){
    const mDef = rd.marked && rd.marked.def, mOff = rd.marked && rd.marked.off;
    const defRows = Object.keys(rd.conceded.zones).map(z => {
      const v = rd.conceded.zones[z];
      const mark = mDef && mDef.zone === z ? ' <span class="tag bad">' + (EN ? 'marked' : 'markeret') + '</span>' : '';
      return '<tr><td>' + esc(zl(z)) + mark + '</td><td class="num">' + v.n + '</td><td class="num">' + pc(v.share) + '</td>' +
        '<td class="num muted">' + (v.longShare === null ? '–' : pc(v.longShare)) + '</td></tr>';
    }).join('');
    const offRows = Object.keys(rd.offense.zones).map(z => {
      const v = rd.offense.zones[z];
      const mark = mOff && mOff.zone === z ? ' <span class="tag good">' + (EN ? 'marked' : 'markeret') + '</span>' : '';
      return '<tr><td>' + esc(zl(z)) + mark + '</td><td class="num">' + v.goals + '</td><td class="num">' + v.touches + '</td>' +
        '<td class="num">' + rate(v.per100) + '</td><td class="num muted">' + rate(v.longPer100) + '</td></tr>';
    }).join('');
    const pDef = rd.picks && rd.picks.def, pOff = rd.picks && rd.picks.off;
    const srcChip = p => '<span class="chip">' + (p.pack.confidence === 'positions' ? (EN ? 'shot positions' : 'skudpositioner') : 'tags') + '</span>';
    const defLine = pDef
      ? '<p><strong>' + (EN ? 'Marked for defence: ' : 'Markeret til forsvar: ') + esc(EN ? mDef.label.en : mDef.label.da) + '</strong> — '
        + mDef.n + (EN ? ' of ' : ' af ') + mDef.located + (EN ? ' located (' : ' stedfæstede (') + pc(mDef.share)
        + (mDef.longShare === null ? '' : (EN ? '; long run ' : '; langtid ') + pc(mDef.longShare)) + ') → ' + esc(pDef.pack.name)
        + ' <span class="code">' + esc(pDef.pack.code) + '</span> ' + srcChip(pDef) + '</p>'
      : '<p><strong>' + (EN ? 'Defence: no pack' : 'Forsvar: ingen bane') + '</strong> — ' + esc(rd.why && rd.why.def ? (EN ? rd.why.def.en : rd.why.def.da) : (EN ? rd.gate.reason.en : rd.gate.reason.da)) + '</p>';
    const offLine = pOff
      ? '<p><strong>' + (EN ? 'Marked for offence: ' : 'Markeret til angreb: ') + esc(EN ? mOff.label.en : mOff.label.da) + '</strong> — '
        + mOff.goals + (EN ? ' goals on ' : ' mål på ') + mOff.touches + (EN ? ' touches (' : ' berøringer (') + rate(mOff.per100) + (EN ? ' per 100) against ' : ' pr. 100) mod ')
        + rate(mOff.frontPer100) + (EN ? ' per 100 in front of their goal → ' : ' pr. 100 foran deres mål → ') + esc(pOff.pack.name)
        + ' <span class="code">' + esc(pOff.pack.code) + '</span> ' + srcChip(pOff) + '</p>'
      : '<p><strong>' + (EN ? 'Offence: no pack' : 'Angreb: ingen bane') + '</strong> — ' + esc(rd.why && rd.why.off ? (EN ? rd.why.off.en : rd.why.off.da) : (EN ? rd.offense.gate.reason.en : rd.offense.gate.reason.da)) + '</p>';
    const c = rd.conceded, ex = rd.excluded || { private: 0, mutators: 0 };
    const chips2 = [
      c.located + (EN ? ' of ' : ' af ') + c.n + (EN ? ' conceded located' : ' indkasserede stedfæstet'),
      c.ko ? c.ko + (EN ? ' kickoff goals counted separately' : ' kickoff-mål talt for sig') : null,
      c.noX ? c.noX + (EN ? ' without x (not located)' : ' uden x (ikke stedfæstet)') : null,
      (ex.private || ex.mutators) ? (EN ? 'excluded: ' : 'udeladt: ') + [ex.private ? ex.private + (EN ? ' private' : ' private') : null, ex.mutators ? ex.mutators + ' mutator' : null].filter(Boolean).join(' · ') : null,
      rd.unbound ? rd.unbound + (EN ? ' unbound goals' : ' ubundne mål') : null,
      rd.orientationVerified ? null : (EN ? 'orientation not verified' : 'orientering ikke verificeret')
    ].filter(Boolean).map(x => '<span class="chip">' + esc(x) + '</span>').join('');
    radarHtml = '<h2>' + (EN ? 'Where they score on you · where you rarely score from' : 'Hvor de scorer på dig · hvor du sjældent scorer fra') + '</h2>\n' +
      '<div class="card"><div class="plhead"><strong>' + (EN ? 'Week ' + rd.week : 'Uge ' + rd.week) + ' · ' + rd.matches + (EN ? ' matches' : ' kampe') + '</strong>' + chips2 + '</div>' +
      defLine + offLine +
      '<div class="scroll"><table><thead><tr><th>' + (EN ? 'Conceded from' : 'Indkasseret fra') + '</th><th class="num">' + (EN ? 'Goals' : 'Mål') + '</th><th class="num">' + (EN ? 'Share' : 'Andel') + '</th><th class="num">' + (EN ? 'Long run' : 'Langtid') + '</th></tr></thead><tbody>' + defRows + '</tbody></table></div>' +
      '<div class="scroll" style="margin-top:10px"><table><thead><tr><th>' + (EN ? 'Your own goals from' : 'Egne mål fra') + '</th><th class="num">' + (EN ? 'Goals' : 'Mål') + '</th><th class="num">' + (EN ? 'Touches' : 'Berøringer') + '</th><th class="num">' + (EN ? 'Per 100' : 'Pr. 100') + '</th><th class="num">' + (EN ? 'Long run per 100' : 'Langtid pr. 100') + '</th></tr></thead><tbody>' + offRows + '</tbody></table></div>' +
      '<p class="muted" style="font-size:12.5px">' + (EN
        ? 'A zone is the BALL’s position at the scorer’s last touch before the goal (in a dribble: the last touch); height is the ball’s, not the car’s. ' +
          'Long run = share over the whole archive (' + rd.longRun.located + ' located conceded goals). Matches before 26 Aug have no x and cannot be located; unbound goals are counted, never guessed; ' +
          'private lobbies and unlimited-boost matches stay out of the radar. Zones D6/O6 never drive a pack. Sides read (+x)/(−x) until the orientation has been verified in the game.'
        : 'En zone er BOLDENS position ved skyttens sidste berøring før målet (ved en dribling: sidste touch); højden er boldens, ikke bilens. ' +
          'Langtid = andel over hele arkivet (' + rd.longRun.located + ' stedfæstede indkasseringer). Kampe før 26/8 har ingen x og kan ikke stedfæstes; ubundne mål tælles, gættes aldrig; ' +
          'private lobbyer og kampe med ubegrænset boost holdes ude af radaren. Zonerne D6/O6 driver aldrig en bane. Siderne hedder (+x)/(−x) indtil orienteringen er set i spillet.') + '</p></div>\n';
  }

  const sessHtml = r.sessionSummaries.length ? r.sessionSummaries.map(s =>
    '<tr><td>' + esc(weekdayOf(s.day, EN) + ' ' + danishDay(s.day, EN)) + ' ' + hhmm(s.startedAt) + '–' + hhmm(s.endedAt) +
    '</td><td class="num">' + s.matches + '</td>' +
    '<td class="num">' + esc(s.wl) + '</td><td>' + esc(s.headline) + (s.stop ? ' <span class="tag bad">' + (EN ? 'stop signal' : 'stop-signal') + '</span>' : '') + '</td>' +
    '<td>' + (s.url ? '<a href="' + esc(s.url) + '" rel="noopener">' + (EN ? 'report' : 'rapport') + '</a>' : '') + '</td></tr>').join('')
    : '<tr><td colspan="5" class="muted">' + (EN ? 'No session reports this week.' : 'Ingen sessionsrapporter i ugen.') + '</td></tr>';

  /* Tier 0-skabelonen (26/8, brugerens bestilling): uden voice fik ugen ingen
   * prosa overhovedet — nu saetter MOTOREN selv sammenfatningen sammen af sine
   * egne tal. Ingen model, ingen variation i ordlyd, intet opfundet: hvert
   * element hentes fra totals/proof/focusNext og udelades naar det mangler. */
  function templateNarrative(){
    const vc = { ok: 0, way: 0, back: 0, none: 0 };
    for (const p of (r.proof || [])){
      if (p.verdict === 'opnået') vc.ok++;
      else if (p.verdict === 'på vej') vc.way++;
      else if (p.verdict === 'tilbagegang' || p.verdict === 'ikke rykket') vc.back++;
      else vc.none++;
    }
    const judged = vc.ok + vc.way + vc.back;
    const conv = t.conversion !== null ? Math.round(t.conversion * 100) : null;
    if (EN){
      let s2 = 'The week showed ' + t.wl.w + ' wins and ' + t.wl.l + ' losses, '
        + t.goals + ' goals and ' + t.shots + ' shots' + (conv !== null ? ' at ' + conv + ' % conversion' : '') + '.';
      if (judged || vc.none){
        const bits = [];
        if (judged) bits.push(vc.ok + ' of ' + judged + ' judged focuses reached their target');
        if (vc.way) bits.push(vc.way + ' on the way');
        if (vc.back) bits.push(vc.back + ' did not move or regressed');
        if (vc.none) bits.push(vc.none + (judged ? ' had too few matches for a verdict' : ' focus' + (vc.none === 1 ? '' : 'es') + ' had too few matches for a verdict'));
        s2 += ' Evidence: ' + bits.join(' · ') + '.';
      }
      if (r.focusNext && r.focusNext.headline) s2 += ' Next week’s focus: ' + r.focusNext.headline + '.';
      return s2;
    }
    let s2 = 'Ugen viste ' + t.wl.w + ' sejre og ' + t.wl.l + ' nederlag, '
      + t.goals + ' mål og ' + t.shots + ' skud' + (conv !== null ? ' med ' + conv + ' % konvertering' : '') + '.';
    if (judged || vc.none){
      const bits = [];
      if (judged) bits.push(vc.ok + ' af ' + judged + ' bedømte fokus nåede målet');
      if (vc.way) bits.push(vc.way + ' på vej');
      if (vc.back) bits.push(vc.back + ' rykkede ikke eller gik tilbage');
      if (vc.none) bits.push(vc.none + ' fokus havde for få kampe til en dom');
      s2 += ' Bevis: ' + bits.join(' · ') + '.';
    }
    if (r.focusNext && r.focusNext.headline) s2 += ' Næste uges fokus: ' + r.focusNext.headline + '.';
    return s2;
  }
  const narrativeHtml = r.narrative && r.narrative.text
    ? '<div class="card narr"><p>' + esc(r.narrative.text).replace(/\n+/g, '</p><p>') + '</p>' +
      '<p class="src">' + (EN
        ? 'Written by the voice (' + esc(r.narrative.model || 'model') + ') from the numbers above — every figure is validated against the engine’s own measurements.'
        : 'Skrevet af stemmen (' + esc(r.narrative.model || 'model') + ') ud fra tallene ovenfor — hvert tal er valideret mod motorens egne målinger.') + '</p></div>'
    : '<div class="card narr"><p>' + esc(templateNarrative()) + '</p>' +
      '<p class="src">' + (EN
        ? 'Composed by the engine from its own numbers — no model involved.'
        : 'Sammensat af motoren ud fra dens egne tal — ingen model involveret.') + '</p></div>';

  return reportTheme.htmlOpen((EN ? 'en' : 'da')) + '<head><meta charset="utf-8">\n' +
    reportTheme.BOOT + '\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + (EN ? 'Weekly report ' : 'Ugerapport ') + esc(r.key) + ' — ' + esc(danishDay(r.from, EN)) + '–' + esc(danishDay(r.to, EN)) + '</title>\n' +
    '<style>\n' +
    /* NITRO (27/8): rapporten deler brand med tracker/landing/portal — men er
     * en SELVSTAENDIG fil, brugeren kan flytte og dele. Derfor ingen billed-
     * afhaengighed: pladen er ren CSS. Fonten er en progressiv forbedring —
     * den ligger et niveau op og findes, naar rapporten laeses fra /reports/;
     * staar filen alene, falder den pænt tilbage til Segoe UI. */
    '@font-face{font-family:"Archivo";src:url("../archivo-var.woff2") format("woff2");font-weight:100 900;font-stretch:62% 125%;font-display:swap}\n' +
    ':root{--bg:#05080F;--panel:#16233E;--panel2:#0B1424;--line:rgba(150,175,210,.13);--text:#EAF2FF;--muted:#9BA8BE;--good:#35D08C;--bad:#F85149;--accent:#3FB3FF;--warn:#FFC94A;--teal:#27D9C0;--cut:13px;' +
      '--chamfer:inset 0 1px 0 rgba(196,224,255,.24),inset 1px 0 0 rgba(196,224,255,.11),inset -1px 0 0 rgba(0,0,0,.38),inset 0 -1px 0 rgba(0,0,0,.60);' +
      '--e2:0 1px 0 rgba(0,0,0,.85),0 2px 4px rgba(0,0,0,.55),0 10px 22px rgba(0,0,0,.38)}\n' +
    '*{box-sizing:border-box;margin:0;padding:0}\n' +
    'body{background:radial-gradient(120% 60% at 50% -10%,rgba(120,160,215,.13),transparent 60%),linear-gradient(180deg,#0A1120 0%,#05080F 46%,#03050A 100%),var(--bg);background-attachment:fixed;' +
      'color:var(--text);font-family:"Archivo","Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.55;font-stretch:100%;font-weight:420;padding:26px 14px;min-height:100vh}\n' +
    '.wrap{max-width:920px;margin:0 auto}\n' +
    'h1{font-size:25px;font-stretch:78%;font-weight:850;letter-spacing:.03em;margin-bottom:4px}\n' +
    'h2{font-size:11.5px;font-stretch:72%;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px;display:flex;align-items:center;gap:9px}\n' +
    'h2::before{content:"";width:3px;height:11px;flex:none;background:linear-gradient(180deg,var(--teal),#0E6C60)}\n' +
    'h2::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(150,175,210,.20),transparent 78%)}\n' +
    '.sub{color:var(--muted);margin-bottom:12px;font-size:13.5px}\n' +
    /* Pladen: eet fraeset hjoerne oeverst til hoejre, praecis som i trackeren. */
    '.card{background:linear-gradient(187deg,rgba(255,255,255,.05) 0%,rgba(255,255,255,.01) 34%,rgba(0,0,0,.06) 58%,rgba(190,220,255,.02) 100%),linear-gradient(163deg,#1E2B47 0%,#16233E 44%,#0A1322 100%);' +
      'border:1px solid var(--line);border-radius:3px var(--cut) 3px 3px;padding:14px 16px;margin-bottom:10px;box-shadow:var(--chamfer),var(--e2)}\n' +
    '@supports (corner-shape:bevel){.card{corner-shape:round bevel round round}}\n' +
    '.card p{margin:6px 0 0}\n' +
    '.narr{border-color:#2C3E5C}\n' +
    '.narr p{margin:8px 0 0;font-size:15.5px}\n' +
    '.chip{display:inline-block;background:linear-gradient(180deg,rgba(20,32,54,.9),rgba(8,14,26,.94));border:1px solid var(--line);border-radius:2px;padding:3px 10px;margin:2px 6px 2px 0;font-size:11.5px;font-stretch:78%;font-weight:700;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;box-shadow:inset 0 1px 0 rgba(196,224,255,.07)}\n' +
    '.plhead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px}\n' +
    '.plhead strong{margin-right:auto}\n' +
    'table{width:100%;border-collapse:collapse;font-size:13.5px}\n' +
    'th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}\n' +
    'th{color:var(--muted);font-size:9.5px;font-stretch:75%;font-weight:700;letter-spacing:.18em;text-transform:uppercase}\n' +
    'tr:last-child td{border-bottom:0}\n' +
    '.num{text-align:right;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;font-weight:640}\n' +
    '.muted{color:var(--muted)}\n' +
    '.b-good{color:var(--good);font-weight:600}.b-bad{color:var(--bad);font-weight:600}\n' +
    '.W{color:var(--good);font-weight:700}.L{color:var(--bad);font-weight:700}\n' +
    '.tag{font-size:11px;border-radius:5px;padding:1px 6px;vertical-align:1px;background:var(--panel2)}\n' +
    '.tag.bad{background:#2A1218;color:var(--bad)}.tag.good{background:#0E241D;color:var(--good)}\n' +
    '.verdict{font-size:10.5px;border-radius:2px;padding:3px 9px;font-stretch:76%;font-weight:750;letter-spacing:.12em;text-transform:uppercase}\n' +
    '.v-good{background:#0E241D;color:var(--good)}.v-part{background:#22200D;color:var(--warn)}\n' +
    '.v-bad{background:#2A1218;color:var(--bad)}.v-none{background:var(--panel2);color:var(--muted)}\n' +
    '.prow{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)}\n' +
    '.prow:last-of-type{border-bottom:0}\n' +
    '.plabel{color:var(--muted);font-size:13px}\n' +
    '.pnum{font-variant-numeric:tabular-nums}.pnum.strong{font-weight:700;font-size:16px}\n' +
    '.barcell{width:45%}\n' +
    '.bar{display:block;height:9px;border-radius:1px;background:linear-gradient(180deg,#8FD8FF,var(--accent) 42%,#1B6FA8);box-shadow:0 0 10px -4px var(--accent)}\n' +
    '.code{font-family:Consolas,monospace;background:var(--panel2);border:1px solid var(--line);border-radius:2px;padding:2px 8px;font-size:13px}\n' +
    '.missions{margin:4px 0 0 20px}.missions li{margin:5px 0}\n' +
    '.src{font-size:12.5px;color:var(--muted)}\n' +
    '.quote{font-style:italic;color:var(--text);border-left:2px solid var(--teal);padding-left:12px;margin:8px 0 4px}.quote .by{font-style:normal;color:var(--muted);font-size:12.5px}\n' +
    '.src a{color:var(--accent);text-decoration:none}\n' +
    'a{color:var(--accent)}\n' +
    '.scroll{overflow-x:auto}\n' +
    'footer{color:var(--muted);font-size:12.5px;margin-top:26px;border-top:1px solid var(--line);padding-top:12px}\n' +
    reportTheme.CSS +
    '</style></head><body><div class="wrap">\n' +
    '<h1>' + (EN ? 'Weekly report — week ' : 'Ugerapport — uge ') + r.week + '</h1>\n' +
    '<div class="sub">' + esc(danishDay(r.from, EN)) + '–' + esc(danishDay(r.to, EN)) + ' ' + r.year +
      (r.closed ? '' : (EN ? ' · the week is not over yet' : ' · ugen er ikke slut endnu')) + '</div>\n' +
    '<div>' + chips + '</div>\n' + narrativeHtml +
    (r.focusNext ? '<h2>' + (EN ? 'Focus for next week' : 'Fokus til næste uge') + '</h2>\n<div class="card"><div class="plhead"><strong>' +
      esc(r.focusNext.headline) + '</strong></div><p>' + esc(r.focusNext.why) + '</p>' +
      (r.focusNext.guide && r.focusNext.guide.quote
        ? '<p class="quote">“' + esc(r.focusNext.guide.quote) + '”' +
          (r.focusNext.guide.by ? ' <span class="by">— ' + esc(r.focusNext.guide.by) + '</span>' : '') + '</p>' +
          '<p class="src">' + (EN ? 'Source: ' : 'Kilde: ') + '<a href="' + esc(r.focusNext.guide.url) + '" rel="noopener">' + esc(r.focusNext.guide.title) + '</a></p>'
        : '') +
      '<p class="src">' + (EN ? 'The target is your own normal from before the week — not a benchmark.' : 'Målet er din egen normal fra før ugen — ikke et benchmark.') + '</p></div>\n' : '') +
    /* Missioner + baner bor OEVERST (brugerens dom 26/8): handling foerst,
     * arkaeologi bagefter. */
    '<h2>' + (EN ? 'Missions for next week' : 'Missioner til næste uge') + '</h2>\n<div class="card">' + missionsHtml + '</div>\n' +
    '<h2>' + (EN ? 'Training packs' : 'Træningsbaner') + '</h2>\n' + packsHtml +
    radarHtml +
    '<h2>' + (EN ? 'The evidence: did the focus move anything?' : 'Beviset: rykkede fokus noget?') + '</h2>\n' + proofHtml +
    '<h2>' + (EN ? 'Metric trends against your normal at the start of the week' : 'Metrik-trends mod din normal ved ugens start') + '</h2>\n' +
    '<div class="card"><div class="scroll"><table><thead><tr><th>' + (EN ? 'Metric' : 'Metrik') + '</th><th>Playlist</th>' +
    '<th class="num">' + (EN ? 'Week’s average' : 'Ugens snit') + '</th><th class="num">' + (EN ? 'Normal at start' : 'Normal v. start') + '</th><th class="num">Δ</th>' +
    '<th class="num">' + (EN ? 'Δ vs. previous week' : 'Δ vs. forrige uge') + '</th><th class="num">' + (EN ? 'Matches' : 'Kampe') + '</th></tr></thead><tbody>' + trendRows + '</tbody></table></div>' +
    '<p class="muted" style="font-size:12.5px">' + (EN
      ? 'Normal = your own EWMA average per playlist as it stood at the week’s first match. '
        + (r.prevWeek ? 'The previous week (' + esc(r.prevWeek.key) + ') had ' + r.prevWeek.matches + ' matches to compare against.' : 'No previous week to compare against yet.')
      : 'Normal = dit eget EWMA-snit pr. playlist som det stod ved ugens første kamp. '
        + (r.prevWeek ? 'Forrige uge (' + esc(r.prevWeek.key) + ') havde ' + r.prevWeek.matches + ' kampe at sammenligne med.' : 'Ingen forrige uge at sammenligne med endnu.')) +
    '</p></div>\n' +
    '<h2>' + (EN ? 'Day by day' : 'Dag for dag') + '</h2>\n<div class="card"><table><tbody>' + dayRows + '</tbody></table></div>\n' +
    '<h2>' + (EN ? 'Per playlist' : 'Pr. playlist') + '</h2>\n<div class="card"><div class="scroll"><table><thead><tr><th>Playlist</th><th class="num">' + (EN ? 'Matches' : 'Kampe') + '</th>' +
    '<th class="num">W–L</th><th class="num">' + (EN ? 'Goals' : 'Mål') + '</th><th class="num">' + (EN ? 'Shots' : 'Skud') + '</th><th class="num">' + (EN ? 'Conv.' : 'Konv.') + '</th></tr></thead><tbody>' +
    plRows + '</tbody></table></div>' +
    '<p class="muted" style="font-size:12.5px">' + (EN
      ? 'The rows are the normals the matches were measured against: <em>3v3</em> = ranked + tournament (+ rumble) + matches without a playlist id; ' +
        'only <em>Casual</em> has its own. The distribution behind the team sizes is in the next section.'
      : 'Rækkerne er de normaler kampene blev målt imod: <em>3v3</em> = ranked + turnering (+ rumble) + kampe uden playlist-id; ' +
        'kun <em>Casual</em> har sin egen. Fordelingen bag holdstørrelserne står i næste afsnit.') + '</p></div>\n' +
    modesHtml + privHtml +
    (rankHtml ? '<h2>' + (EN ? 'Rank curve' : 'Rank-kurve') + '</h2>\n' + rankHtml + '<p class="muted" style="font-size:12.5px">' + esc(rankNote(r.rank, EN)) + '</p>\n'
              : '<h2>' + (EN ? 'Rank curve' : 'Rank-kurve') + '</h2>\n<div class="card"><p class="muted">' + esc(rankNote(r.rank, EN)) + '</p></div>\n') +
    '<h2>' + (EN ? 'Sessions this week' : 'Sessioner i ugen') + '</h2>\n<div class="card"><div class="scroll"><table><thead><tr><th>Session</th><th class="num">' + (EN ? 'Matches' : 'Kampe') + '</th>' +
    '<th class="num">W–L</th><th>' + (EN ? 'Headline' : 'Overskrift') + '</th><th></th></tr></thead><tbody>' + sessHtml + '</tbody></table></div>' +
    '<p class="muted" style="font-size:12.5px">' + (EN
      ? 'Goals conceded in the first minute of a match this week: <strong>' + r.tilt.earlyConceded +
        '</strong> · goals in the final minute/overtime: <strong>' + r.tilt.lateOwn + '</strong>' +
        (r.tilt.stops ? ' · stop signal triggered in ' + r.tilt.stops + ' session' + (r.tilt.stops === 1 ? '' : 's') : '')
      : 'Mål indkasseret i kampens første minut i ugen: <strong>' + r.tilt.earlyConceded +
        '</strong> · scoringer i sidste minut/overtid: <strong>' + r.tilt.lateOwn + '</strong>' +
        (r.tilt.stops ? ' · stop-signal udløst i ' + r.tilt.stops + ' session' + (r.tilt.stops === 1 ? '' : 'er') : '')) + '.</p></div>\n' +
    '<footer>' + (EN
      ? 'Generated ' + esc(danishDate(r.at, EN)) + ' at ' + hhmm(r.at) + ' · weekly report ' + esc(r.key) +
        ' · the play day starts at 0' + DAY_START_HOUR + ':00, so an evening running past midnight counts as one day · ' +
        'every number is measured by the tracker — no invented benchmarks.'
      : 'Genereret ' + esc(danishDate(r.at)) + ' kl. ' + hhmm(r.at) + ' · ugerapport ' + esc(r.key) +
        ' · spilledøgnet regnes fra kl. 0' + DAY_START_HOUR + ':00, så en aften der løber over midnat tælles som én dag · ' +
        'alle tal er målt af trackeren — ingen opfundne benchmarks.') + '</footer>\n' +
    '</div></body></html>\n';
}

module.exports = { init, ensure, current, latest, latestSummary, summary, onRank, rankHistory, renderHTML,
                   applyNarrative, buildReport, currentWeek, isoWeekOf, playDay,
                   matchesInWeek, buildTrends, proofFor, focusTimeline, weekEndIso,   // pure; exported for director/test
                   write,   // director/test/weekly-radar.test.js: skriv-vejen uden at vente paa at ugen lukker kl. 06
                   placeRadarPacks,   // ren; director/test/weekly-radar.test.js (plads, dublet, maal-kortet)
                   MIN_WEEK_MATCHES, PROOF_MIN_MATCHES };
