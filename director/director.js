/* RL Director — M1 orchestration: digest in, 3-line template debrief out.
 * Deterministic end to end (Tier 0, DESIGN §4): the metric engine owns every
 * number, this file only selects and phrases. No network, no LLM, no deps.
 *
 * Debrief text is Danish (reports speak Danish, game UI stays English).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./metrics');
const { RULES, PRAISE, PRAISE_EN } = require('./rules');
const session = require('./session');
const store = require('./store');
const focusEngine = require('./focus');
const voice = require('./voice');
const weekly = require('./weekly');
const form = require('./form');           // body barometer — local only, see form.js
const persona = require('./persona');
const seed = require('./seed');

const PACK_VERSION = 'rl-m1/1.0.0';
const SEEN_CAP = 1000;

let ROOT = null, log = () => {};
let profile = null;
// Kept at module scope so the M3 voice layer can push a revised debrief to the
// board after the template one has already been shown.
let broadcast = () => {};

/* Synchronous work over this many ms is logged by name (3/9). server.js
 * measures how long the main thread was held after a match; this says WHICH
 * call held it, so the next slow one is found in the log and not by guessing. */
const SLOW_LOG_MS = 250;
function timed(label, fn){
  const t0 = Date.now();
  try{ return fn(); }
  finally{ const ms = Date.now() - t0; if (ms > SLOW_LOG_MS) log('[tid] ' + label + ' tog ' + ms + ' ms'); }
}

/* ---------------- guest mode (19/8-2026) ----------------
 * The coach follows ONE player, and everything it learns about that player
 * (baselines, recent debriefs, advice rotation, session, labels, reports) is
 * that player's. Until now there was one profile, so clicking a friend's row
 * would have folded his matches into the owner's normals and his evening into
 * the owner's session and week. Now the data lives in a DATA directory:
 *   owner  → ROOT (profile.json, session-state.json, reports/, labels.json)
 *   guest  → ROOT/guests/<id>/ with the same files, started empty
 * matches/ (the raw digests) is shared — the recorder records everyone — and
 * the weekly report and the rank history are the owner's alone: a guest gets
 * per-match debriefs, the focus card and a session report, nothing that
 * spans weeks. The owner is whoever the profile was built for
 * (profile.ownerPid, migrated from trackedPid on first load); the board's
 * row click decides who is coached, and clicking the owner's row comes home.
 * Guest mode survives a restart (owner profile remembers `guest`), so the
 * board and the coach can never disagree about who is being coached. */
let DATA = null;                 // the directory the current profile lives in
let guest = null;                // { pid, name, id } while coaching a guest, else null
const guestId = pid => String(pid).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80);
function guestDir(pid){ return path.join(ROOT, 'guests', guestId(pid)); }
function dataDir(){ return DATA || ROOT; }
function isGuest(){ return !!guest; }
/* A seeded bucket is judged against the STANDARD (seed.js), not against the
 * player's own normal — and every sentence must say so. The templates, the
 * voice and the session report all say "din normal"/"your normal"; rather than
 * teach each of them a second vocabulary, the finished text is relabelled on
 * the way out. Numbers are untouched. */
const RELABEL = [
  [/din egen normal/gi, 'standarden'], [/din normal/gi, 'standarden'], [/\bnormalen\b/g, 'standarden'], [/\bnormalt\b/g, 'standard'],
  [/end du plejer/g, 'end standarden'], [/your own normal/gi, 'the standard'], [/your normal/gi, 'the standard'], [/than usual/gi, 'than the standard'], [/\bnormally\b/gi, 'standard']
];
function relabel(text){
  if (typeof text !== 'string') return text;
  let t = text;
  for (const [rx, to] of RELABEL) t = t.replace(rx, to);
  return t;
}
function relabelLines(lines){
  if (!lines) return lines;
  for (const k of ['ros', 'problem', 'advice']) if (lines[k] && typeof lines[k].text === 'string') lines[k].text = relabel(lines[k].text);
  return lines;
}

function profilePath(){ return path.join(dataDir(), 'profile.json'); }

function defaultProfile(){
  return {
    schema: 'profile/1', game: 'rl', packVersion: PACK_VERSION,
    // Empty on a fresh install. This used to be hard-coded to the author's own
    // Epic id, which meant a copy handed to anyone else silently produced no
    // coaching at all: every match failed validity() with "tracked player not
    // in match", while the board and ranks kept working — so the product
    // looked alive and was in fact deaf. The page tells the server who you are
    // when you click your own row (POST /api/tracked).
    trackedPid: '', trackedName: '',
    // Which unit Players[].Speed is in. 'auto' reads it off the physics (see
    // metrics.js UNITS) and is right for anyone who never touches it; 'kmh' or
    // 'mph' is the player answering a question he already knows the answer to.
    // A non-null string default means store.readJSON self-migrates an older
    // profile without a migration step.
    speedUnit: 'auto',
    speedUnitDetected: '',         // what Auto has read off the feed, so a restart knows it too
    // Which DEFINITION the stored boost baselines were measured under. Bumped
    // when the meaning of the numbers changes, so the reset happens exactly
    // once and cannot be undone by an older process rewriting the file.
    boostDefn: 0,
    // Whether the buckets below carry idWeight/kinds (see migrateBucketProvenance)
    bucketProvenance: 0,
    // Baseline buckets, keyed by metrics.bucketOf(digest).key: '3v3' holds
    // ranked, tournament (user's decision 17/8: they count together), rumble
    // and every id-less match of that size; only '3v3 Casual' (and exotic
    // modes) get a bucket of their own. idWeight/kinds say how much of a
    // bucket rests on matches whose kind the game itself stamped.
    playlists: {},                 // key -> { n, idWeight, kinds: {ranked,unknown,…}, metrics: { id: {mean, n} } }
    recentDebriefs: [],            // newest first, capped — continuity input for M3
    seen: {},                      // digest filenames already folded (idempotent replays)
    // Advice-silence bookkeeping (30/7-2026): n = debrief counter, rules =
    // ruleId -> { shownAt, times }. See adviceGate() for why this exists.
    adviceState: {},
    updatedAt: null
  };
}

function init(opts){
  ROOT = opts.root;
  log = opts.log || log;
  // missing keys are filled from the default shape, so a profile written by an
  // older pack can't crash on profile.seen / profile.recentDebriefs
  profile = store.readJSON(profilePath(), defaultProfile);
  // the owner is whoever this profile was built for (guest mode, 19/8): an
  // older profile only knows trackedPid, and that player IS the owner
  if (!profile.ownerPid && profile.trackedPid){ profile.ownerPid = profile.trackedPid; profile.ownerName = profile.trackedName || ''; }
  loadCustomLabels();
  // Formatting is settled before anything is formatted (M4b). Auto falls back
  // to whatever a previous match already proved the unit to be.
  M.configureUnits(profile.speedUnit, profile.speedUnitDetected);
  migrateBoostBaselines();
  migrateBucketProvenance();
  // session engine rides on the director; broadcast comes from server.js (SSE)
  const bc = opts.broadcast || (() => {});
  broadcast = bc;
  // M3: optional LLM voice. Never required — init failure leaves Tier 0 intact.
  try{ voice.init({ root: ROOT, log }); }
  catch(e){ log('[voice] init-fejl (skabeloner bruges): ' + (e.message || e)); }
  // Engine-wide language follows the voice config (director-ai.json "language").
  // One switch, set once per process: labels swap in metrics.js DEFS, and every
  // template/tape/card producer below asks EN() at render time.
  try{ M.configureLanguage(voice.lang()); }catch{}
  // M4: weekly progression. Reads reports/ only, so a failure here can never
  // affect the recorder or the nightly report.
  try{ weekly.init({ root: ROOT, log, broadcast: bc }); }
  catch(e){ log('[weekly] init-fejl: ' + (e.message || e)); }
  // Form (23/8): the body barometer. Reads the coachee's own debriefs, writes
  // form-state.json and nothing else; stays off the feedback allow-list.
  try{ form.init({ root: ROOT, log, reportsDir: () => path.join(dataDir(), 'reports') }); form.update(); }
  catch(e){ log('[form] init-fejl: ' + (e.message || e)); }
  // Test-feedback (kun dev/test-builds): tavs medmindre feedback.json findes.
  // Egen try/catch af samme grund som alt andet: recorderen deler proces.
  try{ require('./feedback').init({ root: ROOT, log }); }
  catch(e){ log('[feedback] init-fejl (slået fra): ' + (e.message || e)); }
  try{
    session.init({ root: ROOT, log, broadcast: o => {
      bc(o);
      // a finished session report is what "dagens fokus" is derived from, so
      // the new focus goes out in the same breath as the report
      if (o && o.Event === '_session'){
        // The session that ends the week is what makes last week's report due.
        // Checking here (rather than only on the tick) means the weekly is
        // waiting on the board before the first match of the new week ends.
        // Ensured BEFORE the focus goes out: a weekly that lands here may be
        // the very thing that decides the card (focus.pick).
        ensureWeekly();
        const f = focus();
        if (f) bc({ Event: '_focus', Data: f });
        try{ const c = weekly.current(); if (c) bc({ Event: '_weekly', Data: c }); }catch{}
      }
    } });
  }
  catch(e){ log('[session] init-fejl: ' + (e.message || e)); }
  // A week can also close while the game is shut: the tick covers that, but a
  // restart on Monday morning should not have to wait an hour for it.
  ensureWeekly('ved opstart');
  // Guest mode persisted by the owner profile: pick it up again, so the board
  // (which remembers its own tracked row) and the coach agree after a restart.
  if (profile.guest && profile.guest.pid && profile.guest.pid !== profile.ownerPid){
    try{ enterGuest(profile.guest.pid, profile.guest.name || ''); }
    catch(e){ log('[director] gæstetilstand kunne ikke genoptages: ' + (e.message || e)); }
  }
  return module.exports;
}

