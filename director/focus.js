/* RL Director — "dagens fokus" (M2) + ugens fokus (M4-kobling, 17/8-2026).
 *
 * One thing to work on. Two sources feed it, and ONE function decides:
 *
 *  - the last session report: the metric that came out furthest below the
 *    player's own normal (M2, "how did tonight go");
 *  - the last closed weekly report: its `focusNext`, the week's worst mature
 *    trend, printed in the report as "Fokus til næste uge" (M4).
 *
 * Until 17/8 the two never met: the weekly promised a focus on paper, the card
 * kept reacting to each evening, and the proof section — which rebuilds the
 * focus history through this very file — could never judge the week's focus
 * because it was never in force. `pick()` closes that: the week opens on the
 * weekly's focus, and it stays on the card as long as the latest session still
 * measures it below normal. When an evening shows it reached, the evening's
 * worst metric takes over as before. An evening that never MEASURED it — no
 * match in the focus playlist — says nothing about it, so the week's focus
 * stands (from 6/9-2026, see KEEP_UNMEASURED_FROM). Until then such an evening
 * also handed the card to its own worst metric, which is how a 2v2-only
 * afternoon on 6/9 took the week's 3v3 focus off the card three matches before
 * the player played the 3v3 it was waiting for.
 *
 * The target is always the player's own normal — never an invented benchmark,
 * never someone else's number — and only a MATURE normal (>= MIN_BASELINE):
 * the per-match debrief refuses to judge below that, so a focus card must not
 * quietly undercut the gate. The weekly's focusNext is built from mature
 * trends only (weekly.js), so both sources honour it.
 *
 * The live meter measures the match in progress by running the PARTIAL digest
 * through the very same metric engine a finished match goes through. There is
 * no second implementation of any number anywhere (DESIGN §3: the metric
 * engine owns every number the coach ever says), so what the meter shows
 * during the match and what the debrief says after it are the same quantity.
 *
 * Deterministic: same reports in, same focus out. No clock, no randomness —
 * weekly.js replays the archive through pick() to rebuild what the card said,
 * so anything time-dependent here would make the proof section lie.
 */
'use strict';
const M = require('./metrics');

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const aim = (id, dir, v) => (dir > 0 ? '≥ ' : '≤ ') + M.fmt(id, v);
const EN = () => M.currentLanguage() === 'en';

/* Weekly reports written before this instant never drove the card — the
 * coupling did not exist — so pick() ignores them, live AND in the replay.
 * Without the cut-off the proof section would retroactively "measure" week
 * focuses the player never saw on the board (W31→W32, W32→W33), which is the
 * one thing it promises not to do. The W33 report (17/8 04:00:37Z) is the
 * first one that opens a week; no match had been played between it landing
 * and this shipping. */
const COUPLED_FROM = Date.parse('2026-08-17T04:00:00Z');

/* Same guard for the 6/9-2026 rule ("an unmeasured week focus stands"): a
 * session report older than this went through the old rule when it landed,
 * and the card really did switch — the replay must show what the card said,
 * not what it would have said. Sessions from this instant on keep the focus. */
const KEEP_UNMEASURED_FROM = Date.parse('2026-09-06T20:00:00Z');

/* Did the session measure this focus at all — a trend row for the metric in
 * the focus playlist with a number to judge? A session with no match in that
 * playlist has no row; so has an evening where the metric was gated off. */
function measuredIn(session, wf){
  return !!(session && Array.isArray(session.trends) && session.trends.some(t =>
    t.id === wf.metricId && (t.playlist || null) === wf.playlist && t.goodness !== null));
}

/* The session's trends that may carry a focus: below normal, with a baseline
 * to aim at, and a baseline mature enough to be worth aiming at. Trends are per
 * playlist, so the target is a real normal for one playlist — never a blend of
 * 1v1/2v2/3v3 that is reachable in none of them. Sorted worst first. */
function candidates(report){
  if (!report || !Array.isArray(report.trends)) return [];
  return report.trends
    .filter(t => M.DEFS[t.id] && t.goodness !== null && t.goodness < 0
      && Number.isFinite(t.baselineAvg) && (t.baselineN || 0) >= M.MIN_BASELINE)
    .sort((a, b) => a.goodness - b.goodness);
}

