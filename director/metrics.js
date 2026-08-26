/* RL Director — metric engine (M1).
 * Pure functions only: digest in, numbers out. No I/O, no clocks, no LLM.
 * Contract per rl-director/DESIGN.md §3: every number the coach ever says
 * is born here; templates and rules may only quote these values.
 */
'use strict';

const MIN_BASELINE = 10;   // matches folded into a baseline before advice fires (DESIGN §4)
const EWMA_ALPHA = 0.1;    // ~ last 20 matches carry the weight
const BOOST_LOW_AT = 15;   // recorder counts samples with Boost < 15 (fixed at capture time)

/* ---------------- speed units (M4b) ----------------
 * Players[].Speed is a bare scalar. The feed never names its unit, so it was
 * measured instead, against a running match on 2026-07-27:
 *
 *   - across 50k+ frames and three players the value NEVER exceeded 82.800,
 *     and hit exactly 82.800 repeatedly — a clamp, not a coincidence
 *   - Rocket League's own constants are supersonic 2200 uu/s and max car speed
 *     2300 uu/s, with 1 uu = 1 cm  (RLBot, "Useful Game Values":
 *     https://github.com/RLBot/RLBot/wiki/Useful-Game-Values — "1 uu = 1 cm
 *     (e.g. 2778 uu/s = 100 km/h)")
 *   - 2300 uu/s x 0.036 = 82.80 km/h exactly, and the observed supersonic
 *     crossings cluster at 2200 uu/s x 0.036 = 79.2
 *
 * So this feed speaks km/h, and the speed is NOT unitless after all — the M4b
 * spec assumed it might be and forbade writing a unit; the measurement settles
 * it, and §3c of that spec is explicit that a settled unit may be shown.
 *
 * It is still a per-installation fact, not a universal one: the value tracks
 * the game's own INTERFACE metric/imperial setting, so somebody else's copy can
 * hand out mph. Hence a stored choice with an Auto default, and an auto-detect
 * that reads the unit off the physics rather than guessing: the fastest sample
 * seen WHILE bSupersonic is true must lie between the supersonic threshold and
 * the speed cap, and those two bands do not overlap between unit systems.
 *
 * Distances are derived from speed x time and are therefore in real metres —
 * that part needs no setting, only the right divisor.
 */
const UNITS = {
  kmh: { speed: 'km/t', dist: 'm',  toDist: v => v / 3.6,      cap: 82.8,  ssMin: 60 },
  mph: { speed: 'mph',  dist: 'yd', toDist: v => v * 0.48889,  cap: 51.45, ssMin: 30 },
  uus: { speed: 'uu/s', dist: 'm',  toDist: v => v / 100,      cap: 2300,  ssMin: 1500 }
};
const UNIT_AUTO_ORDER = ['uus', 'kmh', 'mph'];   // tested high band first

/* The unit the surfaces print. Set once from profile.json at director init —
 * a configuration constant like BOOST_LOW_AT, not runtime state, so fmt() stays
 * the pure (id, value) function every caller already relies on. */
let unitResolved = null;                         // null until measured or chosen
/* `choice` is what the player picked ('auto'|'kmh'|'mph'|'uus'); `detected` is
 * what detectUnit() has read off the feed so far. An explicit choice always
 * wins — the player knows which units his own game is set to. */
function configureUnits(choice, detected){
  unitResolved = UNITS[choice] ? choice : (UNITS[detected] ? detected : null);
  return unitResolved;
}
/* Read the unit off a digest's own movement record. Needs one supersonic
 * moment in the match; without one it returns null and the surfaces print the
 * number with no unit rather than a guessed one. */
function detectUnit(src){
  if (!src) return null;
  const mv = src.movement || src;
  let best = 0;
  for (const k of Object.keys(mv || {})){
    const v = mv[k] && mv[k].ssMaxSpd;
    if (typeof v === 'number' && v > best) best = v;
  }
  if (!best) return null;
  // Both edges, not just the lower one. The fastest sample taken WHILE
  // supersonic must lie between the supersonic threshold and the speed cap, so
  // a value outside every band is not evidence for the nearest one — it is
  // evidence that something is wrong, and the honest answer is "unknown".
  for (const u of UNIT_AUTO_ORDER)
    if (best >= UNITS[u].ssMin && best <= UNITS[u].cap * 1.02) return u;
  return null;
}
function unitInfo(){ return UNITS[unitResolved] || null; }
function currentUnit(){ return unitResolved; }
/* Suffix for a metric, for the HTML surfaces only. It is deliberately NOT part
 * of fmt(): the LLM grounding validator canonicalises every number it is shown,
 * and "46 km/t" canonicalises to null — a unit inside a value string would make
 * every true number the model quotes look invented and reject the whole answer
 * (grounding.js canon()). Units live in labels and in HTML, never in values. */