/* ---------------- owner ⇄ guest switching ----------------
 * The owner's profile stays the authority on WHO the owner is and whether a
 * guest is being coached; a guest profile is an ordinary profile living in
 * ROOT/guests/<id>/, born empty (baseline 1/10 like anyone's first evening)
 * and never migrated — it is created at the current definitions. */
function ownerProfilePath(){ return path.join(ROOT, 'profile.json'); }

function enterGuest(pid, name){
  const id = guestId(pid);
  // leave a note in the OWNER's profile first (it is the one that survives)
  if (!guest){
    profile.guest = { pid, name: name || '', id, since: new Date().toISOString() };
    saveProfile();                                   // DATA is still ROOT here
  }else{
    // switching guest → guest: note it on the owner profile on disk
    try{
      const owner = store.readJSON(ownerProfilePath(), defaultProfile);
      owner.guest = { pid, name: name || '', id, since: new Date().toISOString() };
      store.writeJSON(ownerProfilePath(), owner);
    }catch{}
    saveProfile();                                   // the previous guest's profile
  }
  const dir = guestDir(pid);
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  DATA = dir;
  guest = { pid, name: name || '', id };
  profile = store.readJSON(profilePath(), () => Object.assign(defaultProfile(), {
    trackedPid: pid, trackedName: name || '', ownerPid: pid, ownerName: name || '',
    boostDefn: BOOST_DEFN, bucketProvenance: BUCKET_PROVENANCE
  }));
  profile.trackedPid = pid;
  if (name) profile.trackedName = String(name).slice(0, 64);
  profile.isGuest = true;
  // the standard, laid down in advance (seed.js): a guest is coached from
  // match 1 against what the tracker has measured across everyone in the
  // owner's lobbies, and grows into a normal of his own from there
  try{
    const sd = timed('seed.ensure', () => seed.ensure(ROOT, log, store));
    const k = seed.apply(profile, sd);
    if (k) log('[seed] gæsten starter på standarden i ' + k + ' spand(e) — ' + sd.playerMatches + ' spiller-kampe bag den');
  }catch(e){ log('[seed] kunne ikke lægge standarden ind: ' + (e.message || e)); }
  saveProfile();
  loadCustomLabels();
  try{ session.rehome(dir, pid, '/guests/' + id + '/reports/', { seeded: !!profile.seeded }); }
  catch(e){ log('[session] gæste-skifte fejlede: ' + (e.message || e)); }
  try{ form.update(); }catch{}                    // the barometer follows the coachee
  log('[director] gæstetilstand: coacher ' + (profile.trackedName || pid) + ' (data i guests/' + id + ')');
}

function leaveGuest(){
  if (!guest) return;
  saveProfile();                                     // the guest's profile, in its own dir
  DATA = ROOT;
  guest = null;
  profile = store.readJSON(profilePath(), defaultProfile);
  delete profile.guest;
  saveProfile();
  loadCustomLabels();
  try{ session.rehome(ROOT, profile.trackedPid, '/reports/', { seeded: false }); }
  catch(e){ log('[session] hjem-skifte fejlede: ' + (e.message || e)); }
  try{ form.update(); }catch{}
  log('[director] tilbage til ejeren: ' + (profile.trackedName || profile.trackedPid));
}

function saveProfile(){
  profile.updatedAt = new Date().toISOString();
  const seen = Object.keys(profile.seen);
  if (seen.length > SEEN_CAP) for (const k of seen.slice(0, seen.length - SEEN_CAP)) delete profile.seen[k];
  store.writeJSON(profilePath(), profile);   // atomic: baselines survive a crash mid-write
}

/* "Tale of the tape": the numbers, laid out as numbers.
 *
 * The user's observation (27/7): a sentence has to be a data table AND a piece
 * of advice at the same time, and the two pull opposite ways — which is why we
 * kept arguing about whether "17%" or "1 af 6" belongs mid-sentence. Give the
 * figures their own column and the coaching line can stop reciting them.
 *
 * Formatted HERE, never in the browser: a second place deciding what "17%"
 * means is exactly the duplication M2 was bitten by. The page renders strings.
 *
 * Fixed order and a short fixed set, so the block looks the same after every
 * match — a table you re-learn each time is not scannable. Counts come first
 * where the evidence supports one ("1 af 6 (17%)"): with six kickoffs a single
 * one is worth 17 percentage points, so the percentage alone implies a
 * precision the sample does not have.
 */
/* Engine-wide language, resolved at render time (set once in init via
 * M.configureLanguage). Every Danish string below carries its English sister
 * inline — same data, same evidence, only the words change. */
const EN = () => M.currentLanguage() === 'en';

const TAPE = [
  { id: 'kickoff_self_ft',  label: 'Dine kickoff-førstetouch', label_en: 'Your kickoff first touches', count: e => [e.won, e.total] },
  { id: 'off_touch_share',  label: 'Touches i deres halvdel',  label_en: 'Touches in their half', count: e => [e.off, e.total] },
  { id: 'boost_low_share',  label: 'Tid under 15 boost',       label_en: 'Time below 15 boost' },
  { id: 'hit_power_avg',    label: 'Touchkraft (snit)',        label_en: 'Touch power (avg)' },
  { id: 'touches_per_min',  label: 'Touches pr. minut',        label_en: 'Touches per minute' },
  { id: 'demo_diff',        label: 'Demoer (ude/hjemme)',      label_en: 'Demos (dealt/taken)',
    when: s => (s.evidence.inflicted || 0) + (s.evidence.received || 0) > 0,
    now: s => (s.evidence.inflicted || 0) + ' / ' + (s.evidence.received || 0) },
  // Movement (M4b). Three rows, not ten: the tape is read on a board across a
  // room and inside a ~400px overlay, and a table nobody finishes reading is
  // worse than a shorter one. The rest of the movement metrics are still
  // measured and still reach the debrief's evidence — they just do not all get
  // a line. Labels carry the unit; values never do (grounding).
  { id: 'speed_avg',        label: () => 'Gennemsnitsfart' + unitSuffix('speed_avg'),
                            label_en: () => 'Average speed' + unitSuffix('speed_avg') },
  { id: 'slow_share',       label: s => 'Tid under ' + (s.evidence.under ?? '?') + unitSuffix('speed_avg', ' '),
                            label_en: s => 'Time below ' + (s.evidence.under ?? '?') + unitSuffix('speed_avg', ' ') },
  { id: 'dist_per_touch',   label: () => 'Kørt distance pr. touch' + unitSuffix('dist_per_touch'),
                            label_en: () => 'Distance per touch' + unitSuffix('dist_per_touch') }
];

/* " (km/t)" when the unit is settled, "" when it is not — the tape must never
 * imply a unit the engine has not proved. */
function unitSuffix(id, plain){
  const u = M.unitFor(id);
  return u ? (plain ? plain + u : ' (' + u + ')') : '';
}

/* Short labels for metrics that are not in the fixed set but can still be
 * named by a debrief line — the table has to hold the receipt for whatever
 * the card claims. */
const EXTRA_LABELS = {
  kickoff_team_ft: 'Holdets kickoff-førstetouch',
  kickoff_self_speed: 'Kickoff-touchkraft',
  hit_power_max: 'Hårdeste touch',
  boost_avg: 'Boost-niveau (snit)',
  speed_max: () => 'Højeste fart' + unitSuffix('speed_max'),
  supersonic_share: 'Tid i supersonic',
  airborne_share: 'Tid uden hjul på jorden',
  distance_per_min: () => 'Kørt distance pr. minut' + unitSuffix('distance_per_min'),
  speed_drift: 'Fart, sidste mod første tredjedel',
  post_concede_speed: 'Fart efter indkasseret mål',
  pass_count: 'Afleveringer til makker'
};
const EXTRA_LABELS_EN = {
  kickoff_team_ft: 'Team kickoff first touches',
  kickoff_self_speed: 'Kickoff touch power',
  hit_power_max: 'Hardest touch',
  boost_avg: 'Boost level (avg)',
  speed_max: () => 'Top speed' + unitSuffix('speed_max'),
  supersonic_share: 'Time at supersonic',
  airborne_share: 'Time with wheels off the ground',
  distance_per_min: () => 'Distance per minute' + unitSuffix('distance_per_min'),
  speed_drift: 'Speed, last vs first third',
  post_concede_speed: 'Speed after conceding',
  pass_count: 'Passes to a teammate'
};

/* `cited` are the metric ids the debrief's own sentences point at. Measured
 * 27/7: a card said "Svagest i dag: kickoff-touchkraft — 83 mod normalt 98"
 * while the table showed no such row, so the one number the player was being
 * asked to act on had no receipt. Anything the card names gets a row. */