function fromCandidate(report, pick, weekOf){
  const def = M.DEFS[pick.id];
  const pl = pick.playlist || null;
  const n = pick.n | 0;
  const wk = weekOf ? (EN() ? 'Week ' + weekOf.week + '\'s focus. ' : 'Ugens fokus (uge ' + weekOf.week + '). ') : '';
  return {
    schema: 'focus/1',
    at: report.at,
    source: weekOf ? 'weekly' : 'session',   // where the focus came from; the proof rows show it
    weekKey: weekOf ? weekOf.key : null,
    metricId: pick.id,
    playlist: pl,                       // the meter only judges matches in THIS playlist
    label: M.labelWithUnit(pick.id),
    direction: def.direction,
    target: pick.baselineAvg,
    baselineN: pick.baselineN || 0,
    triggerValue: Number.isFinite(pick.sessionAvg) ? pick.sessionAvg : null,
    targetText: aim(pick.id, def.direction, pick.baselineAvg),
    headline: cap(M.labelWithUnit(pick.id)) + ' ' + aim(pick.id, def.direction, pick.baselineAvg) + (pl ? ' (' + pl + ')' : ''),
    why: wk + (EN()
       ? 'Last session: ' + M.fmt(pick.id, pick.sessionAvg) + ' against your normal '
         + M.fmt(pick.id, pick.baselineAvg) + (pl ? ' in ' + pl : '')
         + ' across ' + n + ' match' + (n === 1 ? '' : 'es') + '.'
       : 'Sidste session: ' + M.fmt(pick.id, pick.sessionAvg) + ' mod normalt '
         + M.fmt(pick.id, pick.baselineAvg) + (pl ? ' i ' + pl : '')
         + ' over ' + n + ' kamp' + (n === 1 ? '' : 'e') + '.'),
    session: { name: report.name || null, url: report.url || null, at: report.at }
  };
}

/* session report -> focus, or null while there is nothing measured to focus on. */
function fromReport(report){
  const pick = candidates(report)[0];
  return pick ? fromCandidate(report, pick, null) : null;
}

/* closed weekly report -> its "focus for next week" as a focus card, or null.
 * The numbers are the report's own (target = the normal the week was judged
 * against; trigger = the week's average from the stored trend row), so the
 * card says exactly what the report the player read said. */
function fromWeekly(weekly){
  const fn = weekly && weekly.closed && weekly.focusNext;
  if (!fn || !M.DEFS[fn.metricId] || !Number.isFinite(fn.target)) return null;
  if (!(Date.parse(weekly.at) >= COUPLED_FROM)) return null;
  const def = M.DEFS[fn.metricId];
  const pl = fn.playlist || null;
  // reports written before 17/8 carry the week's average only in the trend
  // row; newer ones also stamp it on focusNext itself — same number either way
  const t = (weekly.trends || []).find(t => t.id === fn.metricId && t.playlist === fn.playlist) || null;
  const weekAvg = Number.isFinite(fn.weekAvg) ? fn.weekAvg : t && Number.isFinite(t.weekAvg) ? t.weekAvg : null;
  const n = Number.isFinite(fn.n) ? fn.n | 0 : t ? t.n | 0 : 0;
  const why = weekAvg !== null
    ? (EN()
      ? 'Week ' + weekly.week + '\'s focus, from its report: ' + M.fmt(fn.metricId, weekAvg) + ' on average against your normal '
        + M.fmt(fn.metricId, fn.target) + (pl ? ' in ' + pl : '') + ' across ' + n + ' match' + (n === 1 ? '' : 'es') + '.'
      : 'Ugens fokus fra uge ' + weekly.week + '-rapporten: ' + M.fmt(fn.metricId, weekAvg) + ' i snit mod normalt '
        + M.fmt(fn.metricId, fn.target) + (pl ? ' i ' + pl : '') + ' over ' + n + ' kamp' + (n === 1 ? '' : 'e') + '.')
    : (EN() ? 'Week ' + weekly.week + '\'s focus, from its report. ' : 'Ugens fokus fra uge ' + weekly.week + '-rapporten. ') + (fn.why || '');
  return {
    schema: 'focus/1',
    at: weekly.at,
    source: 'weekly',
    weekKey: weekly.key || null,
    metricId: fn.metricId,
    playlist: pl,
    label: M.labelWithUnit(fn.metricId),
    direction: def.direction,
    target: fn.target,
    baselineN: t && Number.isFinite(t.baselineN) ? t.baselineN : null,
    triggerValue: weekAvg,
    targetText: aim(fn.metricId, def.direction, fn.target),
    headline: cap(M.labelWithUnit(fn.metricId)) + ' ' + aim(fn.metricId, def.direction, fn.target) + (pl ? ' (' + pl + ')' : ''),
    why,
    session: { name: null, url: weekly.url || null, at: weekly.at }
  };
}

