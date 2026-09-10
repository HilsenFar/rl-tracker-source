'use strict';
/* Form — the body barometer (23/8-2026). LOCAL ONLY.
 *
 * Born from the K4W blind test (22-23/8-2026, rl-director/k4w-rosen-blindtest/):
 * a prediction of "off" windows written from telemetry alone, sealed, and then
 * held against his own messages, a video and the pharmacy's dispensing dates.
 * Two of three flare-ups showed in the numbers within 1-3 days — but in TWO
 * different ways, which is why this module carries more than one rule:
 *
 *   relapse  (6/8)   speed, airtime, touches and kickoff approach all low for
 *                    three play-days in a row, then back to normal
 *   onset    (27/7)  results collapse (8 losses of 10) and three nights awake
 *                    at the PC — while the movement numbers looked fine
 *   treatment(30/7)  the days right after a medication switch were his BEST
 *                    — so the barometer measures both directions
 *
 * Contract (the player's, not ours):
 *   - It measures BEHAVIOUR and says so in behaviour words: "speed and airtime
 *     have been low for 3 play-days". Never "ill", never "tilted". What a low
 *     reading means is the player's to decide — measurement as an ally.
 *   - It stays on this machine. form-state.json is deliberately NOT on the
 *     feedback allow-list (feedback.js candidates()) and no LLM ever sees it.
 *   - Every rule is silent until the data carries it: a baseline of at least
 *     MIN_BASE matches in the playlist size, at least MIN_MATCHES matches in
 *     the window, and a robust z-score (median/MAD), so one wild match cannot
 *     trip it.
 *   - Rates are compared within the same playlist size (1v1/2v2/3v3), pooled
 *     across ranked/casual: a player's speed does not change with the queue.
 *
 * Input is the local debrief files (reports/*-debrief.json) — the same data
 * the session and weekly reports are built from — so a replay rebuilds the
 * same state. Nothing here writes anywhere but form-state.json. */

const fs = require('fs');
const path = require('path');
const store = require('./store.js');
const M = require('./metrics.js');

const DAY_START_HOUR = 6;          // a play-day runs 06:00 → 06:00, as in weekly.js
const NIGHT_BEFORE = 6;            // a match that starts before 06:00 local is a night match
const BASE_DAYS = 60;              // baseline window (calendar days back from now)
const MIN_BASE = 12;               // matches per playlist size before a z-score is trusted
const WINDOW_PLAYDAYS = 3;         // the barometer reads the last 3 play-days with data
const WINDOW_MAX_BACK = 5;         // ...but never further back than 5 calendar days (a 3-day dip must not straddle a week's gap)
const MIN_MATCHES = 8;             // matches those play-days must carry before the physical rule speaks
const MIN_RESULT_MATCHES = 10;     // ...and before the results rule speaks
const NIGHT_MIN_PER_NIGHT = 3;     // a "night" = at least 3 matches before 06:00
const NIGHT_MIN_NIGHTS = 2;        // ...on at least 2 of the last 3 nights
/* Physical index thresholds. The mean must be BOTH meaningfully off (LOW/HIGH,
 * robust z units) and statistically clear of noise: |mean|·√n / PHYS_SD ≥ SIG,
 * with PHYS_SD the per-match spread of the index measured in the blind test
 * (0.71). So 22 matches at −0.4 speak, 8 matches at −0.4 do not (they need −0.6). */
const LOW = -0.3, VERY_LOW = -0.7, HIGH = 0.3, PHYS_SD = 0.7, SIG = 2.5;
const PERSIST_DAY = -0.15;         // a play-day counts as "low" for persistence at or below this
const PERSIST_MIN = 2;             // ...and at least 2 of the window's play-days (and at least half) must be low
const NIGHT_REL = 1.5;             // night share in the window must be 1.5× the player's own 60-day night share
const LOSING_Z = -2;               // binomial z of the window's wins against the baseline win rate
const SERIES_DAYS = 28;            // play-days kept for the sparkline
const PHYS = ['speed_avg', 'airborne_share', 'touches_per_min', 'kickoff_self_speed'];
const Z_CAP = 3;

let ROOT = null, DIR = null, log = () => {};
let state = null;