const MUTATOR_ROW_ID = 'mutator_unlimited_boost';
function buildTape(snaps, cited, mutators){
  const XL = EN() ? EXTRA_LABELS_EN : EXTRA_LABELS;
  const extra = (cited || [])
    .filter(id => id && snaps[id] && XL[id] && !TAPE.some(t => t.id === id))
    .map(id => ({ id, label: XL[id] }));
  const rows = [];
  // Unlimited boost (6/9): the boost, movement and touch-power rows are absent
  // for this match (metrics.mutatorsOf), and a table that silently lacks them
  // would read as "nothing to show". The first row says why — shown, not hidden.
  if (M.hasMutator(mutators))
    rows.push({ id: MUTATOR_ROW_ID, label: EN() ? 'Unlimited boost (mutator)' : 'Ubegrænset boost (mutator)',
                now: EN() ? 'boost/distance/touch power not measured' : 'boost/afstand/slagkraft ikke målt',
                normal: null, baselineN: 0, better: null });
  for (const t of TAPE.concat(extra)){
    const s = snaps[t.id];
    if (!s) continue;
    if (t.when && !t.when(s)) continue;
    let now = t.now ? t.now(s) : M.fmt(t.id, s.value);
    if (!t.now && t.count){
      const [a, b] = t.count(s.evidence || {});
      if (Number.isFinite(a) && Number.isFinite(b) && b > 0) now = a + (EN() ? ' of ' : ' af ') + b + ' (' + M.fmt(t.id, s.value) + ')';
    }
    const normal = s.baseline ? M.fmt(t.id, s.baseline.mean) : null;
    // Direction applied, so the page can colour a row without knowing which
    // way is up. Two cases deliberately carry NO verdict:
    //  - the two columns render identically (20% vs 20%): if the display can't
    //    tell them apart, an arrow claiming a direction is just noise
    //  - demo_diff, whose baseline sits near zero — the same reason it is
    //    marked noPct in metrics.js; one match cannot be ranked against it
    const sameOnScreen = normal !== null && normal === M.fmt(t.id, s.value);
    const lbl = (EN() && t.label_en !== undefined) ? t.label_en : t.label;
    rows.push({
      id: t.id, label: typeof lbl === 'function' ? lbl(s) : lbl, now, normal,
      baselineN: s.baseline ? s.baseline.n : 0,
      // A third case carries no verdict: direction 0. Time off the ground and
      // speed after conceding are measurements the engine refuses to call good
      // or bad, so the row shows the number and no arrow.
      better: (!s.baseline || sameOnScreen || M.DEFS[t.id].noPct || !M.DEFS[t.id].direction)
        ? null
        : (s.value - s.baseline.mean) * M.DEFS[t.id].direction > 0
    });
  }
  return rows;
}

/* The per-second curve, thinned for a board read across a room (M4b §4).
 * ~90 points is more than a 1080p card can resolve and small enough to ride on
 * an SSE frame; a 7-minute match records ~420. Thinning averages whole buckets
 * rather than sampling every Nth, so a spike is flattened, never invented.
 * Returns null for any match recorded before the curve existed. */
const CURVE_POINTS = 90;
function buildCurve(digest, me){
  const tl = (digest.timeline || {})[me.name];
  if (!tl || !Array.isArray(tl.spd) || tl.spd.length < 6) return null;
  const n = tl.spd.length, step = Math.max(1, Math.ceil(n / CURVE_POINTS));
  const spd = [], bst = [], clock = [];
  for (let i = 0; i < n; i += step){
    const end = Math.min(n, i + step);
    let s = 0, b = 0;
    for (let k = i; k < end; k++){ s += tl.spd[k]; b += tl.bst[k]; }
    spd.push(Math.round((s / (end - i)) * 10) / 10);
    bst.push(Math.round(b / (end - i)));
    clock.push(tl.t[i]);
  }
  // Goals as positions along the curve, so the page never has to know that the
  // clock counts down (and stops) to place a marker.
  const marks = [];
  for (const g of digest.goals || []){
    if (typeof g.clock !== 'number') continue;
    // Overtime restarts the clock and counts up, so the search has to know
    // which half of the curve it is looking in (metrics.curveIndexAt).
    let idx = M.curveIndexAt(clock, g);
    if (idx < 0) idx = clock.length - 1;
    marks.push({ i: idx, mine: g.team === me.team });
  }
  /* Every number the card prints is computed HERE, never in the page.
   * `peak` is the match's true fastest sample from the movement record — the
   * curve's own maximum is the highest one-SECOND average, which is a
   * different (and always smaller) quantity, and labelling it "fastest" would
   * be wrong by a margin that grows with how spiky the driving was.
   * `top` is the curve's own maximum, and exists only to scale the drawing. */
  const mv = (digest.movement || {})[me.name] || {};
  const mean = mv.sec > 0 ? mv.spdInt / mv.sec : null;
  return {
    spd, bst, clock, marks, step,
    top: spd.reduce((a, b) => b > a ? b : a, 0),
    meanText: mean === null ? null : M.fmt('speed_avg', mean),
    peakText: typeof mv.spdMax === 'number' ? M.fmt('speed_max', mv.spdMax) : null,
    unit: M.unitFor('speed_avg')
  };
}

/* One-time reset of the boost baselines (2026-07-27).
 *
 * boost_low_share and boost_avg changed MEANING, not just accuracy: they used
 * to count feed samples that carried a Boost field, which silently excluded
 * every frame at exactly zero boost (the feed omits falsy values) and included
 * goal replays, where the boost is frozen. Measured across 53 archived matches,
 * the median share went from 19.0% to a corrected 31.7%, and the error was not
 * constant — 1.31x to 1.98x, worst in the matches where the player was most
 * boost-starved, so it never cancelled against his own normal.
 *
 * The old baselines are therefore in a scale the new numbers do not share.
 * Left alone, 40 of 53 archived matches would have tripped `boost_starved` —
 * the highest-severity rule in the library — on the first night, and kept
 * tripping until the EWMA caught up some twenty matches later.
 *
 * Reset rather than convert: the correction can be estimated from the archive
 * but not measured, and an estimated baseline is exactly what this change
 * exists to stop. Ten matches per playlist rebuilds it. Keyed on a stored
 * marker so it happens once, no matter which build starts first.
 */
const BOOST_DEFN = 1;      // 0 = sample-counted (pre-1.2.0), 1 = time-weighted, replay-free
function migrateBoostBaselines(){
  if ((profile.boostDefn || 0) >= BOOST_DEFN) return;
  let n = 0;
  for (const pl of Object.values(profile.playlists || {})){
    if (!pl || !pl.metrics) continue;
    for (const id of ['boost_low_share', 'boost_avg']) if (pl.metrics[id]){ delete pl.metrics[id]; n++; }
  }
  profile.boostDefn = BOOST_DEFN;
  saveProfile();
  log(n ? '[director] boost måles nu tidsvægtet uden replay-frames — ' + n
        + ' baseline(s) i den gamle skala nulstillet (bygges op igen over 10 kampe pr. playlist)'
        : '[director] boost-definition markeret (ingen gamle baselines at nulstille)');
}

/* Provenance for buckets that existed before idWeight/kinds did (17/8): replay
 * the fold ORDER from the debriefs already on disk — each names the bucket it
 * was folded into (match.playlist) and the digest it came from — and run the
 * same two counters over it that snapshotAndFold keeps from now on. Nothing
 * else is touched: no baseline moves, no report is rewritten. Without this the
 * transition meter would start at 0 on the day of the deploy and understate
 * the ranked matches (15/8 onwards) that were already folded with a measured
 * id. Marker-keyed like the boost migration so it runs once. */
const BUCKET_PROVENANCE = 1;
function migrateBucketProvenance(){
  if ((profile.bucketProvenance || 0) >= BUCKET_PROVENANCE) return;
  const rows = [];
  try{
    const rdir = path.join(ROOT, 'reports');
    for (const f of fs.readdirSync(rdir)){
      if (!f.endsWith('-debrief.json')) continue;
      try{
        const d = JSON.parse(fs.readFileSync(path.join(rdir, f), 'utf8'));
        if (!d || d.setup || d.private || !d.match || !d.match.playlist || !d.at) continue;   // only folded matches
        rows.push({ at: Date.parse(d.at), key: d.match.playlist, file: d.match.file || null });
      }catch{}
    }
  }catch{}
  rows.sort((a, b) => a.at - b.at);
  const acc = {};
  for (const r of rows){
    const b = acc[r.key] || (acc[r.key] = { idWeight: 0, kinds: {} });
    let kind = 'unknown', known = false;
    if (r.file){
      try{ const bk = M.bucketOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'matches', r.file), 'utf8'))); kind = bk.kind; known = bk.known; }catch{}
    }
    b.idWeight += M.EWMA_ALPHA * ((known ? 1 : 0) - b.idWeight);
    b.kinds[kind] = (b.kinds[kind] | 0) + 1;
  }
  let n = 0;
  for (const k of Object.keys(profile.playlists || {})){
    const pl = profile.playlists[k];
    if (!pl || typeof pl !== 'object' || pl.idWeight !== undefined) continue;
    pl.idWeight = acc[k] ? acc[k].idWeight : 0;
    pl.kinds = acc[k] ? acc[k].kinds : {};
    n++;
  }
  profile.bucketProvenance = BUCKET_PROVENANCE;
  saveProfile();
  if (n) log('[director] baseline-spande mærket med id-dækning ud fra ' + rows.length + ' debriefs: '
    + Object.keys(profile.playlists).map(k => k + ' ' + Math.round((profile.playlists[k].idWeight || 0) * 100) + '%').join(', '));
}

/* Baselines whose numbers only mean anything in one unit. Percentages and
 * ratios (supersonic_share, slow_share, speed_drift, post_concede_speed) are
 * scale-free and survive a unit change untouched. */