function unitFor(id){
  const u = unitInfo(), d = DEFS[id];
  if (!u || !d || !d.unit) return '';
  return d.unit === 'speed' ? u.speed : d.unit === 'dist' ? u.dist : '';
}
function labelWithUnit(id){
  const s = unitFor(id);
  return s ? DEFS[id].label + ' (' + s + ')' : DEFS[id].label;
}
/* speed x seconds -> distance in the unit system's short distance unit. */
function toDist(speedSeconds){
  const u = unitInfo();
  return u ? u.toDist(speedSeconds) : null;
}
/* "Slow" has no in-game constant to anchor to, so it is anchored to the car
 * instead: 30% of the speed cap. Expressing it as a FRACTION rather than a
 * number of km/h is what keeps it the same physical speed for a player whose
 * game reports mph. Measured against 5 minutes of live 3v3 it sits at roughly
 * a fifth of playing time for all three players — low enough to mean something,
 * common enough to move. The recorder stores a full speed histogram precisely
 * so this line can be redrawn later without re-recording anything. */
const SLOW_FRACTION = 0.30;
function slowThreshold(){
  const u = unitInfo();
  return u ? Math.round(u.cap * SLOW_FRACTION) : null;
}

/* Field orientation. Calibrated from observed goals when the digest carries
 * goal impact Y (recorder >= 1.1.0), like the board's tactical calls.
 * Fallback is the engine constant: Blue (team 0) defends -Y, attacks +Y
 * (RLBot wiki, "Useful game values": back walls y=±5120, negative Y is
 * towards Blue's goal). Teams never switch ends in Rocket League.
 */
function attackSign(digest, teamNum){
  for (const g of digest.goals || []){
    if (typeof g.impactY === 'number' && Math.abs(g.impactY) > 4000)
      return g.team === teamNum ? Math.sign(g.impactY) : -Math.sign(g.impactY);
  }
  return teamNum === 0 ? 1 : -1;
}

/* Playlist from max team size — final rosters can be uneven (leavers,
 * tournament shorthanded play), so the larger side names the playlist. */
function playlistOf(digest){
  const n = [0, 0];
  for (const p of digest.players || []) if (p.team === 0 || p.team === 1) n[p.team]++;
  const size = Math.max(n[0], n[1]);
  return size >= 1 && size <= 4 ? size + 'v' + size : 'other';
}

/* ---------------- match type from the game's own playlist id ----------------
 * envelope.playlistId (adapterVersion 1.4.0+) is the RAW Game.PlaylistId the
 * feed sent — stamped because team size alone cannot see a private lobby:
 * 14/8-2026 a private match with 4 active players landed as "1v1" (final
 * roster held 2) and polluted the week's 1v1 numbers.
 *
 * Names verbatim from the BakkesMod SDK reference "Known Playlist IDs"
 * (last updated October 2025):
 *   https://bakkesplugins.com/wiki/bakkesmod-sdk/code-snippets/playlist-id
 * The table is data; every INTERPRETATION of it lives in this file so the
 * mapping can be revised without re-recording anything (same principle as
 * BOOST_LOW_AT and the speed histogram).
 */
const PLAYLIST_NAMES = {
  '-2': 'Intermission', 0: 'Casual', 1: 'Duel', 2: 'Doubles', 3: 'Standard',
  4: 'Chaos', 6: 'Private Match', 7: 'Season', 8: 'Exhibition', 9: 'Training',
  10: 'Duel (Ranked)', 11: 'Doubles (Ranked)', 13: 'Standard (Ranked)',
  15: 'Snow Day', 16: 'Rocket Labs', 17: 'Hoops', 18: 'Rumble', 19: 'Workshop',
  20: 'Custom Training Editor', 21: 'Custom Training', 22: 'Tournament Match (Custom)',
  23: 'Dropshot', 24: 'Local Match', 26: 'External Match (Ranked)', 27: 'Hoops (Ranked)',
  28: 'Rumble (Ranked)', 29: 'Dropshot (Ranked)', 30: 'Snow Day (Ranked)',
  31: 'Ghost Hunt', 32: 'Beach Ball', 33: 'Spike Rush', 34: 'Tournament Match (Automatic)',
  35: 'Rocket Labs', 37: 'Dropshot Rumble', 38: 'Heatseeker', 41: 'Boomer Ball',
  43: 'Heatseeker Doubles', 44: 'Winter Breakaway', 46: 'Gridiron', 47: 'Super Cube',
  48: 'Tactical Rumble', 49: 'Spring Loaded', 50: 'Speed Demon', 52: 'Gotham City Rumble',
  54: 'Knockout', 55: 'confidential_thirdwheel_test', 61: 'Ranked 4v4 Quads',
  62: 'MagnusFutball', 64: 'GodBallSpooky', 65: 'GodBallHaunted', 66: 'GodBallRicochet',
  67: 'CubicSpooky', 68: 'GForceFrenzy', 70: 'RumShotDoubles', 72: 'Territory',
  73: 'OnlineFreeplay', 74: 'TerritoryDoubles', 75: 'GodballTerritory',
  76: 'GodballTerritoryDoubles', 77: 'NonStandardSoccar', 79: 'SnowdayTerritory',
  80: 'RunItBack', 81: 'CarWars', 82: 'PizzaParty', 83: 'PushThePuck', 84: 'Possession',
  86: 'FCShowdown', 87: 'Sacrifice', 88: 'JumpJam'
};
/* Ids counted as a private/self-arranged lobby rather than matchmade play.
 * 6 'Private Match' is the proven case (14/8). 22 'Tournament Match (Custom)'
 * is a self-arranged bracket by its own name — automatic tournaments (34) are
 * matchmade competitive play and stay out. Scope decided by the user 15/8. */