/* THE decision. `session` = the latest session report, `weekly` = the latest
 * CLOSED weekly report; either may be null.
 *
 *  1. No weekly focus → the session's worst metric (M2 as before).
 *  2. No session since the weekly landed (the week has not been played yet)
 *     → the weekly's focus opens the week, as printed in the report.
 *  3. Otherwise the week's focus stays while the latest session still measures
 *     it below normal — the evening's numbers, the evening's target (the
 *     freshest normal, the one the debrief and the meter also judge against).
 *     Reached → the evening's worst, as before.
 *  4. Not measured that evening (no match in the focus playlist) → the week's
 *     focus stands, as printed in the report (6/9-2026; sessions before
 *     KEEP_UNMEASURED_FROM fall through to the evening's worst, as they did).
 *
 * Both director.focus() and weekly.focusTimeline() call this and nothing else,
 * so the proof section can never measure a focus the player did not see. */
function pick(session, weekly){
  const wf = fromWeekly(weekly);
  if (!wf) return fromReport(session);
  if (!session || !(Date.parse(session.at) > Date.parse(weekly.at))) return wf;
  const cands = candidates(session);
  const kept = cands.find(t => t.id === wf.metricId && (t.playlist || null) === wf.playlist);
  if (kept) return fromCandidate(session, kept, { key: weekly.key, week: weekly.week });
  if (Date.parse(session.at) >= KEEP_UNMEASURED_FROM && !measuredIn(session, wf)) return wf;
  return cands.length ? fromCandidate(session, cands[0], null) : null;
}

/* Measure the focus metric on the match in progress.
 * `rec` is the recorder's in-flight match object — the same shape a digest
 * has, minus endedAt, so stamp a provisional one for duration-based metrics.
 * Returns null while the metric has too few samples to be worth showing;
 * minSamples in the registry decides that, not this file.
 */
function live(focus, rec, trackedPid){
  if (!focus || !rec || !Array.isArray(rec.players) || !rec.players.length) return null;
  const me = rec.players.find(p => p.pid === trackedPid);
  if (!me) return null;
  // a private lobby is never measured against the player's normal (user's
  // decision 15/8), so the meter stays dark for it — the recorder stamps
  // playlistId on the in-flight match from the first UpdateState frame
  if (M.isPrivate(rec) === true) return null;
  // the target is one playlist's normal — measuring a 2v2 against a 1v1 normal
  // would show a bar the player cannot fairly move. Same bucket key as the
  // debrief (metrics.bucketOf, 17/8): a casual match in progress is not
  // measured against the '3v3' focus (tournaments are — they count with
  // ranked), and the in-flight record already carries playlistId from its
  // first UpdateState frame.
  if (focus.playlist){
    let pl = null;
    try{ pl = M.bucketOf(rec).key; }catch{ pl = null; }
    if (pl && pl !== focus.playlist) return null;
  }
  const partial = Object.assign({}, rec, { endedAt: new Date().toISOString() });
  let m;
  try{ m = M.computeMetrics(partial, me)[focus.metricId]; }catch{ return null; }
  if (!m || !Number.isFinite(m.value)) return null;

  const onTarget = focus.direction > 0 ? m.value >= focus.target : m.value <= focus.target;
  // meter fill: 1.0 means "exactly your normal". Inverted metrics (lower is
  // better) are flipped so a full bar always means doing well.
  let ratio = null;
  if (Number.isFinite(focus.target) && focus.target !== 0)
    ratio = focus.direction > 0 ? m.value / focus.target
          : (m.value === 0 ? 1.5 : focus.target / m.value);
  if (ratio !== null) ratio = Math.max(0, Math.min(1.5, ratio));

  return {
    schema: 'focus-live/1',
    metricId: focus.metricId, label: focus.label, direction: focus.direction,
    value: m.value, valueText: M.fmt(focus.metricId, m.value),
    target: focus.target, targetText: focus.targetText,
    samples: m.samples, onTarget, ratio
  };
}

module.exports = { fromReport, fromWeekly, pick, live, KEEP_UNMEASURED_FROM };