const SCALED_METRICS = ['speed_avg', 'speed_max', 'distance_per_min', 'dist_per_touch'];
function dropScaledBaselines(why){
  let n = 0;
  for (const pl of Object.values(profile.playlists || {})){
    if (!pl || !pl.metrics) continue;
    for (const id of SCALED_METRICS) if (pl.metrics[id]){ delete pl.metrics[id]; n++; }
  }
  if (n) log('[director] fart-enheden skiftede (' + why + ') — ' + n + ' baseline(s) i den gamle skala nulstillet');
}

/* Pick the debrief's three lines from snapshots + match facts. */
function selectLines(snaps, facts){
  const ordered = Object.values(snaps);
  const en = EN();
  const P = en ? PRAISE_EN : PRAISE;

  // ROS: strongest direction-adjusted improvement over own baseline
  let ros = null, best = 0.02;                    // >2% over baseline before we call it praise
  for (const s of ordered){
    if (s.gated || s.deltaPct === null || !P[s.id]) continue;
    const goodness = s.deltaPct * M.DEFS[s.id].direction;
    if (goodness > best){ best = goodness; ros = { text: P[s.id](s), metricId: s.id }; }
  }
  if (!ros){                                      // always at least one true, positive fact
    const f = en
      ? (facts.result === 'W' ? 'The win is home — ' + facts.myScore + ' in ' + facts.playlist + '.'
        : facts.me.saves > 0 ? facts.me.saves + ' save' + (facts.me.saves > 1 ? 's' : '') + ' — you kept the team in the match.'
        : facts.me.goals + facts.me.assists > 0 ? facts.me.goals + ' goals and ' + facts.me.assists + ' assist' + (facts.me.assists === 1 ? '' : 's') + ' — direct contributions on the board.'
        : facts.me.touches + ' touches — you were in the play the whole way.')
      : (facts.result === 'W' ? 'Sejren er i hus — ' + facts.myScore + ' på ' + facts.playlist + '.'
        : facts.me.saves > 0 ? facts.me.saves + ' redning' + (facts.me.saves > 1 ? 'er' : '') + ' — du holdt holdet inde i kampen.'
        : facts.me.goals + facts.me.assists > 0 ? facts.me.goals + ' mål og ' + facts.me.assists + ' assist' + (facts.me.assists === 1 ? '' : 's') + ' — direkte bidrag på tavlen.'
        : facts.me.touches + ' touches — du var med i spillet hele vejen.');
    ros = { text: f, metricId: null };
  }

  // PROBLEM + ADVICE: highest-severity rule that fires
  let fired = null;
  for (const r of RULES.slice().sort((a, b) => b.severity - a.severity)){
    const s = snaps[r.metric];
    // A rule may be written and shipped before its metric is trusted to judge.
    // coachable() is the single switch: flip it in metrics.js and the metric
    // starts ranking, praising AND firing its rule in the same move.
    if (s && M.coachable(r.metric) && r.when(s)){ fired = { rule: r, snap: s }; break; }
  }
  if (fired){
    // The instruction comes from the bank, rotated (19/8-2026): several
    // source-backed instructions address the same metric, and the one shown
    // least recently wins — so a rule that fires again after its cooldown
    // says something the reader has not seen, with its own guide and quote,
    // instead of the same sentence for the fifth time. The rule's own advice
    // text stays as the fallback for a metric the bank does not cover.
    const st = profile && profile.adviceState;
    const entry = persona.pickFor(fired.rule.metric, st && st.bank);
    const advice = persona.adviceFrom(entry, en ? 'en' : 'da', fired.rule.id)
      || { text: (en && fired.rule.advice_en ? fired.rule.advice_en : fired.rule.advice)(fired.snap),
           ruleId: fired.rule.id, bankId: null, source: fired.rule.source, quote: null };
    return {
      ros,
      problem: { text: (en && fired.rule.problem_en ? fired.rule.problem_en : fired.rule.problem)(fired.snap),
                 metricId: fired.rule.metric, ruleId: fired.rule.id },
      advice
    };
  }

  // Nothing bad enough to nag about: name the softest spot honestly, keep it calm
  let weak = null, worst = -0.02;
  for (const s of ordered){
    if (s.gated || s.deltaPct === null) continue;
    const goodness = s.deltaPct * M.DEFS[s.id].direction;
    if (goodness < worst){ worst = goodness; weak = s; }
  }
  return {
    ros,
    problem: weak
      ? { text: en
          ? 'Weakest today: ' + M.DEFS[weak.id].label + ' — ' + M.fmt(weak.id, weak.value) + ' against your normal ' + M.fmt(weak.id, weak.baseline.mean) + '. Within normal variance.'
          : 'Svagest i dag: ' + M.DEFS[weak.id].label + ' — ' + M.fmt(weak.id, weak.value) + ' mod normalt ' + M.fmt(weak.id, weak.baseline.mean) + '. Inden for normal varians.',
          metricId: weak.id, ruleId: null }
      : { text: en ? 'No metric below your baseline in this match.' : 'Ingen metrik under din baseline i denne kamp.', metricId: null, ruleId: null },
    advice: { text: en ? 'No alarms — stick with what works, and play the next match like this one.'
                       : 'Ingen alarmer — hold fast i det der virker, og spil næste kamp som denne.', ruleId: null, source: null }
  };
}

/* ---------------- advice-tavshed (30/7-2026) ----------------
 * Målt på de 91 gemte debriefs: kun 8 forskellige advice-sætninger i alt, og
 * spilleren meldte selv at han var holdt op med at læse linjen (habituering —
 * hjernens korrekte respons på en plads uden ny information). Et råd der ikke
 * læses er ikke et råd, så tavshed er en gyldig værdi: advice er null
 * medmindre sætningen er NY for læseren — første gang dens regel fyrer, og
 * derefter tidligst igen efter ADVICE_COOLDOWN kort. Problem-linjen bærer
 * stadig tallene (de skifter hver kamp og bliver læst).
 *
 * Beslutningen bor HER i debrief-samlingen, aldrig i rules.js: session-
 * rapportens strateginoter kalder rule.advice() direkte og skal blive ved med
 * at få tekst. voice.js spejler den (en tavs skabelon må ikke genoplives af
 * stemmelaget), og null skrives EKSPLICIT — JSON beholder advice:null, så
 * rapportfilen viser at tavsheden var et valg og ikke en gammel fil.
 */
const ADVICE_COOLDOWN = 5;                         // kort mellem samme instruks
function applyAdviceSilence(lines, collecting, baselineN){
  const st = profile.adviceState;
  if (typeof st.n !== 'number') st.n = 0;
  if (!st.rules || typeof st.rules !== 'object') st.rules = {};
  st.n++;                                          // dette korts nummer (persisteres af saveProfile)
  if (collecting){
    // Statusbesked, ikke coaching: vises kun ved playlistens allerførste kamp.
    if (baselineN > 0) lines.advice = null;
    return;
  }
  const ruleId = lines.advice && lines.advice.ruleId;
  if (!ruleId){ lines.advice = null; return; }     // "Ingen alarmer" = ren tavshed
  const r = st.rules[ruleId];
  if (r && st.n - r.shownAt < ADVICE_COOLDOWN){ lines.advice = null; return; }
  st.rules[ruleId] = { shownAt: st.n, times: (r && r.times || 0) + 1 };
  // the bank entry actually shown, so the next card for this metric rotates
  // onward (persona.pickFor reads this map). Only a SPOKEN advice counts —
  // a suppressed one was never read, so it must not advance the rotation.
  if (lines.advice.bankId){
    if (!st.bank || typeof st.bank !== 'object') st.bank = {};
    st.bank[lines.advice.bankId] = st.n;
  }
}

/* Main entry: called with a freshly written digest. Returns a debrief object
 * (for SSE + storage) or null when the digest isn't a coachable match.
 */
/* Who the coach is coaching. Set from the page when the user clicks their own
 * row. Rejected: bots and spectators (the feed reports them as Unknown|0|0 —
 * accepting that would lock coaching to a bot and quietly break it), demo
 * players, and anything not shaped like a platform id. */
function setTracked(pid, name){
  const p = String(pid || '').trim();
  if (!p) return { ok: false, reason: 'tomt spiller-id' };
  if (p === 'Unknown|0|0') return { ok: false, reason: 'bot/tilskuer uden platform-id' };
  if (p.startsWith('Demo|')) return { ok: false, reason: 'demo-spiller' };
  const parts = p.split('|');
  if (parts.length < 3 || !parts[0] || !parts[1] || parts[1] === '0')
    return { ok: false, reason: 'ikke et gyldigt platform-id' };
  const nm = name ? String(name).slice(0, 64) : '';
  // Who owns this install: the profile's owner, or — on a fresh install with
  // no owner yet — the first player ever clicked. Any OTHER player is a guest
  // (19/8): coached from an empty profile of their own, never from the
  // owner's normals. `makeOwner` re-homes the install to a new owner (only
  // while no baselines exist, so nobody can adopt someone else's history).
  const ownerPid = (guest ? readOwnerPid() : profile.ownerPid) || '';
  if (!ownerPid || p === ownerPid){
    const wasGuest = !!guest;
    if (guest) leaveGuest();
    const changed = wasGuest || profile.trackedPid !== p;
    profile.trackedPid = p;
    if (!profile.ownerPid){ profile.ownerPid = p; profile.ownerName = nm; }
    if (nm) profile.trackedName = nm;
    saveProfile();
    if (changed) log('[director] sporet spiller sat: ' + (profile.trackedName || p));
    return { ok: true, pid: p, name: profile.trackedName, changed, guest: false };
  }
  const changed = !guest || guest.pid !== p;
  if (changed) enterGuest(p, nm);
  else if (nm && profile.trackedName !== nm){ profile.trackedName = nm; guest.name = nm; saveProfile(); }
  return { ok: true, pid: p, name: profile.trackedName, changed, guest: true,
           owner: { pid: ownerPid, name: readOwnerName() } };
}
function readOwnerPid(){
  if (!guest) return profile ? profile.ownerPid || '' : '';
  try{ return store.readJSON(ownerProfilePath(), defaultProfile).ownerPid || ''; }catch{ return ''; }
}
function readOwnerName(){
  if (!guest) return profile ? profile.ownerName || profile.trackedName || '' : '';
  try{ const o = store.readJSON(ownerProfilePath(), defaultProfile); return o.ownerName || o.trackedName || ''; }catch{ return ''; }
}