const PRIVATE_PLAYLIST_IDS = new Set([6, 22]);

function playlistIdOf(digest){
  return typeof digest.playlistId === 'number' ? digest.playlistId : null;
}
function playlistNameOf(digest){
  const id = playlistIdOf(digest);
  return id === null ? null : PLAYLIST_NAMES[id] || ('ukendt playlist-id ' + id);
}
/* Where a digest's privacy verdict comes from, and what it is.
 *   { private: true|false, source: 'playlistId' }  — MEASURED off the feed
 *   { private: true|false, source: 'attested'   }  — the USER's own statement
 *       (digest.attested = { private, by: 'user', at, note }): the only way an
 *       old digest, recorded before the id was stamped, can be classified.
 *       Never written by the engine — it is his word, and the field says so.
 *   { private: null,       source: null         }  — cannot know
 * The measured id always wins over an attestation; both are kept apart from
 * "unknown" so no surface can quote a guess as a measurement. */
function privacyOf(digest){
  const id = playlistIdOf(digest);
  if (id !== null) return { private: PRIVATE_PLAYLIST_IDS.has(id), source: 'playlistId' };
  const a = digest && digest.attested;
  if (a && typeof a.private === 'boolean') return { private: a.private, source: 'attested' };
  return { private: null, source: null };
}
/* Tri-state on purpose: true/false is known (measured or attested — see
 * privacyOf for which), null is "cannot know" — an old digest with no
 * attestation, or a feed that never sent the id. Policy downstream treats null
 * as not-private, but must never claim it was measured (missing is not zero —
 * the M4b movement lesson). */
function isPrivate(digest){
  return privacyOf(digest).private;
}
/* What a private match IS, for a surface that names it: the playlist's own
 * name when measured, "privat (din vurdering)" when attested. */
function privateLabel(digest, en){
  const p = privacyOf(digest);
  if (p.private !== true) return null;
  if (p.source === 'playlistId') return playlistNameOf(digest);
  return en ? 'private (your own call)' : 'privat (din vurdering)';
}

/* ---------------- match kind + baseline bucket (17/8-2026) ----------------
 * Team size alone cannot tell Ranked Standard from an automatic tournament,
 * and the archive proved it matters: of the 63 "3v3" matches in W33 only 8
 * carried id 13 (Ranked Standard), 3 were tournaments (34), 2 Rumble (28) and
 * 50 were written by adapters < 1.4.0 that never stamped the id — while TRN
 * showed ~45 tournament matches the same week. Tournament opponents are a
 * different population, so folding them into "your normal in 3v3" makes the
 * normal a blend that is true in neither.
 *
 * KIND is what the game's own id says the match was; the BUCKET is which
 * baseline the match is measured against and folded into.
 *
 * The USER's decision (17/8-2026): tournaments COUNT, on equal footing with
 * ranked — "jeg gir den lige så meget gas i turneringer som i competitive,
 * måske endda mere". Measurement follows where the effort actually goes, and
 * splitting tournaments out would remove half the data that describes his real
 * game. So the id is used to SHOW the distribution ("3v3: 20 ranked · 40
 * turnering") and to match TRN's separate counters — never to split a normal
 * between ranked and tournament. Rumble: not decided; keeps the behaviour it
 * had (counted under the size), to be asked about at some point.
 *
 *   ranked  (10/11/13)      -> the size key itself:   '3v3'
 *   tournament (34)         -> the size key itself:   '3v3'   (user's decision)
 *   rumble (18/28)          -> the size key itself:   '3v3'   (undecided, unchanged)
 *   unknown (no id at all)  -> the size key itself:   '3v3'   (kindKnown:false)
 *   casual (0-4)            -> '3v3 Casual'                    (out of the normal)
 *   other (any other id)    -> '3v3 <the game's own playlist name>'
 *   private (6/22)          -> the size key (never folded — director.privateCard)
 *
 * The size key therefore means "competitive play at that team size" — the
 * same thing it has meant since day one — and no mature row goes immature on
 * the day this landed (M4's rule: maturity is judged on the baseline as it
 * stood at the week's start, immature rows are grey and unjudged). `idWeight`
 * on the bucket (snapshotAndFold) says how much of a normal rests on matches
 * whose kind the game itself stamped, and `kinds` counts what went in.
 *
 * An id-less match is NEVER reclassified from context (roster shape, time of
 * day, TRN counts): it keeps the size label and says so. Missing is not
 * "ranked" any more than missing is zero.
 *
 * The bucket words are the game's own UI words (Casual, …): the game UI stays
 * English in every report language, and a stored profile key must not change
 * with the language setting. */