const p2 = n => String(n).padStart(2, '0');
function playDay(iso){
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - DAY_START_HOUR * 3600e3);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
function calDay(t){ const d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const mad = a => { const m = median(a); const d = median(a.map(x => Math.abs(x - m))); return d == null ? null : 1.4826 * d; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = v => Math.round(v * 100) / 100;
const EN = () => { try{ return M.currentLanguage() === 'en'; }catch{ return false; } };

function statePath(){ return path.join(ROOT, 'form-state.json'); }
function defaultState(){ return { schema: 'form/1', local: true, at: null, summary: null, signals: [], series: [], baseline: {} }; }

function init(opts){
  ROOT = opts.root;
  DIR = opts.reportsDir || (() => path.join(ROOT, 'reports'));
  log = opts.log || log;
  state = store.readJSON(statePath(), defaultState);
  if (!state || state.schema !== 'form/1') state = defaultState();
  return module.exports;
}

/* The debriefs this machine holds for the current coachee: one per valid
 * match, with the engine's metric values. Setup/seed notes and abandoned
 * matches are skipped. */
function loadDebriefs(dir){
  let names = [];
  try{ names = fs.readdirSync(dir); }catch{ return []; }
  const out = [];
  for (const f of names){
    if (!f.endsWith('-debrief.json')) continue;
    let j = null;
    try{ j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }catch{ continue; }
    if (!j || j.setup || !j.match || !j.at || j.match.abandoned || !Array.isArray(j.metrics)) continue;
    out.push(j);
  }
  return out;
}

/* When the match was played. The recorder names the match file by the UTC
 * start time (2026-08-21T15-59-50-<guid>.json). A debrief's own `at` is when
 * the DEBRIEF was written — after a profile rebuild that is the replay time
 * for every old match (K4W's 27/7 matches all carry at = 11/8). */
function matchTime(j){
  const f = j.match && j.match.file;
  const m = typeof f === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f);
  if (m) return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Date.parse(j.at);
}

/* Pure: debriefs → form state. `now` is injectable so a replay is deterministic. */
function build(debriefs, opts){
  const now = (opts && opts.now) || Date.now();
  const en = opts && typeof opts.en === 'boolean' ? opts.en : EN();
  const rows = [];
  for (const j of debriefs){
    const t = matchTime(j);
    if (!Number.isFinite(t) || t > now + 3600e3) continue;
    const size = j.match.playlistSize || j.match.playlist || '?';
    const vals = {};
    for (const m of j.metrics) if (m && typeof m.value === 'number' && PHYS.includes(m.id)) vals[m.id] = m.value;
    // Unlimited boost (6/9): the match counts for results and nights, but its
    // body reading is not a reading of the body — speed and air time are the
    // mutator's, and even touches/kickoff approach are driven under it. It
    // gets no physical index and does not enter the robust baseline.
    const mutated = Array.isArray(j.match.mutators) && j.match.mutators.length > 0;
    rows.push({ t, day: playDay(new Date(t).toISOString()), cal: calDay(t), night: new Date(t).getHours() < NIGHT_BEFORE,
                size, result: j.match.result === 'W' ? 'W' : j.match.result === 'L' ? 'L' : null, vals, file: j.match.file || null,
                mutated });
  }
  rows.sort((a, b) => a.t - b.t);

  // robust baselines per playlist size, from the last BASE_DAYS
  const since = now - BASE_DAYS * 864e5;
  const base = {};
  for (const r of rows){
    if (r.t < since || r.mutated) continue;
    const b = base[r.size] || (base[r.size] = { n: 0, metrics: {} });
    b.n++;
    for (const id of PHYS) if (r.vals[id] != null) (b.metrics[id] = b.metrics[id] || []).push(r.vals[id]);
  }
  const baseline = {};
  for (const [size, b] of Object.entries(base)){
    baseline[size] = { n: b.n, ready: b.n >= MIN_BASE, metrics: {} };
    for (const [id, v] of Object.entries(b.metrics)){
      if (v.length < MIN_BASE) continue;
      const md = median(v), s = mad(v);
      if (s && s > 1e-9) baseline[size].metrics[id] = { median: r2(md), mad: r2(s), n: v.length };
    }
  }

  // physical index per match: mean robust z over the movement-side metrics
  for (const r of rows){
    const bm = baseline[r.size] && baseline[r.size].metrics;
    const zs = [];
    if (bm && !r.mutated) for (const id of PHYS){
      const b = bm[id];
      if (b && r.vals[id] != null) zs.push(clamp((r.vals[id] - b.median) / b.mad, -Z_CAP, Z_CAP));
    }
    r.phys = zs.length >= 2 ? mean(zs) : null;
  }

  // play-days
  const byDay = new Map();
  for (const r of rows){
    if (!r.day) continue;
    const d = byDay.get(r.day) || { day: r.day, n: 0, w: 0, l: 0, night: 0, physSum: 0, physN: 0 };
    d.n++; if (r.result === 'W') d.w++; if (r.result === 'L') d.l++; if (r.night) d.night++;
    if (r.phys != null){ d.physSum += r.phys; d.physN++; }
    byDay.set(r.day, d);
  }
  const days = [...byDay.values()].sort((a, b) => a.day < b.day ? -1 : 1)
    .map(d => ({ day: d.day, n: d.n, w: d.w, l: d.l, night: d.night, phys: d.physN ? r2(d.physSum / d.physN) : null, physN: d.physN }));

  // the window: last WINDOW_PLAYDAYS play-days with data, no older than WINDOW_MAX_BACK days
  const oldest = calDay(now - WINDOW_MAX_BACK * 864e5);
  const win = days.filter(d => d.day >= oldest).slice(-WINDOW_PLAYDAYS);
  const wN = win.reduce((a, d) => a + d.n, 0);
  const wPhysN = win.reduce((a, d) => a + d.physN, 0);
  const wPhys = wPhysN ? win.reduce((a, d) => a + (d.phys == null ? 0 : d.phys * d.physN), 0) / wPhysN : null;
  const wW = win.reduce((a, d) => a + d.w, 0), wL = win.reduce((a, d) => a + d.l, 0);
  const span = win.length ? { from: win[0].day, to: win[win.length - 1].day, playDays: win.length } : null;

  // baseline win rate over the same 60 days
  const bw = rows.filter(r => r.t >= since && r.result);
  const pWin = bw.length >= 20 ? bw.filter(r => r.result === 'W').length / bw.length : null;

  // nights: the last 3 calendar nights (today counts), matches before 06:00
  const nights = [];
  for (let k = 0; k < 3; k++){
    const cal = calDay(now - k * 864e5);
    nights.push({ cal, n: rows.filter(r => r.cal === cal && r.night).length });
  }
  const nightHits = nights.filter(x => x.n >= NIGHT_MIN_PER_NIGHT);
  const nightN = nightHits.reduce((a, x) => a + x.n, 0);
  // the player's own night habit, outside these 3 nights: a habitual night
  // player is not told every day that he plays at night
  const nightCals = new Set(nights.map(x => x.cal));
  const habit = rows.filter(r => r.t >= since && !nightCals.has(r.cal));
  const habitShare = habit.length >= 20 ? habit.filter(r => r.night).length / habit.length : null;
  const recent = rows.filter(r => nightCals.has(r.cal));
  const recentShare = recent.length ? recent.filter(r => r.night).length / recent.length : 0;
  const nightUnusual = habitShare == null || recentShare >= Math.max(0.25, NIGHT_REL * habitShare);

  const signals = [];
  const fmtZ = v => (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', en ? '.' : ',');
  const pd = (k) => en ? (k + ' play-day' + (k === 1 ? '' : 's')) : (k + ' spilledag' + (k === 1 ? '' : 'e'));

  const sig = wPhys == null ? 0 : Math.abs(wPhys) * Math.sqrt(wPhysN) / PHYS_SD;
  // persistence: a body reading is about DAYS, not one bad evening — at least
  // PERSIST_MIN of the window's play-days (and at least half of them) must be
  // low on their own before the window's mean may speak
  const lowDays = win.filter(d => d.phys != null && d.physN >= 2 && d.phys <= PERSIST_DAY).length;
  const persistent = lowDays >= PERSIST_MIN && lowDays * 2 >= win.length;
  const highDays = win.filter(d => d.phys != null && d.physN >= 2 && d.phys >= -PERSIST_DAY).length;
  const persistentHigh = highDays >= PERSIST_MIN && highDays * 2 >= win.length;
  if (span && wPhys != null && wPhysN >= MIN_MATCHES && sig >= SIG){
    if (wPhys <= LOW && persistent){
      const very = wPhys <= VERY_LOW;
      signals.push({ id: 'phys_low', level: very ? 'verylow' : 'low', value: r2(wPhys), n: wPhysN, from: span.from, to: span.to,
        text: en
          ? 'Speed, airtime, touches and kickoff approach have been ' + (very ? 'well ' : '') + 'below your normal for ' + pd(span.playDays) + ': ' + fmtZ(wPhys) + ' (' + wPhysN + ' matches).'
          : 'Fart, luft-tid, berøringer og kickoff-tilgang har ligget ' + (very ? 'langt ' : '') + 'under din normal i ' + pd(span.playDays) + ': ' + fmtZ(wPhys) + ' (' + wPhysN + ' kampe).' });
    } else if (wPhys >= HIGH && persistentHigh){
      signals.push({ id: 'phys_high', level: 'high', value: r2(wPhys), n: wPhysN, from: span.from, to: span.to,
        text: en
          ? 'Speed, airtime and touches above your normal for ' + pd(span.playDays) + ': ' + fmtZ(wPhys) + ' (' + wPhysN + ' matches).'
          : 'Fart, luft-tid og berøringer over din normal i ' + pd(span.playDays) + ': ' + fmtZ(wPhys) + ' (' + wPhysN + ' kampe).' });
    }
  }
  if (span && pWin != null && wW + wL >= MIN_RESULT_MATCHES){
    const n = wW + wL, z = (wW - n * pWin) / Math.sqrt(n * pWin * (1 - pWin));
    if (z <= LOSING_Z){
      signals.push({ id: 'losing', level: 'note', value: r2(z), n, from: span.from, to: span.to,
        text: en
          ? 'Lost ' + wL + ' of ' + n + ' over the last ' + pd(span.playDays) + ' — you normally win ' + Math.round(pWin * 100) + '%.'
          : 'Tabt ' + wL + ' af ' + n + ' de sidste ' + pd(span.playDays) + ' — normalt vinder du ' + Math.round(pWin * 100) + ' %.' });
    }
  }

  // night last: the body and the results outrank the clock in the summary
  if (nightHits.length >= NIGHT_MIN_NIGHTS && nightUnusual){
    signals.push({ id: 'night', level: 'note', value: nightHits.length, n: nightN,
      text: en
        ? 'Matches between 00:00 and 06:00 on ' + nightHits.length + ' of the last 3 nights (' + nightN + ' matches).'
        : 'Kampe mellem kl. 00 og 06 ' + nightHits.length + ' af de sidste 3 nætter (' + nightN + ' kampe).' });
  }
  // summary line
  let summary;
  const readySizes = Object.entries(baseline).filter(([, b]) => b.ready).map(([s]) => s);
  if (!rows.length) summary = en ? 'No matches yet.' : 'Ingen kampe endnu.';
  else if (!readySizes.length){
    const best = Object.entries(baseline).sort((a, b) => b[1].n - a[1].n)[0];
    summary = en ? 'Learning your normal: ' + best[1].n + '/' + MIN_BASE + ' matches in ' + best[0] + '.'
                 : 'Lærer din normal: ' + best[1].n + '/' + MIN_BASE + ' kampe i ' + best[0] + '.';
  }
  else if (!span) summary = en ? 'No matches in the last ' + WINDOW_MAX_BACK + ' days.' : 'Ingen kampe de sidste ' + WINDOW_MAX_BACK + ' dage.';
  else if (!signals.length){
    summary = wPhys == null || wPhysN < MIN_MATCHES
      ? (en ? 'Too few matches in the last ' + pd(span.playDays) + ' for a reading (' + wN + ').' : 'For få kampe de sidste ' + pd(span.playDays) + ' til en aflæsning (' + wN + ').')
      : (en ? 'As you usually play, last ' + pd(span.playDays) + ' (' + fmtZ(wPhys) + ', ' + wPhysN + ' matches).' : 'Som du plejer, de sidste ' + pd(span.playDays) + ' (' + fmtZ(wPhys) + ', ' + wPhysN + ' kampe).');
  } else summary = signals[0].text;

  return {
    schema: 'form/1', local: true, at: new Date(now).toISOString(),
    window: span ? { ...span, matches: wN, physMatches: wPhysN, phys: wPhys == null ? null : r2(wPhys), w: wW, l: wL } : null,
    baseline: Object.fromEntries(Object.entries(baseline).map(([s, b]) => [s, { n: b.n, ready: b.ready, winRate: pWin == null ? null : r2(pWin) }])),
    nights: { last3: nights, habitShare: habitShare == null ? null : r2(habitShare), recentShare: r2(recentShare) },
    signals,
    summary,
    series: days.slice(-SERIES_DAYS)
  };
}

function update(){
  if (!ROOT) return null;
  try{
    state = build(loadDebriefs(DIR()), {});
    store.writeJSON(statePath(), state);
    return state;
  }catch(e){ log('[form] fejl: ' + (e.message || e)); return state; }
}

function current(){ return state; }

module.exports = { init, update, current, build, loadDebriefs, playDay, matchTime,
                   PHYS, MIN_BASE, MIN_MATCHES, WINDOW_PLAYDAYS, LOW, VERY_LOW, HIGH, LOSING_Z };