function getTracked(){
  if (!profile) return { pid: '', name: '', guest: false };
  return { pid: profile.trackedPid || '', name: profile.trackedName || '', guest: isGuest(),
           owner: { pid: readOwnerPid(), name: readOwnerName() } };
}

/* ---------------- the label (M4b §5b) ----------------
 * The player's own read on the match, in one tap, before he has seen a single
 * number. It is the only ground truth this system will ever have: every metric
 * here is a proxy for a state, and without somebody saying what the state
 * actually was, a proxy can never be confirmed or thrown out.
 *
 * Kept in its own file, keyed by digest filename. The digest archive is written
 * once and never touched (DESIGN §3) — the label arrives seconds later and is a
 * different kind of fact anyway: measured by the player, not by the feed.
 *
 * The rules it has to live by are the point, not a nicety. Skipping costs
 * nothing: no reminder, no streak, no empty slot that looks like a gap. The
 * question only exists BEFORE the numbers are shown, so an answer can never be
 * an interpretation of them — and a label that arrives after the numbers would
 * be worthless data, not merely late.
 */
/* Redesignet 30/7-2026 efter brugerens eget argument: mærkaten skal måle det
 * telemetrien IKKE kan se — den indre tilstand og livet udenom spillet.
 * Modstander-tryk er læsbart i tallene (touch-fordeling mellem holdene,
 * save/clear-tæthed), så det skal ikke optage en knap. 'pressed' ("Presset")
 * er pensioneret: den blandede tre forskellige ting (svær modstander /
 * tidspres / socialt pres) og kunne derfor ikke bruges som facit for noget.
 * Historiske 'pressed'-svar i labels.json består — men analyse skal vide at
 * betydningen var flertydig frem til 30/7-2026. */
const LABELS = [
  { id: 'flow',        text: 'I flow',                  text_en: 'In flow' },
  { id: 'fine',        text: 'Fint',                    text_en: 'Fine' },
  { id: 'heavy',       text: 'Tungt',                   text_en: 'Heavy' },
  { id: 'elsewhere',   text: 'Tankerne et andet sted',  text_en: 'Mind somewhere else' },
  /* Brugerens knapsaet 25/8: de to sidste handler om, hvem kampen laa paa —
   * makkeren eller ham selv. 'Spørg ikke' er med vilje uden indhold: nogle
   * kampe vil man ikke saette ord paa, og et svar man kan give i det humoer,
   * er mere værd end et felt man springer over. */
  { id: 'mate_no_help', text: 'Makkeren hjalp ikke',    text_en: "My teammate didn't help" },
  { id: 'dont_ask',     text: 'Spørg ikke',            text_en: "Don't ask" }
];
/* Stadig gyldige ved POST — et kort skrevet før en genstart kan bære de gamle
 * knapper, og et klik på dem må ikke fejle. Tilbydes aldrig igen.
 * 'pressed_out' (Presset udefra) pensioneret 25/8 paa brugerens ord: pladsen
 * gik til de to nye. Historiske svar bestaar og betyder praecis det samme. */
/* 'sofie' var en egen knap i labels-custom.json indtil 25/8; et kort paa
 * skaermen kan stadig baere den, og klikket skal virke. */
const RETIRED_LABEL_IDS = ['pressed', 'pressed_out', 'sofie'];

/* Brugerdefinerede mærkater (30/7-2026, brugerønske: en "Sofie"-knap).
 * labels-custom.json i ROOT: [{"id":"sofie","text":"Sofie"}, ...].
 * Mærkaterne er spillerens EGET ordforråd for det telemetrien ikke kan se —
 * en knap behøver ikke give mening for andre end ham, og analysen behandler
 * den som enhver anden ground truth. Læses ved init; ugyldige/kolliderende
 * poster ignoreres tavst. Filen er personlig konfiguration: aldrig i zips. */
let customLabels = [];
function loadCustomLabels(){
  customLabels = [];
  try{
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'labels-custom.json'), 'utf8'));
    if (Array.isArray(raw)) for (const l of raw){
      if (!l || typeof l.id !== 'string' || typeof l.text !== 'string') continue;
      const id = l.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
      const text = l.text.trim().slice(0, 24);
      if (!id || !text) continue;
      if (LABELS.some(x => x.id === id) || RETIRED_LABEL_IDS.includes(id)
          || customLabels.some(x => x.id === id)) continue;
      customLabels.push({ id, text });
    }
    if (customLabels.length)
      log('[director] egne mærkater indlæst: ' + customLabels.map(l => l.text).join(', '));
  }catch{}
}
function labelOptions(){
  // Custom labels are the player's own vocabulary — never translated.
  return LABELS.map(l => ({ id: l.id, text: (EN() && l.text_en) || l.text })).concat(customLabels);
}
function labelsPath(){ return path.join(dataDir(), 'labels.json'); }   // per coached player (guest mode)

function setMatchLabel(file, labelId){
  const f = String(file || '').trim();
  if (!f || f.includes('/') || f.includes('\\') || f.includes('..')) return { ok: false, reason: 'ugyldig kamp' };
  const known = LABELS.some(l => l.id === labelId) || RETIRED_LABEL_IDS.includes(labelId)
    || customLabels.some(l => l.id === labelId);
  if (!known) return { ok: false, reason: 'ukendt mærkat' };
  let all = {};
  try{ all = store.readJSON(labelsPath(), () => ({})); }catch{}
  if (!all || typeof all !== 'object') all = {};
  // First answer wins. The whole value of the label is that it was given before
  // the numbers were seen; a second one for the same match can only have come
  // after, from another board or another window, and overwriting the first with
  // it would quietly replace the clean reading with a contaminated one.
  if (all[f]) return { ok: true, file: f, label: all[f].label, alreadyAnswered: true };
  // labelId direkte — `known` er en boolean efter RETIRED-omskrivningen, og
  // `known.id` var undefined: hvert svar blev gemt UDEN mærkatet, med ok:true
  // tilbage. Fanget af det adversariale review 30/7, før koden nåede i drift.
  all[f] = { label: labelId, at: new Date().toISOString() };
  // A cap, because this file is written from the page and lives forever.
  const keys = Object.keys(all);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete all[k];
  try{ store.writeJSON(labelsPath(), all); }catch(e){ return { ok: false, reason: String(e.message || e) }; }
  return { ok: true, file: f, label: labelId };
}
/* The speed unit, stored server-side on purpose. It is FORMATTING, and every
 * number the coach says is formatted in director/ — a conversion done in the
 * browser would be a second place that decides what a number means, which is
 * the duplication DESIGN §3 exists to prevent. The page sends the choice the
 * same way it sends the tracked player (POST), and the engine keeps it. */
function setUnit(choice){
  const c = String(choice || '').trim();
  if (c !== 'auto' && !M.UNITS[c]) return { ok: false, reason: 'ukendt enhed' };
  const before = M.currentUnit();
  profile.speedUnit = c;
  // Keep what Auto already read off the feed — switching to km/t and back to
  // Auto must not throw away a unit the physics has already settled.
  const after = M.configureUnits(c, profile.speedUnitDetected);
  // Same reasoning as the auto-detected change: a speed baseline is a number in
  // one scale, and 46 km/t averaged with 29 mph is a normal that is true in
  // neither. Ratios and shares are scale-free and stay.
  if (before && after && before !== after) dropScaledBaselines(before + ' -> ' + after);
  saveProfile();
  log('[director] fart-enhed sat: ' + c);
  return getUnit();
}

function getUnit(){
  const choice = (profile && profile.speedUnit) || 'auto';
  const resolved = M.configureUnits(choice, profile && profile.speedUnitDetected);
  return {
    ok: true, choice, resolved,
    // The label is what a surface prints; empty while Auto has not yet seen a
    // supersonic moment to read the unit off.
    label: resolved && M.UNITS[resolved] ? M.UNITS[resolved].speed : '',
    options: ['auto'].concat(Object.keys(M.UNITS))
  };
}

/* Shown instead of a debrief when nobody has been identified yet. Without this
 * the first-run experience is a working board and a permanently blank coach —
 * a failure that does not look like one. */