const KIND_IDS = {
  ranked:     [10, 11, 13],            // Duel / Doubles / Standard (Ranked)
  tournament: [34],                    // automatic tournaments — counted with ranked (user, 17/8)
  rumble:     [18, 28],                // Rumble / Rumble (Ranked) — counted under the size (undecided)
  casual:     [0, 1, 2, 3, 4],         // Casual / Duel / Doubles / Standard / Chaos — own bucket
  private:    [6, 22]                  // = PRIVATE_PLAYLIST_IDS
};
const KIND_BY_ID = {};
for (const k of Object.keys(KIND_IDS)) for (const id of KIND_IDS[k]) KIND_BY_ID[id] = k;
/* Kinds that get a bucket of their own, and the game-UI word that names it.
 * Everything not listed here (and not 'other') shares the size key. */
const KIND_WORD = { casual: 'Casual' };
const KIND_ORDER = ['ranked', 'tournament', 'rumble', 'casual', 'other', 'unknown', 'private'];
/* Share of a bucket's EWMA weight that must come from id-stamped matches before
 * the distribution behind the normal counts as KNOWN rather than estimated
 * (<= 10% id-less weight left). Reached after 22 consecutive stamped folds at
 * alpha 0.1: 1 - 0.9^22 = 0.90. */
const ID_COVERAGE_OK = 0.9;

function matchKindOf(digest){
  const id = playlistIdOf(digest);
  if (id === null) return 'unknown';
  return KIND_BY_ID[id] || 'other';
}
function bucketOf(digest){
  const size = playlistOf(digest);
  const id = playlistIdOf(digest);
  const kind = matchKindOf(digest);
  let key = size;
  if (KIND_WORD[kind]) key = size + ' ' + KIND_WORD[kind];
  else if (kind === 'other') key = size + ' ' + (PLAYLIST_NAMES[id] || ('id ' + id));
  return { key, size, kind, id, known: id !== null, name: id === null ? null : playlistNameOf(digest) };
}
/* Report word for a kind — Danish by default, English on the EN switch. */
function kindLabel(kind, en){
  const da = { ranked: 'ranked', tournament: 'turnering', rumble: 'rumble', casual: 'casual',
               other: 'andet', unknown: 'uden playlist-id', private: 'privat' };
  const enW = { ranked: 'ranked', tournament: 'tournament', rumble: 'rumble', casual: 'casual',
                other: 'other', unknown: 'no playlist id', private: 'private' };
  return (en ? enW : da)[kind] || kind;
}

/* A digest is a coachable match when the tracked player was in it, both
 * teams existed and at least one kickoff was observed. This drops solo
 * freeplay AND the post-game artifacts (same guid, zero kickoffs) that the
 * pre-1.1.0 recorder wrote after every match. A genuine forfeit — opponents
 * gave up, MatchDestroyed without MatchEnded — HAS kickoffs and both teams,
 * so it passes and its de-facto result is read from the final score.
 */
function validity(digest, trackedPid){
  const me = (digest.players || []).find(p => p.pid === trackedPid);
  if (!me) return { ok: false, reason: 'tracked player not in match' };
  const n = [0, 0];
  for (const p of digest.players) if (p.team === 0 || p.team === 1) n[p.team]++;
  if (!n[0] || !n[1]){
    // The roster is the FINAL snapshot — an opponent who leaves before the
    // last UpdateState (fx efter at have tabt 6-7) vacates it. The match
    // HISTORY still proves two-sided play: a guid only exists for online/LAN
    // matches, and goals/kickoff first-touches carry team numbers. Freeplay
    // has none of these (no guid, all touches one team), so it still drops.
    const twoSided = !!digest.guid
      || new Set((digest.goals || []).map(g => g.team)).size > 1
      || new Set((digest.kickoffs || []).map(k => k.team)).size > 1;
    if (!twoSided) return { ok: false, reason: 'one-sided roster (freeplay/solo)' };
  }
  if (!(digest.kickoffs || []).length) return { ok: false, reason: 'no kickoffs observed (post-game artifact)' };
  return { ok: true, me };
}

function resultOf(digest, myTeam){
  const s = digest.teams && digest.teams.length === 2 ? [digest.teams[0].score, digest.teams[1].score] : null;
  if (digest.winnerTeamNum === 0 || digest.winnerTeamNum === 1)
    return digest.winnerTeamNum === myTeam ? 'W' : 'L';
  if (digest.abandoned && s && s[0] !== s[1])        // forfeit: the lead stands as the de-facto result
    return (s[0] > s[1] ? 0 : 1) === myTeam ? 'W' : 'L';
  return null;
}

/* Metric registry. direction: +1 = higher is better, -1 = lower is better.
 * fmt: how the value reads in a sentence. Names stay honest — plusY/minusY
 * is "touches on the opponent half", never "rotation" (DESIGN §4).
 */
