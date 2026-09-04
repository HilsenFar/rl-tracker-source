/* RL Director — curated training-pack bank (M4).
 *
 * One place for every training pack the coach is allowed to name, so the
 * session report, the weekly report and the focus card cannot drift apart or
 * invent a code. Codes are NEVER generated: each one is either user-approved
 * from an earlier session or lifted verbatim from pack-catalog.json (Lander1984's
 * rated master list, r/RocketLeagueSchool, harvested 2026-07-27) and verified
 * present in that file before being written here.
 *
 * `metrics` is the grounded coupling: which measured metric a pack actually
 * answers. `signals` covers the things that are measured but are not metrics
 * with baselines (goals conceded in the first minute, shot conversion). A pack
 * with neither may only ever be offered as a stated GOAL — see `goalOnly`.
 *
 * The honesty rule that shaped this file: we measure no aerial data at all
 * (nothing in the feed reports air time or height), so an aerial pack can never
 * be justified with a number. It is offered because the player said he wants to
 * learn aerials, and it says so in its own reason line.
 */
'use strict';

const BANK = [
  {
    id: 'ultimate_warmup',
    name: 'The Ultimate Warmup',
    code: 'FA24-B2B7-2E8E-193B',
    // Deliberately coupled to NO metric: it is a mixed everything-pack, so
    // offering it as the targeted answer to one weak number would be a worse
    // recommendation than the drill that actually trains that number. It has a
    // standing slot of its own instead — warming up before queueing is the one
    // habit the player has measured the effect of himself.
    metrics: [],
    signals: [],
    what: 'grundskud, aerials og redirects i én bane — 10-15 min før kø',
    whatEn: 'ground shots, aerials and redirects in one pack — 10-15 min before queueing',
    // Not a claim from an article: the player measured it himself on 27/7-2026 —
    // one hour of warm-up packs, then rank-ups in both 2v2 and 1v1 the same
    // evening. It is his own evidence, and it is cited as his own.
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · rating 50/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'bronze_silver',
    name: 'Bronze/Silver Training',
    code: '2D89-9321-42D2-48BA',
    metrics: ['kickoff_self_ft', 'kickoff_team_ft', 'kickoff_self_speed'],
    // conceding in the first minute is answered by Saves, not by shooting drills
    signals: [],
    what: 'første touch og grundskud',
    whatEn: 'first touch and ground shots',
    source: { title: 'Dignitas: Essential Tips To Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' }
  },
  {
    id: 'first_touch_boot_camp',
    name: 'First Touch Boot Camp',
    code: 'F43A-8231-0B8F-B9FA',
    metrics: ['kickoff_self_ft', 'kickoff_team_ft'],
    signals: [],
    what: 'ren første-touch-kontrol, let niveau',
    whatEn: 'pure first-touch control, easy level',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool)', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'powershots',
    name: 'Powershots',
    code: '7028-5E10-88EF-E83E',
    metrics: ['hit_power_avg', 'hit_power_max', 'kickoff_self_speed'],
    signals: [],
    what: 'slagkraft — boost ind i bolden, flip sent',
    whatEn: 'hitting power — boost into the ball, flip late',
    source: { title: 'Dignitas: A Guide to Power Shots (ApparentlyJack)', url: 'https://dignitas.gg/articles/a-guide-to-power-shots-in-rocket-league-with-apparentlyjack' }
  },
  {
    id: 'ground_shots',
    name: 'Ground Shots',
    code: '6EB1-79B2-33B8-681C',
    metrics: ['hit_power_avg'],
    signals: ['conversion'],
    what: 'placering frem for kraft (gennemført 1×; spillet viser ingen pack-score — trackeren måler runden)',
    whatEn: 'placement over power (completed 1×; the game shows no pack score — the tracker measures the run)',
    source: { title: 'Dignitas: Essential Tips To Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' }
  },
  {
    id: 'shots_you_shouldnt_miss',
    name: "Shots You Shouldn't Miss",
    code: '42BF-686D-E047-574B',
    metrics: [],
    signals: ['conversion'],
    what: 'afslutning — chancer der SKAL i mål',
    whatEn: 'finishing — chances that MUST go in',
    source: { title: 'Dignitas: Essential Tips To Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' }
  },
  {
    id: 'saves',
    name: 'Saves',
    code: '2E23-ABD5-20C6-DBD4',
    metrics: [],
    signals: ['earlyConceded', 'conceded'],
    what: 'redninger — den lette udgave af "Uncomfortable Saves"',
    whatEn: 'saves — the easy version of "Uncomfortable Saves"',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · DEFENCE, rating 46/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'catch_control',
    name: 'Catch & Control Dribble',
    code: '78E7-FDBF-61FB-4EF3',
    metrics: ['off_touch_share', 'touches_per_min'],
    signals: [],
    what: 'tage bolden ned og beholde den fremme i stedet for at klaske den væk',
    whatEn: 'take the ball down and keep it forward instead of smacking it away',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · begynder-venlig', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'aerial_shots_pass',
    name: 'Aerial Shots - Pass',
    code: 'C7E0-9E0B-B739-A899',
    metrics: [],
    signals: [],
    // Trin 1 af den 4-trins aerial-progression brugeren selv har sat som mål.
    goalOnly: 'aerials',
    what: 'trin 1 i aerial-progressionen (derefter Redirects → Backboard Therapy)',
    whatEn: 'step 1 of the aerial progression (then Redirects → Backboard Therapy)',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · AERIALS, rating 48/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  }
];

const BY_ID = new Map(BANK.map(p => [p.id, p]));

function byId(id){
  const p = BY_ID.get(id);
  if (!p) throw new Error('ukendt træningsbane-id: ' + id);   // fail loud: a wrong code is worse than a crash
  return p;
}

/* Packs whose grounded coupling includes this metric, best first.
 * Order in BANK is the tie-break, so the same weakness always suggests the
 * same primary pack until rotation moves it. */
function forMetric(id){ return BANK.filter(p => p.metrics.includes(id)); }
function forSignal(sig){ return BANK.filter(p => (p.signals || []).includes(sig)); }

module.exports = { BANK, byId, forMetric, forSignal };