function setupCard(digest, fileName){
  const score = digest.teams && digest.teams.length === 2 ? [digest.teams[0].score, digest.teams[1].score] : [0, 0];
  const b = M.bucketOf(digest);
  return {
    schema: 'debrief/1', packVersion: PACK_VERSION, at: new Date().toISOString(),
    match: { file: fileName || null, guid: digest.guid || null,
             playlist: b.key, playlistSize: b.size, playlistId: b.id, matchKind: b.kind, kindKnown: b.known,
             matchType: b.name, score, result: null,
             myTeam: 0, arena: digest.arena || null, abandoned: !!digest.abandoned },
    collecting: true, baselineN: 0, setup: true, me: {}, voiced: false,
    ros: { text: EN() ? 'Match saved — the telemetry works.' : 'Kampen er gemt — telemetrien virker.', metricId: null },
    problem: { text: EN() ? 'I do not yet know which of the players you are, so I cannot measure your game.'
                          : 'Jeg ved endnu ikke hvem af spillerne du er, så jeg kan ikke måle dit spil.', metricId: null, ruleId: null },
    advice: { text: EN() ? 'Click your own name in the player list — I will remember it from then on.'
                         : 'Klik på dit eget navn i spillerlisten — så husker jeg det fremover.', ruleId: null, source: null },
    metrics: []
  };
}

function onDigest(digest, fileName){
  if (!profile) throw new Error('director not initialized');
  if (fileName && profile.seen[fileName]) return null;
  if (!profile.trackedPid){
    // Deliberately NOT marked as seen: once the user identifies themselves,
    // director/replay.js can fold these matches in rather than losing them.
    log('[director] ingen sporet spiller valgt endnu — kampen gemt, men ikke analyseret');
    return (digest.mode || (digest.guid ? 'online' : 'offline')) === 'offline' ? null : setupCard(digest, fileName);
  }
  if ((digest.mode || (digest.guid ? 'online' : 'offline')) === 'offline'){
    if (fileName){ profile.seen[fileName] = 1; saveProfile(); }
    return null;                                  // freeplay never touches baselines (DESIGN §4)
  }
  const v = M.validity(digest, profile.trackedPid);
  if (!v.ok){
    log('[director] springer over (' + v.reason + '): ' + (fileName || digest.guid || '?'));
    if (fileName){ profile.seen[fileName] = 1; saveProfile(); }
    return null;
  }

  /* Which baseline this match belongs to (17/8): the game's own playlist id
   * decides the KIND, and the kind decides the bucket — see metrics.bucketOf.
   * digest.playlist (the recorder's size label) is deliberately not used as
   * the key any more: '3v3' is still the key for ranked, tournament, rumble
   * and id-less matches (competitive play at that size — the user's decision),
   * while a casual match is measured against '3v3 Casual', never against it. */
  const bucket = M.bucketOf(digest);
  const playlist = bucket.key;
  /* Private lobbies (user's decision 15/8-2026): the match is saved and SHOWN,
   * but never measured — no baseline fold, no W/L, no trends, no proof. A
   * private lobby is whoever the host invited, at whatever level, with the
   * scoreboard the host chose; folding it into "your normal" is what put a
   * 1-8 four-player lobby into the 1v1 baseline on 14/8. The debrief becomes a
   * status card, like the baseline-collecting one — a message about data, not
   * coaching — and the profile is touched only for `seen` and the card itself. */
  // A GUEST is the exception (19/8): his profile is a coaching scratchpad on a
  // standard laid down in advance, not a long-term normal to protect — and the
  // owner coaching a Switch friend in a private 1v1 is exactly the case guest
  // mode exists for. So a guest's private lobby is measured and folded like
  // any match; the card keeps matchKind 'private' so every surface can say so.
  if (M.isPrivate(digest) === true && !isGuest()) return privateCard(digest, fileName, v, bucket);
  // store.js only repairs top-level keys, so a junk playlist entry (valid JSON,
  // wrong shape) would throw here for EVERY future match in that playlist and
  // silently end the user's debriefs. Reset it instead.
  let pl = profile.playlists[playlist];
  if (!pl || typeof pl !== 'object' || !pl.metrics || typeof pl.metrics !== 'object'){
    if (pl) log('[director] ugyldig baseline for ' + playlist + ' — nulstillet');
    else if (bucket.kind !== 'ranked' && bucket.kind !== 'unknown')
      log('[director] ny baseline-spand: ' + playlist + ' (playlist-id ' + bucket.id + ', ' + (bucket.name || '?')
        + ') — måles adskilt fra ranked; moden efter ' + M.MIN_BASELINE + ' kampe');
    pl = profile.playlists[playlist] = { n: 0, metrics: {} };
  }
  const baselineN = pl.n;                          // matches folded BEFORE this one
  /* Settle the unit before anything is computed from it — distances are speed
   * times time and mean nothing until it is known. On Auto the match reads it
   * off its own physics, and the answer is remembered so a restart (or a match
   * where nobody ever hit supersonic) still knows it. */
  if ((profile.speedUnit || 'auto') === 'auto'){
    const found = M.detectUnit(digest);
    if (found && found !== profile.speedUnitDetected){
      // A CHANGED unit means every stored speed and distance baseline is in a
      // scale that no longer exists. Folding the new match into them would
      // average km/h with mph and produce a normal that is true in neither.
      // Drop those baselines and start again; they rebuild in ten matches, and
      // a wrong one would mislead for months.
      if (profile.speedUnitDetected) dropScaledBaselines(profile.speedUnitDetected + ' -> ' + found);
      profile.speedUnitDetected = found;
      log('[director] fart-enhed aflæst af feedet: ' + found);
    }
  }
  M.configureUnits(profile.speedUnit, profile.speedUnitDetected);

  const matchMetrics = timed('computeMetrics', () => M.computeMetrics(digest, v.me));
  // Mutators read off the telemetry (6/9): computeMetrics has already left
  // every boostBound metric absent, so nothing below can fold or rank one;
  // the list is stamped on the card so every surface can SAY so.
  const mutators = M.mutatorsOf(digest, v.me);
  const snaps = M.snapshotAndFold(matchMetrics, pl, { idKnown: bucket.known, kind: bucket.kind });
  // judged against the standard, not a normal of his own (seed.js): the
  // receipt says so on every row, and the sentences are relabelled below
  const seeded = !!pl.seeded;
  if (seeded) for (const s of Object.values(snaps)) if (s.baseline) s.baseline.seeded = true;

  const score = digest.teams && digest.teams.length === 2 ? [digest.teams[0].score, digest.teams[1].score] : [0, 0];
  // score stays in team order as raw evidence, but every SENTENCE reads
  // "you-them" — otherwise a win is phrased as "Sejr 3-4"
  const myScore = (v.me.team === 1 ? [score[1], score[0]] : score).join('-');
  const facts = { playlist, score, myScore, result: M.resultOf(digest, v.me.team), me: v.me };

  const collecting = baselineN < M.MIN_BASELINE;
  const lines = collecting
    ? (EN()
      ? { ros: { text: (facts.result === 'W' ? 'Win ' : facts.result === 'L' ? 'Loss ' : 'Match ') + myScore + ' — ' + v.me.goals + 'G ' + v.me.assists + 'A ' + v.me.saves + 'SV, ' + v.me.touches + ' touches.', metricId: null },
          problem: { text: baselineN + 1 >= M.MIN_BASELINE
              ? 'Baseline ready (' + (baselineN + 1) + '/' + M.MIN_BASELINE + ' ' + playlist + ' matches) — full debrief from the next match.'
              : 'Baseline: ' + (baselineN + 1) + '/' + M.MIN_BASELINE + ' ' + playlist + ' matches — I am still learning your game, and I never guess before there is enough data.', metricId: null, ruleId: null },
          advice: { text: 'Play like you usually do — I measure in the background.', ruleId: null, source: null } }
      : { ros: { text: (facts.result === 'W' ? 'Sejr ' : facts.result === 'L' ? 'Nederlag ' : 'Kamp ') + myScore + ' — ' + v.me.goals + 'G ' + v.me.assists + 'A ' + v.me.saves + 'SV, ' + v.me.touches + ' touches.', metricId: null },
          problem: { text: baselineN + 1 >= M.MIN_BASELINE
              ? 'Baseline klar (' + (baselineN + 1) + '/' + M.MIN_BASELINE + ' ' + playlist + '-kampe) — fuld debrief fra næste kamp.'
              : 'Baseline: ' + (baselineN + 1) + '/' + M.MIN_BASELINE + ' ' + playlist + '-kampe — jeg lærer stadig dit spil og gætter ikke før der er data nok.', metricId: null, ruleId: null },
          advice: { text: 'Spil som du plejer — jeg måler i baggrunden.', ruleId: null, source: null } })
    : selectLines(snaps, facts);
  applyAdviceSilence(lines, collecting, baselineN);
  if (seeded) relabelLines(lines);

  const debrief = {
    schema: 'debrief/1', packVersion: PACK_VERSION, at: new Date().toISOString(),
    // score stays in team order (raw evidence); myTeam lets every surface show
    // it from the player's perspective, so a win never reads as "W 3-4"
    match: { file: fileName || null, guid: digest.guid || null, playlist, score, result: facts.result,
             myTeam: v.me.team, arena: digest.arena || null, abandoned: !!digest.abandoned,
             // what the game said the match was (17/8): size label, raw id, kind
             // and whether the kind is MEASURED (kindKnown:false = id-less
             // digest, kept under the size label, never reclassified)
             playlistSize: bucket.size, playlistId: bucket.id, matchKind: bucket.kind,
             kindKnown: bucket.known, matchType: bucket.name,
             // mutators read off the match (6/9): [] for a normal match, else
             // e.g. ['unlimited_boost'] — the boostBound metrics are absent
             mutators },
    collecting, baselineN: baselineN + 1,
    // The unit THIS match was measured in, stamped on the debrief. Every stored
    // number in it is in that unit forever, so a later change of setting must
    // not relabel it — lastDebrief() reads this back before it rebuilds a tape.
    speedUnit: M.unitFor('speed_avg') ? M.currentUnit() : null,
    // the player's own line from this match — kept on the debrief so the M3
    // voice layer can quote goals/saves/touches without re-reading the digest
    me: { goals: v.me.goals, assists: v.me.assists, saves: v.me.saves,
          shots: v.me.shots, touches: v.me.touches },
    // who this card is about (guest mode, 19/8): the board tags a guest's
    // card, and a stored debrief says whose evening it was
    coachee: { pid: profile.trackedPid, name: profile.trackedName || '', guest: isGuest() },
    // true when the bucket's normal is the STANDARD laid down in advance
    // (guest mode): "your normal" reads "the standard" everywhere on this card
    seeded,
    voiced: false,
    tape: buildTape(snaps, [lines.ros.metricId, lines.problem.metricId], mutators),   // see buildTape()
    ros: lines.ros, problem: lines.problem, advice: lines.advice,
    metrics: Object.values(snaps).map(s => ({                     // full evidence trail ("kvitteringen")
      id: s.id, value: s.value, samples: s.samples,
      baseline: s.baseline, delta: s.delta, evidence: s.evidence
    })),
    // The curve, thinned for the board (M4b §4). Goals ride along so the chart
    // can mark them: the whole point of a curve over a sum is being able to see
    // WHEN something changed, and a goal is the most likely reason it did.
    curve: buildCurve(digest, v.me),
    // The one-tap question (M4b §5b). Sent with the debrief so the page never
    // has to fetch anything to ask it, and so a board that missed the push
    // still gets it from /api/debrief.
    label: { ask: EN() ? 'How did it feel?' : 'Hvordan føltes den?', options: labelOptions(), unit: M.unitFor('speed_avg') }
  };

  if (fileName) profile.seen[fileName] = 1;
  profile.recentDebriefs.unshift(debrief);
  profile.recentDebriefs = profile.recentDebriefs.slice(0, 10);
  timed('saveProfile', saveProfile);
  timed('writeReport', () => writeReport(debrief, fileName));

  // feed the session engine — every valid match counts, collecting included
  try{ timed('session.onMatch', () => session.onMatch({ file: fileName || null, digest, debrief })); }
  catch(e){ log('[session] fejl: ' + (e.message || e)); }
  try{ const f = timed('form.update', () => form.update()); if (f) broadcast({ Event: '_form', Data: f }); }catch{}

  log('[director] debrief (' + playlist + (facts.result ? ', ' + facts.result : '') + (collecting ? ', indsamler' : '')
    + (mutators.length ? ', ' + M.mutatorLabel(mutators, false) + ' — boost/afstand/slagkraft ikke målt' : '') + '): ' + lines.problem.text);

  // M3: the template debrief above is final and already on its way to the
  // board. The voice layer only ever REPLACES it, asynchronously, and only if
  // every number it wrote survives the grounding validator. Deliberately not
  // awaited: the recorder must never wait on a network call, and a debrief
  // that arrives a second late is still inside the design's 2-5s window.
  // Baseline-collecting matches are skipped — those lines are a status
  // message about data, not coaching, and there is nothing to say better.
  if (!collecting && voice.ready()){
    voice.speak(debrief, profile.recentDebriefs.slice(1))
      .then(v => { if (v) applyVoice(debrief, fileName, v); })
      .catch(e => log('[voice] uventet fejl (skabelon beholdes): ' + (e && e.message || e)));
  }
  return debrief;
}