const DEFS = {
  kickoff_team_ft:   { label: 'holdets førstetouch på kickoffs', direction: 1,  fmt: 'pct',  minSamples: 3 },
  kickoff_self_ft:   { label: 'dine førstetouch på kickoffs',    direction: 1,  fmt: 'pct',  minSamples: 3 },
  kickoff_self_speed:{ label: 'kickoff-touchkraft',              direction: 1,  fmt: 'int',  minSamples: 2 },
  hit_power_avg:     { label: 'touchkraft (snit)',               direction: 1,  fmt: 'int',  minSamples: 8 },
  hit_power_max:     { label: 'hårdeste touch',                  direction: 1,  fmt: 'int',  minSamples: 8 },
  off_touch_share:   { label: 'touches på modstanderhalvdelen',  direction: 1,  fmt: 'pct',  minSamples: 8 },
  // minSamples is in SECONDS of measured play from adapterVersion 1.2.0 — the
  // old definition counted frames, where 300 meant three seconds. Same number,
  // very different gate; 120 s is half a short match, matching the M4b metrics.
  boost_low_share:   { label: 'tid under ' + BOOST_LOW_AT + ' boost', direction: -1, fmt: 'pct', minSamples: 120 },
  boost_avg:         { label: 'boost-niveau (snit)',             direction: 1,  fmt: 'int',  minSamples: 120 },
  touches_per_min:   { label: 'touches pr. minut',               direction: 1,  fmt: 'dec1', minSamples: 1 },
  // noPct: a signed count centred near zero — percentage change against a
  // baseline like 0.28 explodes ("-615%") and would hijack every ranking.
  // Compared in absolute terms instead; never ranked by percentage.
  demo_diff:         { label: 'demo-differens',                  direction: 1,  fmt: 'sign', minSamples: 0, noPct: true },

  /* --- movement (M4b) -------------------------------------------------
   * Every one of these is measured, stored and shown from the first match.
   * `coachable: false` keeps a metric out of the praise line, the problem
   * line, the day's focus and the weekly ranking, while still letting it
   * build a baseline and appear on the tape.
   *
   * That is not timidity, it is the spec's own instruction. dist_per_touch's
   * direction is called a working hypothesis there — "verificér fortegnet mod
   * data før den får lov at fyre et råd" — and the same debt is owed to the
   * rest: these are proxies for behaviour, not the behaviour. A metric with a
   * real in-game threshold behind it (supersonic) is no more proven as COACHING
   * than one without. Flip the flag one metric at a time as the archive
   * settles its sign — Spearman against match result per playlist, pooled via
   * Fisher (rl-director/m4b-fortegn-analyse.js), 95%-CI clear of zero.
   *
   * dist_per_touch woke first (9/8-2026): pooled r −0.21 over 124 matches,
   * same sign in every playlist — the spec's own hypothesis, in the predicted
   * direction. supersonic_share must NOT wake as +1: it trends NEGATIVE in
   * 2v2 (−0.29/61) — likely chase-time, not speed quality.
   *
   * minSamples is in SECONDS of measured play for the time-weighted ones —
   * 120 s means half a short match, which is what it takes before a share is
   * anything but noise.
   * --- */
  speed_avg:         { label: 'gennemsnitsfart',                 direction: 1,  fmt: 'dec1', minSamples: 120, unit: 'speed', coachable: false },
  speed_max:         { label: 'højeste fart',                    direction: 1,  fmt: 'dec1', minSamples: 120, unit: 'speed', coachable: false },
  supersonic_share:  { label: 'tid i supersonic',                direction: 1,  fmt: 'pct',  minSamples: 120, coachable: false },
  // No direction at all: being off the ground is neither good nor bad in
  // itself, and the feed cannot tell an aerial from a bump or a bad landing.
  // direction 0 keeps it out of the RANKING, but coachable is a separate gate
  // and both are needed: rules fire on their own thresholds, not on deltaPct.
  airborne_share:    { label: 'tid uden hjul på jorden',         direction: 0,  fmt: 'pct',  minSamples: 120, coachable: false },
  slow_share:        { label: 'tid ved lav fart',                direction: -1, fmt: 'pct',  minSamples: 120, coachable: false },
  distance_per_min:  { label: 'kørt distance pr. minut',         direction: 1,  fmt: 'int',  minSamples: 120, unit: 'dist', coachable: false },
  // The spec lists distance in total; per minute is the version that survives
  // matches of different length, which the spec itself asks for. The total is
  // kept in evidence so the tape can still show it.
  dist_per_touch:    { label: 'kørt distance pr. touch',         direction: -1, fmt: 'int',  minSamples: 120, unit: 'dist' },
  speed_drift:       { label: 'fart-drift, sidste mod første tredjedel', direction: 1, fmt: 'dec2', minSamples: 30, coachable: false },
  // No direction: after conceding, both a collapse and a frantic spike are
  // deviations, and nothing measured here says which one this is.
  post_concede_speed:{ label: 'fart efter indkasseret mål',      direction: 0,  fmt: 'dec2', minSamples: 2, coachable: false },
  pass_count:        { label: 'afleveringer til makker',         direction: 1,  fmt: 'int',  minSamples: 0, noPct: true, coachable: false }
};

/* English metric names — the same words the English persona dictionary teaches
 * the model, so engine surfaces and LLM prose never disagree on a name. */
const LABELS_EN = {
  kickoff_team_ft:   'team first touch on kickoffs',
  kickoff_self_ft:   'your first touches on kickoffs',
  kickoff_self_speed:'kickoff touch power',
  hit_power_avg:     'touch power (average)',
  hit_power_max:     'hardest touch',
  off_touch_share:   'touches on the opponent half',
  boost_low_share:   'time below ' + BOOST_LOW_AT + ' boost',
  boost_avg:         'boost level (average)',
  touches_per_min:   'touches per minute',
  demo_diff:         'demo differential',
  speed_avg:         'average speed',
  speed_max:         'top speed',
  supersonic_share:  'time at supersonic',
  airborne_share:    'time with wheels off the ground',
  slow_share:        'time at low speed',
  distance_per_min:  'distance driven per minute',
  dist_per_touch:    'distance driven per touch',
  speed_drift:       'speed drift, last third vs first',
  post_concede_speed:'speed after conceding',
  pass_count:        'passes to a teammate'
};

/* Language is engine-wide DEF state, set once at director init (same pattern
 * as configureUnits): every consumer reads DEFS[id].label directly, so the
 * switch swaps the labels in place rather than teaching each caller a new
 * lookup. The Danish original survives in label_da, so the swap is reversible
 * within a process and idempotent across calls. */
let langResolved = 'da';
function configureLanguage(choice){
  langResolved = choice === 'en' ? 'en' : 'da';
  for (const id of Object.keys(DEFS)){
    const d = DEFS[id];
    if (!d.label_da) d.label_da = d.label;
    d.label = (langResolved === 'en' && LABELS_EN[id]) ? LABELS_EN[id] : d.label_da;
  }
  return langResolved;
}
function currentLanguage(){ return langResolved; }

/* May this metric be ranked, praised, blamed or made the day's focus?
 * noPct metrics are counts centred near zero and were never rankable; the M4b
 * movement metrics are measured but not yet trusted to judge. */
function coachable(id){
  const d = DEFS[id];
  return !!d && d.coachable !== false;
}
function ranked(id){
  return coachable(id) && !DEFS[id].noPct;
}

/* digest -> { id: {value, samples, evidence} } for the tracked player.
 * A metric is simply absent when the match holds too little data for it.
 */