/* The debrief for a private lobby: the match's own numbers as evidence (the
 * tape and curve still show WHAT happened), but no baseline column, no delta,
 * no fold, no voice. `match.private` is what every downstream surface keys on
 * (session.js, weekly.js, the board); `match.matchType` says what the game
 * called it, or that the verdict is the player's own. Same shape as a normal
 * debrief so nothing that reads one has to learn a second one. */
function privateCard(digest, fileName, v, bucket){
  const en = EN();
  const playlist = bucket.key;                    // the size label — a private lobby has no bucket
  const priv = M.privacyOf(digest);
  const matchType = M.privateLabel(digest, en);
  M.configureUnits(profile.speedUnit, profile.speedUnitDetected);
  const matchMetrics = M.computeMetrics(digest, v.me);
  const mutators = M.mutatorsOf(digest, v.me);
  const snaps = {};
  for (const id of Object.keys(matchMetrics)){
    const m = matchMetrics[id];
    snaps[id] = { id, value: m.value, samples: m.samples, evidence: m.evidence,
                  baseline: null, delta: null, deltaPct: null, gated: true };
  }
  const score = digest.teams && digest.teams.length === 2 ? [digest.teams[0].score, digest.teams[1].score] : [0, 0];
  const myScore = (v.me.team === 1 ? [score[1], score[0]] : score).join('-');
  const result = M.resultOf(digest, v.me.team);
  const plName = profile.playlists[playlist];
  const baselineN = plName && typeof plName === 'object' && Number.isFinite(plName.n) ? plName.n : 0;
  const lines = en
    ? { ros: { text: (result === 'W' ? 'Win ' : result === 'L' ? 'Loss ' : 'Match ') + myScore + ' — ' + v.me.goals + 'G ' + v.me.assists + 'A ' + v.me.saves + 'SV, ' + v.me.touches + ' touches.', metricId: null },
        problem: { text: 'Private lobby (' + matchType + ') — the match is saved and shown, but it does not count towards your normal, your W/L or the weekly report.', metricId: null, ruleId: null },
        advice: { text: 'Ranked and casual count as before — I keep measuring in the background.', ruleId: null, source: null } }
    : { ros: { text: (result === 'W' ? 'Sejr ' : result === 'L' ? 'Nederlag ' : 'Kamp ') + myScore + ' — ' + v.me.goals + 'G ' + v.me.assists + 'A ' + v.me.saves + 'SV, ' + v.me.touches + ' touches.', metricId: null },
        problem: { text: 'Privat lobby (' + matchType + ') — kampen er gemt og vises, men tæller ikke i din normal, dit W/L eller ugerapporten.', metricId: null, ruleId: null },
        advice: { text: 'Ranked og casual tæller som før — jeg måler videre i baggrunden.', ruleId: null, source: null } };
  const debrief = {
    schema: 'debrief/1', packVersion: PACK_VERSION, at: new Date().toISOString(),
    match: { file: fileName || null, guid: digest.guid || null, playlist, score, result,
             myTeam: v.me.team, arena: digest.arena || null, abandoned: !!digest.abandoned,
             private: true, privateSource: priv.source, matchType,
             playlistId: M.playlistIdOf(digest), playlistSize: bucket.size,
             matchKind: 'private', kindKnown: priv.source === 'playlistId',
             mutators },
    private: true,
    collecting: false, baselineN,
    speedUnit: M.unitFor('speed_avg') ? M.currentUnit() : null,
    me: { goals: v.me.goals, assists: v.me.assists, saves: v.me.saves,
          shots: v.me.shots, touches: v.me.touches },
    coachee: { pid: profile.trackedPid, name: profile.trackedName || '', guest: isGuest() },
    voiced: false,
    tape: buildTape(snaps, [], mutators),
    ros: lines.ros, problem: lines.problem, advice: lines.advice,
    metrics: Object.values(snaps).map(s => ({ id: s.id, value: s.value, samples: s.samples,
                                              baseline: null, delta: null, evidence: s.evidence })),
    curve: buildCurve(digest, v.me),
    label: { ask: en ? 'How did it feel?' : 'Hvordan føltes den?', options: labelOptions(), unit: M.unitFor('speed_avg') }
  };
  if (fileName) profile.seen[fileName] = 1;
  profile.recentDebriefs.unshift(debrief);
  profile.recentDebriefs = profile.recentDebriefs.slice(0, 10);
  timed('saveProfile', saveProfile);
  timed('writeReport', () => writeReport(debrief, fileName));
  // the session engine keeps the row (it is shown), and keeps it out of the numbers
  try{ timed('session.onMatch', () => session.onMatch({ file: fileName || null, digest, debrief })); }
  catch(e){ log('[session] fejl: ' + (e.message || e)); }
  try{ const f = timed('form.update', () => form.update()); if (f) broadcast({ Event: '_form', Data: f }); }catch{}
  log('[director] privat lobby (' + matchType + ', ' + playlist + (result ? ', ' + result : '') + ') — gemt, ikke målt: ' + (fileName || digest.guid || '?'));
  return debrief;
}

function writeReport(debrief, fileName){
  try{
    const rdir = path.join(dataDir(), 'reports');   // a guest's debriefs live with the guest
    fs.mkdirSync(rdir, { recursive: true });
    const rname = fileName ? fileName.replace(/\.json$/, '') : debrief.at.replace(/[:.]/g, '-').slice(0, 19);
    store.writeJSON(path.join(rdir, rname + '-debrief.json'), debrief, 1);   // served over HTTP: write atomically
  }catch(e){ log('[director] rapport-skrivefejl: ' + (e.message || e)); }
}

/* Swap the template lines for the voiced ones, in place. The debrief object is
 * the same reference that sits at profile.recentDebriefs[0], so persisting the
 * profile persists the revision — and re-broadcasting replaces the card on the
 * board rather than adding a second one. Metrics, evidence and baselines are
 * untouched: the voice layer never owns a number. */