function computeMetrics(digest, me){
  const out = {};
  const add = (id, value, samples, evidence) => {
    if (samples >= DEFS[id].minSamples && Number.isFinite(value))
      out[id] = { value, samples, evidence: evidence || {} };
  };

  const kicks = digest.kickoffs || [];
  if (kicks.length){
    const teamWon = kicks.filter(k => k.team === me.team).length;
    const selfWon = kicks.filter(k => k.firstTouch === me.name);
    add('kickoff_team_ft', teamWon / kicks.length, kicks.length, { won: teamWon, total: kicks.length });
    add('kickoff_self_ft', selfWon.length / kicks.length, kicks.length, { won: selfWon.length, total: kicks.length });
    const speeds = selfWon.map(k => k.speed).filter(s => typeof s === 'number');
    if (speeds.length)
      add('kickoff_self_speed', speeds.reduce((a, b) => a + b, 0) / speeds.length, speeds.length, { n: speeds.length });
  }

  // The movement record backs both the M4b metrics and, from 1.2.0, boost.
  const mvRec = (digest.movement || {})[me.name];

  const h = (digest.hits || {})[me.name];
  if (h && h.count){
    add('hit_power_avg', h.sumSpeed / h.count, h.count, { hits: h.count });
    add('hit_power_max', h.maxSpeed, h.count, {});
    const oriented = (h.plusY || 0) + (h.minusY || 0);
    if (oriented){
      const offHits = attackSign(digest, me.team) > 0 ? h.plusY : h.minusY;
      add('off_touch_share', offHits / oriented, oriented, { off: offHits, total: oriented });
    }
  }

  /* Boost, measured the same way movement is (adapterVersion 1.2.0+).
   *
   * The old accumulator counted SAMPLES with `Boost` present, and both of its
   * assumptions turned out to be wrong when the feed was probed on 2026-07-27:
   *   - it counted goal-replay frames, where the boost is frozen at whatever it
   *     was when the goal went in, and where the feed hands out opponents' rows
   *   - the feed OMITS falsy values, so `typeof p.Boost !== 'number'` skipped
   *     exactly the frames at zero boost — the metric threw away the very state
   *     it exists to measure
   * Measured over 53 archived matches: median boost_low_share 19.0% against a
   * corrected 31.7%, and the error is NOT constant (1.31x to 1.98x across
   * matches, worst in the matches where the player was most boost-starved), so
   * it does not cancel in a comparison against his own normal.
   *
   * Digests older than 1.2.0 carry only the old numbers, and they are LEFT
   * ABSENT rather than converted: the correction can be estimated but not
   * measured, and a baseline of estimates is what this change exists to end.
   * That is also why director.js resets these two baselines once. */
  const bh = mvRec && mvRec.sec > 0 && Array.isArray(mvRec.bhist) && mvRec.bhistW > 0 ? mvRec : null;
  if (bh){
    let low = 0;
    for (let i = 0; i < bh.bhist.length; i++){
      const lo = i * bh.bhistW, hi = lo + bh.bhistW;
      if (hi <= BOOST_LOW_AT) low += bh.bhist[i];
      else if (lo < BOOST_LOW_AT) low += bh.bhist[i] * ((BOOST_LOW_AT - lo) / bh.bhistW);
    }
    add('boost_low_share', low / bh.sec, bh.sec, { under: BOOST_LOW_AT });
    add('boost_avg', bh.boostInt / bh.sec, bh.sec, {});
  }

  const mins = (Date.parse(digest.endedAt) - Date.parse(digest.startedAt)) / 60000;
  if (mins >= 3 && typeof me.touches === 'number')
    add('touches_per_min', me.touches / mins, 1, { touches: me.touches, mins: Math.round(mins * 10) / 10 });

  const demos = digest.demos || [];
  const inflicted = demos.filter(d => d.attacker === me.name).length;
  const received = demos.filter(d => d.victim === me.name).length;
  add('demo_diff', inflicted - received, demos.length ? demos.length : 0, { inflicted, received });
  if (!demos.length) out.demo_diff = { value: 0, samples: 0, evidence: { inflicted: 0, received: 0 } };

  /* --- movement (M4b) ---------------------------------------------------
   * Absent for every match recorded before adapterVersion 1.2.0, and absent
   * for a player the feed carries no movement fields for (opponents). Missing,
   * not zero — a match that could not be measured must not drag a baseline
   * down as if the player had stood still.
   */
  const mv = mvRec;
  if (mv && mv.sec > 0){
    const sec = mv.sec;
    add('speed_avg', mv.spdInt / sec, sec, { sekunder: Math.round(sec) });
    add('speed_max', mv.spdMax, sec, {});
    add('supersonic_share', mv.ssSec / sec, sec, {});
    add('airborne_share', mv.airSec / sec, sec, {});

    // Distance is speed x time, so it only becomes a real length once the unit
    // is known. Until then these stay absent rather than printing a number that
    // means nothing.
    const dist = toDist(mv.spdInt);
    if (Number.isFinite(dist)){
      add('distance_per_min', dist / (sec / 60), sec, { total: Math.round(dist), sekunder: Math.round(sec) });
      if (typeof me.touches === 'number' && me.touches > 0)
        add('dist_per_touch', dist / me.touches, sec, { total: Math.round(dist), touches: me.touches });
    }

    /* Time below a low-speed line, read back out of the stored histogram so the
     * line itself stays a decision this file makes — and can revise — instead
     * of one frozen into the archive at capture time. */
    const slowAt = slowThreshold();
    if (Number.isFinite(slowAt) && Array.isArray(mv.hist) && mv.binWidth > 0){
      const last = mv.hist.length - 1;
      const ceiling = last * mv.binWidth;          // everything at or above this is in the overflow bin
      /* The histogram spans 0..ceiling with one unbounded bin on top, which
       * covers km/h and mph outright but not uu/s, where every sample lands in
       * the overflow. Refuse rather than answer: a threshold outside the range,
       * or a fifth of the match sitting in the unbounded bin, means the
       * histogram cannot see where the line falls — and a slow_share of 0% or
       * 100% arrived at that way would be the "SOFT TOUCH from day one" bug
       * again, with a number that looks measured and is not. */
      const overflow = mv.hist[last] || 0;
      if (slowAt < ceiling && overflow <= sec * 0.05){
        let below = 0;
        for (let i = 0; i < last; i++){          // the overflow bin is never "below" anything
          const lo = i * mv.binWidth, hi = lo + mv.binWidth;
          if (hi <= slowAt) below += mv.hist[i];
          else if (lo < slowAt) below += mv.hist[i] * ((slowAt - lo) / mv.binWidth);   // part-bin
        }
        add('slow_share', below / sec, sec, { under: slowAt });
      }
    }
  }

  /* Inside the match, not just its total. The per-second curve is what makes
   * "when" answerable at all — a sum can say what happened, never when.
   * Both readings below are RATIOS against the player's own match average, so
   * they carry no unit and need no baseline to be readable. */
  const tl = (digest.timeline || {})[me.name];
  if (tl && Array.isArray(tl.spd) && tl.spd.length >= 9){
    const spd = tl.spd, n = spd.length;
    const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const third = Math.floor(n / 3);
    const first = mean(spd.slice(0, third)), last = mean(spd.slice(n - third));
    if (first > 0) add('speed_drift', last / first, n, { foerste: Math.round(first), sidste: Math.round(last) });

    // The 15 seconds after the opponent scores, against this same match's own
    // pace. Named for what is measured — speed after conceding — and not for
    // what it might mean. The curve already excludes the replay and the
    // countdown, so these are the first 15 seconds of play back on the clock.
    const matchMean = mean(spd);
    if (matchMean > 0){
      const after = [];
      let goals = 0;
      for (const g of digest.goals || []){
        if (g.team === me.team || typeof g.clock !== 'number') continue;
        const i = curveIndexAt(tl.t, g);
        if (i < 0) continue;
        const slice = spd.slice(i + 1, i + 16);
        if (slice.length >= 5){ after.push(...slice); goals++; }
      }
      if (goals >= 2)
        add('post_concede_speed', mean(after) / matchMean, goals,
            { maal: goals, sekunder: after.length });
    }
  }

  // Zero passes is a measurement, not a missing one. Keying on the presence of
  // the `passes` OBJECT (which only digests from adapterVersion 1.2.0 carry)
  // separates "no passes this match" from "this match predates pass counting" —
  // reading a missing player entry as absent would quietly drop every quiet
  // match from the baseline and leave it describing only the busy ones.
  if (digest.passes && playlistOf(digest) !== '1v1'){
    const passes = digest.passes[me.name] || 0;
    add('pass_count', passes, 1, { afleveringer: passes });
  }

  return out;
}

/* Where on the per-second curve a goal happened.
 *
 * The match clock is NOT monotonic. Regulation counts DOWN from 300 to 0, then
 * overtime RESTARTS at 0 and counts UP — verified against the archive, where
 * every overtime match's kickoffs end at clock 0 and the golden goal then sits
 * at 33, 37, 24, 5. Every one of those values also exists in the regulation
 * half, so a plain "first bucket at or below this clock" search finds the
 * REGULATION one and reads fifteen seconds of ordinary mid-match play as the
 * reaction to a goal that ended the match. Measured on
 * 2026-07-27T17-16-16: an overtime goal resolved to curve index 267 of 335,
 * and the bogus sample was also what lifted the metric over its two-goal gate.
 *
 * So find the turn first, then search the half the goal actually belongs to,
 * in that half's own direction. Roughly one match in twelve goes to overtime.
 */
function curveIndexAt(t, g){
  if (!Array.isArray(t) || !t.length) return -1;
  let turn = -1;
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]){ turn = i; break; }
  if (g && g.ot && turn >= 0){
    for (let i = turn; i < t.length; i++) if (t[i] >= g.clock) return i;
    return t.length - 1;                    // golden goal: the curve ends on it
  }
  const end = turn >= 0 ? turn : t.length;
  for (let i = 0; i < end; i++) if (t[i] <= g.clock) return i;
  return -1;
}

/* Compare against the stored per-playlist baseline, then fold the match in.
 * Returns MetricSnapshots; mutates `plProfile.metrics` (EWMA + n).
 * Baseline shown in a snapshot is always the PRE-match value — the coach
 * compares tonight's match with who you were before it.
 */
function snapshotAndFold(matchMetrics, plProfile, fold){
  const snaps = {};
  for (const id of Object.keys(matchMetrics)){
    const m = matchMetrics[id];
    const base = plProfile.metrics[id] || null;
    const gated = !base || base.n < MIN_BASELINE;
    const delta = base ? m.value - base.mean : null;
    snaps[id] = {
      id, value: m.value, samples: m.samples, evidence: m.evidence,
      baseline: base ? { mean: base.mean, n: base.n } : null,
      delta,
      deltaPct: base && ranked(id) && Math.abs(base.mean) > 1e-9 ? delta / Math.abs(base.mean) : null,
      gated
    };
    if (base){ base.mean += EWMA_ALPHA * (m.value - base.mean); base.n++; }
    else plProfile.metrics[id] = { mean: m.value, n: 1 };
  }
  plProfile.n = (plProfile.n || 0) + 1;
  /* Provenance of the bucket (17/8): how much of its EWMA weight rests on
   * matches whose kind the game itself stamped, and how many of each kind went
   * in. Same alpha as the metrics, so idWeight IS the share of the normal that
   * comes from measured-id matches (approximate for a metric that skips some
   * matches, exact for the ones present every match). Old buckets start at 0:
   * everything before adapter 1.4.0 is id-less by construction. */
  const known = !!(fold && fold.idKnown);
  plProfile.idWeight = (plProfile.idWeight || 0) + EWMA_ALPHA * ((known ? 1 : 0) - (plProfile.idWeight || 0));
  const kind = (fold && fold.kind) || 'unknown';
  if (!plProfile.kinds || typeof plProfile.kinds !== 'object') plProfile.kinds = {};
  plProfile.kinds[kind] = (plProfile.kinds[kind] | 0) + 1;
  return snaps;
}

/* value -> sentence fragment, per metric formatting */
function fmt(id, v){
  switch (DEFS[id].fmt){
    case 'pct':  return Math.round(v * 100) + '%';
    case 'int':  return String(Math.round(v));
    case 'dec1': return String(Math.round(v * 10) / 10);
    case 'dec2': return String(Math.round(v * 100) / 100);
    case 'sign': return (v > 0 ? '+' : '') + Math.round(v);
    default:     return String(v);
  }
}

module.exports = { MIN_BASELINE, EWMA_ALPHA, BOOST_LOW_AT, DEFS, playlistOf, validity, resultOf,
  attackSign, computeMetrics, snapshotAndFold, fmt, ranked, coachable, curveIndexAt,
  UNITS, configureUnits, detectUnit, currentUnit, unitFor, labelWithUnit, slowThreshold,
  configureLanguage, currentLanguage,
  PLAYLIST_NAMES, PRIVATE_PLAYLIST_IDS, playlistIdOf, playlistNameOf, privacyOf, isPrivate, privateLabel,
  KIND_IDS, KIND_ORDER, ID_COVERAGE_OK, matchKindOf, bucketOf, kindLabel };