function applyVoice(debrief, fileName, v){
  try{
    debrief.ros = v.ros;
    debrief.problem = v.problem;
    debrief.advice = v.advice;
    if (debrief.seeded) relabelLines(debrief);
    debrief.voiced = true;
    debrief.voice = v.meta;
    // The praise may now name a different metric than the template's (the
    // problem cannot — grounding.js binds it), and the tape was built for the
    // template's citations. Whatever the card claims gets its receipt row,
    // same rule as buildTape(); rebuilt from the debrief's own metrics, in the
    // unit it was measured in, and persisted with the voiced lines. (19/8)
    const tape = tapeWithCitations(debrief);
    if (tape) debrief.tape = tape;
    // the voice may have chosen a different bank entry than the template's
    // rotation — what was READ is what advances the rotation (19/8)
    if (v.advice && v.advice.bankId && profile && profile.adviceState){
      const st = profile.adviceState;
      if (!st.bank || typeof st.bank !== 'object') st.bank = {};
      st.bank[v.advice.bankId] = typeof st.n === 'number' ? st.n : 0;
    }
    saveProfile();
    writeReport(debrief, fileName);
    broadcast({ Event: '_director', Data: debrief });
    log('[voice] debrief omskrevet (' + v.meta.model + ', forsøg ' + v.meta.attempt
        + (v.meta.cacheRead ? ', ' + v.meta.cacheRead + ' cache-tokens' : ', ingen cache') + ')');
  }catch(e){ log('[voice] kunne ikke anvende svaret: ' + (e && e.message || e)); }
}

/* The tape a debrief SHOULD carry, given what its own sentences cite — or null
 * when the one it has already holds a receipt row for every cited metric (or
 * there is nothing to rebuild from). Rebuilt from the debrief's `metrics`, in
 * the unit this match was MEASURED in, not the unit that happens to be set
 * now: the stored values never change, and relabelling km/t as mph because the
 * setting moved afterwards would be a lie told by the formatting layer. The
 * live setting is put back straight after. */
function tapeWithCitations(d){
  const cited = [d.ros && d.ros.metricId, d.problem && d.problem.metricId].filter(Boolean);
  const mutators = d.match && Array.isArray(d.match.mutators) ? d.match.mutators : [];
  // a card that knows its mutator but whose stored tape has no row saying so
  // (written before 6/9) is rebuilt too — the note is a receipt like any other
  const missing = d.tape && (cited.some(id => !d.tape.some(r => r.id === id))
    || (M.hasMutator(mutators) && !d.tape.some(r => r.id === MUTATOR_ROW_ID)));
  if (!((!d.tape || missing) && Array.isArray(d.metrics) && d.metrics.length)) return null;
  const snaps = {};
  for (const m of d.metrics) if (M.DEFS[m.id]) snaps[m.id] = m;
  const now = M.currentUnit();
  try{
    if (d.speedUnit && d.speedUnit !== now) M.configureUnits(d.speedUnit, d.speedUnit);
    return buildTape(snaps, cited, mutators);
  }catch{ return null; }
  finally{ if (d.speedUnit && d.speedUnit !== now) M.configureUnits(now, now); }
}

function lastDebrief(){
  const d = profile && profile.recentDebriefs.length ? profile.recentDebriefs[0] : null;
  if (!d) return null;
  // Debriefs written before the tape existed carry the same evidence in
  // `metrics` — build the rows on the way out rather than making the user
  // play a match before the new card has anything in it. Not persisted: the
  // stored debrief stays exactly as it was written.
  // Rebuild when the tape is missing OR when it has no row for a metric the
  // card's own sentences name — a debrief written before buildTape learned to
  // carry cited metrics would otherwise keep quoting a number with no receipt.
  const tape = tapeWithCitations(d);
  return tape ? Object.assign({}, d, { tape }) : d;
}

/* Session-engine passthroughs (server.js only ever talks to the director). */
function onGameDisconnect(){
  try{ return session.onGameDisconnect(); }
  catch(e){ log('[session] fejl: ' + (e.message || e)); return null; }
}
function tick(){
  ensureWeekly();
  try{ return session.tick(); }
  catch(e){ log('[session] fejl: ' + (e.message || e)); return null; }
}
function onMatchStart(){
  try{ session.onMatchStart(); }catch{}
}
function sessionLatest(){
  try{ return session.latest(); }catch{ return null; }
}
function sessionCurrent(){
  try{ return session.current(); }catch{ return null; }
}
/* Banekortets session-vindue (8/9): aftenens kampfiler, se session.files. */
function sessionFiles(){
  try{ return session.files(); }catch{ return null; }
}
/* The match BEFORE the last one — the Coach panel speaks about "last + previous".
 * Returned as stored: its texts keep the language and unit they were written
 * in, the same permanence rule every saved debrief follows. */
function prevDebrief(){
  return profile && profile.recentDebriefs.length > 1 ? profile.recentDebriefs[1] : null;
}

/* "Dagens fokus": derived from the latest session report and the latest closed
 * weekly report (whose "focus for next week" opens the week — the M4 coupling,
 * 17/8), so it changes only when a report lands — never mid-session, never
 * mid-match. focus.pick() is the one place the choice is made; weekly.js
 * replays the archive through the same function for the proof section. */
function focus(){
  try{
    // a guest has no weekly (the week is the owner's), so the card is the
    // guest's own latest session and nothing else
    const f = focusEngine.pick(session.latest(), isGuest() ? null : weekly.latest());
    if (!f) return null;
    // A guide's own words for the focus metric (19/8): decoration on the way
    // OUT, never on the stored/replayed focus — weekly.js rebuilds the proof
    // rows through focusEngine.pick() directly and must stay byte-identical.
    // Seeded by the focus' own timestamp, so the same focus shows the same
    // quote for as long as it stands, and a new focus may show another.
    const guide = persona.guideFor(f.metricId, f.at || f.metricId);
    return guide ? Object.assign({}, f, { guide }) : f;
  }catch{ return null; }
}
/* A weekly landing can move the card (its focusNext opens the week), so the
 * new focus goes out in the same breath as the weekly — the board would
 * otherwise show last week's evening focus until someone reconnected. */
function ensureWeekly(where){
  let r = null;
  if (isGuest()) return null;                      // the week is the owner's; closed when he is back
  try{ r = timed('weekly.ensure', () => weekly.ensure()); }catch(e){ log('[weekly] fejl' + (where ? ' ' + where : '') + ': ' + (e.message || e)); }
  if (r){ try{ const f = focus(); if (f) broadcast({ Event: '_focus', Data: f }); }catch{} }
  return r;
}
/* Live reading of the focus metric on the match in progress (server.js hands
 * in the recorder's in-flight match). */
function focusLive(recMatch){
  try{ return focusEngine.live(focus(), recMatch, profile && profile.trackedPid); }
  catch{ return null; }
}

/* The full rank curve rides along on the weekly payload (25/8) — the graph
 * page and the Weekly panel draw from it. Owner only: the curve is the
 * owner's progression file, and a guest's board has no business showing it.
 * Attached here rather than in server.js for the same reason as lastWeekUrl:
 * no exe change, and /api/weekly stays the one carrier. */
function withRankHistory(w){
  if (!w || isGuest()) return w;
  try{
    const rh = weekly.rankHistory();
    return rh ? Object.assign({}, w, { rankHistory: rh }) : w;
  }catch{ return w; }
}

/* M4 passthroughs. `weeklyCurrent` rebuilds the running week on demand — it is
 * a read over reports/ with a directory-listing cache, so the board may ask as
 * often as it likes. */
function weeklyCurrent(){
  try{
    const cur = timed('weekly.current', () => weekly.current());
    if (!cur) return null;
    /* Carry a pointer to the last CLOSED week's report.
     *
     * Without it the corner shows the running week — which has no report yet,
     * so it has no link — and the finished weekly is reachable only by knowing
     * the filename. The one surface that would have told him it exists is the
     * one showing something newer. Attached here rather than in server.js so
     * the SSE replay and /api/weekly cannot disagree, and so it needs no exe. */
    const last = weekly.latestSummary();
    if (last && last.url && last.key !== cur.key)
      return withRankHistory(Object.assign({}, cur, { lastWeekUrl: last.url, lastWeekNo: last.week }));
    return withRankHistory(cur);
  }catch(e){ log('[weekly] fejl: ' + (e.message || e)); return null; }
}
function weeklyLatest(){
  try{ return withRankHistory(weekly.latestSummary()); }catch{ return null; }
}
/* Every fresh rank lookup passes through here so the weekly can draw a curve.
 * Only the tracked player is recorded — opponents' ranks are looked up for the
 * board and forgotten, and building a history of other people's accounts is
 * not something this product should start doing. */
function onRank(pid, data){
  // the rank curve is the OWNER's only — a guest's lookups are shown, never kept
  try{ weekly.onRank(!!(profile && !isGuest() && profile.trackedPid && pid === profile.trackedPid), data); }
  catch(e){ log('[weekly] rank-fejl: ' + (e.message || e)); }
}

function formCurrent(){ try{ return form.current(); }catch{ return null; } }
module.exports = { init, onDigest, lastDebrief, prevDebrief, onGameDisconnect, onMatchStart, tick,
                   sessionLatest, sessionCurrent, sessionFiles, focus, focusLive, setTracked, getTracked, formCurrent,
                   weeklyCurrent, weeklyLatest, onRank,
                   setUnit, getUnit, setMatchLabel, LABELS,
                   tapeWithCitations,            // pure; exported for director/test
                   PACK_VERSION };
