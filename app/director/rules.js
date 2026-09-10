/* RL Director — hand-curated rule library (M1).
 * 6 rules, every one source-backed (no invented benchmarks, no "rotation"
 * claims from proxy data). A rule may only quote numbers that exist in the
 * MetricSnapshots it receives. One rule wins per debrief (highest severity).
 *
 * Advice/exercises come from the curated bank only:
 * - Dignitas, "A Guide on Boost Management in Rocket League"
 *   https://dignitas.gg/articles/boost-management-in-rocket-league
 * - Dignitas, "Best Ways To Win Kickoffs in Rocket League"
 *   https://dignitas.gg/articles/best-ways-to-win-kickoffs-in-rocket-league
 * - Dignitas, "A Guide to Power Shots with ApparentlyJack"
 *   https://dignitas.gg/articles/a-guide-to-power-shots-in-rocket-league-with-apparentlyjack
 *   (+ training pack "Powershots" 7028-5E10-88EF-E83E, verified 2026-07-23)
 * - Dignitas, "Essential Tips To Get Out Of Silver"
 *   https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide
 * - Dignitas, "Bumps and Demolitions — interview with Rocket Sledge"
 *   https://dignitas.gg/articles/bumps-and-demolitions-an-interview-with-rocket-sledge
 *
 * M4b movement rules (added 2026-07-27). Every source below was fetched and
 * checked before it was cited, not recalled:
 * - Dignitas, "Ballchasing In Rocket League — A Guide With Yukeo"
 *   https://dignitas.gg/articles/news/rocket-league/13423/ballchasing-in-rocket-league-a-guide-with-yukeo
 *   (Yukeo is a PLAYER, not a coach — the article is an interview.)
 * - Dignitas, "Ball Chasing — The Stigma From a Misused Term"
 *   https://dignitas.gg/articles/ball-chasing-the-stigma-from-a-misused-term
 *   (Its thesis is that the term is misused: attacking the ball is NOT chasing
 *   it. Nothing here may be used to argue that aggression is a fault.)
 * - Dignitas, "Confidence, Anticipation and Imagination"
 *   https://dignitas.gg/articles/confidence-anticipation-and-imagination-essential-skills-for-rocket-league
 * - Dignitas, "Rocket League: Maintaining Momentum and Quickly Recovering"
 *   https://dignitas.gg/articles/blogs/rocket-league/12955/rocket-league-maintaining-momentum-and-quickly-recovering
 * - Dignitas, "Overcoming the Tilted Mindset"
 *   https://dignitas.gg/articles/overcoming-the-tilted-mindset
 *
 * 19/8-2026: the advice a fired rule SHOWS now comes from persona.js's
 * INSTRUCTION_BANK, rotated per metric (director.selectLines), each entry with
 * its own source and a verbatim guide quote — GUIDES.md lists every source
 * and what was rejected. The `advice`/`advice_en` below remain the fallback
 * for a metric the bank does not cover, and session.js still calls them.
 *
 * These four rules are written but ASLEEP: their metrics carry
 * `coachable: false` in metrics.js, and director.js checks that before firing
 * anything. They wake up one at a time, when the archive has ten matches per
 * playlist to say the direction is real. That is the M4b spec's own condition —
 * "verificér fortegnet mod data før den får lov at fyre et råd".
 */
'use strict';
const { fmt, BOOST_LOW_AT, unitFor } = require('./metrics');

const pct = v => Math.round(v * 100) + '%';
/* Distance values carry their unit as a WORD in the sentence (K4W's feedback
 * 19/8: "Du kørte 116 pr. touch" — 116 hvad?). The word follows the configured
 * unit system: m -> meter/meters, yd -> yards. fmt() itself stays a bare
 * number — the voice payload and grounding depend on that. */
const DIST_WORD = { m: { da: 'meter', en: 'meters' }, yd: { da: 'yards', en: 'yards' } };
const distW = en => { const u = unitFor('dist_per_touch'); const w = DIST_WORD[u]; return w ? (en ? w.en : w.da) : (u || ''); };

/* Each rule: fires on a genuinely-worse-than-your-own-baseline signal
 * (relative AND absolute margin, so noise doesn't nag) or, for demos, on
 * hard in-match counts. `problem` and `advice` build the debrief lines.
 */
const RULES = [
  {
    id: 'boost_starved', metric: 'boost_low_share', severity: 90,
    source: { title: 'Dignitas: Boost Management', url: 'https://dignitas.gg/articles/boost-management-in-rocket-league' },
    when: s => !s.gated && s.value >= s.baseline.mean * 1.3 && s.value >= s.baseline.mean + 0.05,
    problem: s => 'Du lå under ' + BOOST_LOW_AT + ' boost i ' + pct(s.value) + ' af tiden — din normal er ' + pct(s.baseline.mean) + '.',
    problem_en: s => 'You sat below ' + BOOST_LOW_AT + ' boost for ' + pct(s.value) + ' of the time — your normal is ' + pct(s.baseline.mean) + '.',
    advice: () => 'Saml småpads på vej tilbage (28 pads à 12 boost) i stedet for at køre omvejen efter 100-boosten.',
    advice_en: () => 'Collect small pads on your way back (28 pads at 12 boost each) instead of detouring for the 100-boost.'
  },
  {
    id: 'kickoff_losses', metric: 'kickoff_team_ft', severity: 80,
    source: { title: 'Dignitas: Win Kickoffs', url: 'https://dignitas.gg/articles/best-ways-to-win-kickoffs-in-rocket-league' },
    when: s => !s.gated && s.value <= s.baseline.mean * 0.7 && s.value <= s.baseline.mean - 0.12,
    problem: s => 'Holdet fik kun første touch på ' + s.evidence.won + '/' + s.evidence.total + ' kickoffs — din normal er ' + pct(s.baseline.mean) + '.',
    problem_en: s => 'The team got the first touch on only ' + s.evidence.won + '/' + s.evidence.total + ' kickoffs — your normal is ' + pct(s.baseline.mean) + '.',
    advice: () => 'Kickoffs er spillets eneste faste situation: boost hele vejen og ram bolden i midten FØRST.',
    advice_en: () => 'Kickoffs are the only fixed situation in the game: boost all the way and hit the ball dead center FIRST.'
  },
  {
    id: 'soft_touches', metric: 'hit_power_avg', severity: 70,
    source: { title: 'Dignitas: Power Shots (ApparentlyJack)', url: 'https://dignitas.gg/articles/a-guide-to-power-shots-in-rocket-league-with-apparentlyjack' },
    when: s => !s.gated && s.value <= s.baseline.mean * 0.85,
    problem: s => 'Touchkraft ' + fmt('hit_power_avg', s.value) + ' i snit mod normalt ' + fmt('hit_power_avg', s.baseline.mean) + ' — blødere touches end du plejer.',
    problem_en: s => 'Touch power ' + fmt('hit_power_avg', s.value) + ' on average against your normal ' + fmt('hit_power_avg', s.baseline.mean) + ' — softer touches than usual.',
    advice: () => 'Boost ind i bolden og flip SENT for kraft — 10 min i træningspakken Powershots (7028-5E10-88EF-E83E).',
    advice_en: () => 'Boost into the ball and flip LATE for power — 10 minutes in the training pack Powershots (7028-5E10-88EF-E83E).'
  },
  {
    id: 'stuck_in_own_half', metric: 'off_touch_share', severity: 60,
    source: { title: 'Dignitas: Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' },
    when: s => !s.gated && s.value <= s.baseline.mean * 0.75 && s.value <= s.baseline.mean - 0.10,
    problem: s => 'Kun ' + pct(s.value) + ' af dine touches faldt på modstanderhalvdelen — normalt ' + pct(s.baseline.mean) + '.',
    problem_en: s => 'Only ' + pct(s.value) + ' of your touches landed on the opponent half — normally ' + pct(s.baseline.mean) + '.',
    advice: () => 'Ryk med frem når holdet har bolden, og gå på den når der er en klar åbning — smart, ikke jagt.',
    advice_en: () => 'Push up when your team has the ball, and go for it when there is a clear opening — smart pressure, on your terms.'
  },
  {
    id: 'low_activity', metric: 'touches_per_min', severity: 50,
    source: { title: 'Dignitas: Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' },
    when: s => !s.gated && s.value <= s.baseline.mean * 0.7,
    problem: s => fmt('touches_per_min', s.value) + ' touches/min mod normalt ' + fmt('touches_per_min', s.baseline.mean) + ' — du var mindre på bolden end du plejer.',
    problem_en: s => fmt('touches_per_min', s.value) + ' touches/min against your normal ' + fmt('touches_per_min', s.baseline.mean) + ' — you were on the ball less than usual.',
    advice: () => 'Vær først på bolden når åbningen er der — den passive ventetid koster førstetouches.',
    advice_en: () => 'Be first to the ball when the opening is there — passive waiting costs you first touches.'
  },
  {
    id: 'demo_magnet', metric: 'demo_diff', severity: 40,
    source: { title: 'Dignitas: Bumps & Demos (Rocket Sledge)', url: 'https://dignitas.gg/articles/bumps-and-demolitions-an-interview-with-rocket-sledge' },
    when: s => s.evidence.received >= 3 && s.value <= -2,     // hard counts from this match — no baseline needed
    problem: s => 'Du blev demo\'et ' + s.evidence.received + ' gange (demo-differens ' + fmt('demo_diff', s.value) + ').',
    problem_en: s => 'You got demoed ' + s.evidence.received + ' times (demo differential ' + fmt('demo_diff', s.value) + ').',
    advice: () => 'Hold øje med supersonic-modstandere på vej mod dig — et sidelæns dodge eller brake-check redder dig.',
    advice_en: () => 'Watch for supersonic opponents heading your way — a sideways dodge or a brake-check saves you.'
  },

  /* --- M4b: bevægelse. Sover indtil metrikken er coachable. --- */
  {
    id: 'driving_not_touching', metric: 'dist_per_touch', severity: 75,
    source: { title: 'Dignitas: Ballchasing (Yukeo)', url: 'https://dignitas.gg/articles/news/rocket-league/13423/ballchasing-in-rocket-league-a-guide-with-yukeo' },
    when: s => !s.gated && s.value >= s.baseline.mean * 1.3 && s.value >= s.baseline.mean + 10,
    problem: s => 'Du kørte ' + fmt('dist_per_touch', s.value) + ' ' + distW(false) + ' pr. touch mod normalt '
      + fmt('dist_per_touch', s.baseline.mean) + ' ' + distW(false) + ' — mere kørsel bag hvert touch end du plejer.',
    problem_en: s => 'You drove ' + fmt('dist_per_touch', s.value) + ' ' + distW(true) + ' per touch against your normal '
      + fmt('dist_per_touch', s.baseline.mean) + ' ' + distW(true) + ' — more driving behind every touch than usual.',
    advice: () => 'Mød bolden i stedet for at følge efter den: lad den rulle når makkeren dækker, og tag den hvor den ER på vej hen.',
    advice_en: () => 'Meet the ball instead of following it: let it roll when your teammate covers, and take it where it is GOING.'
  },
  {
    id: 'hesitating', metric: 'slow_share', severity: 65,
    source: { title: 'Dignitas: Confidence, Anticipation and Imagination', url: 'https://dignitas.gg/articles/confidence-anticipation-and-imagination-essential-skills-for-rocket-league' },
    when: s => !s.gated && s.value >= s.baseline.mean * 1.3 && s.value >= s.baseline.mean + 0.05,
    problem: s => 'Du lå under ' + (s.evidence.under ?? '?') + ' i fart i ' + pct(s.value)
      + ' af spilletiden — din normal er ' + pct(s.baseline.mean) + '.',
    problem_en: s => 'You sat below ' + (s.evidence.under ?? '?') + ' in speed for ' + pct(s.value)
      + ' of the playing time — your normal is ' + pct(s.baseline.mean) + '.',
    advice: () => 'Beslut dig tidligt: enten går du på bolden, eller også falder du helt tilbage. Det dyre er at blive stående midt imellem.',
    advice_en: () => 'Decide early: either you go for the ball or you fall all the way back. The expensive choice is standing in between.'
  },
  {
    id: 'tempo_faded', metric: 'speed_drift', severity: 55,
    source: { title: 'Dignitas: Maintaining Momentum and Quickly Recovering', url: 'https://dignitas.gg/articles/blogs/rocket-league/12955/rocket-league-maintaining-momentum-and-quickly-recovering' },
    when: s => !s.gated && s.value <= 0.85 && s.value <= s.baseline.mean - 0.10,
    problem: s => 'Din fart i sidste tredjedel var ' + fmt('speed_drift', s.value)
      + ' gange farten i første — normalt ligger du på ' + fmt('speed_drift', s.baseline.mean) + '.',
    problem_en: s => 'Your speed in the final third was ' + fmt('speed_drift', s.value)
      + ' times your speed in the first — normally you sit at ' + fmt('speed_drift', s.baseline.mean) + '.',
    advice: () => 'Hold bilen i bevægelse, også når du venter — shadow i stedet for at holde stille i målet.',
    advice_en: () => 'Keep the car moving, even while you wait — shadow the play instead of sitting still in goal.'
  },
  {
    id: 'after_the_goal', metric: 'post_concede_speed', severity: 45,
    source: { title: 'Dignitas: Overcoming the Tilted Mindset', url: 'https://dignitas.gg/articles/overcoming-the-tilted-mindset' },
    // Fires on a DEVIATION either way: a collapse and a frantic spike are both
    // "not your own game", and nothing measured here says which one this was.
    when: s => !s.gated && s.evidence.maal >= 2 && Math.abs(s.value - 1) >= 0.15,
    problem: s => 'I de 15 sekunder efter modstandernes mål lå din fart på ' + fmt('post_concede_speed', s.value)
      + ' gange din fart i resten af kampen (' + s.evidence.maal + ' mål).',
    problem_en: s => 'In the 15 seconds after the opponents scored, your speed sat at ' + fmt('post_concede_speed', s.value)
      + ' times your speed across the rest of the match (' + s.evidence.maal + ' goals).',
    advice: () => 'Læg målet bag dig med det samme — det næste kickoff er det eneste der stadig kan ændre noget.',
    advice_en: () => 'Put the goal behind you immediately — the next kickoff is the only thing that can still change anything.'
  }
];

/* Praise templates: strongest above-own-baseline metric wins. */
const PRAISE = {
  kickoff_self_ft:   s => 'Førstetouch på ' + s.evidence.won + '/' + s.evidence.total + ' kickoffs — over din normal (' + pct(s.baseline.mean) + ').',
  kickoff_team_ft:   s => 'Holdet vandt førstetouch på ' + s.evidence.won + '/' + s.evidence.total + ' kickoffs — normalt ' + pct(s.baseline.mean) + '.',
  kickoff_self_speed:s => 'Kickoff-touchkraft ' + fmt('kickoff_self_speed', s.value) + ' i snit — over din normal (' + fmt('kickoff_self_speed', s.baseline.mean) + ').',
  hit_power_avg:     s => 'Touchkraft ' + fmt('hit_power_avg', s.value) + ' i snit — ' + pct(Math.abs(s.deltaPct)) + ' over din normal.',
  hit_power_max:     s => 'Hårdeste touch: ' + fmt('hit_power_max', s.value) + ' — over din normal (' + fmt('hit_power_max', s.baseline.mean) + ').',
  off_touch_share:   s => pct(s.value) + ' af dine touches på modstanderhalvdelen — mere fremme end normalt (' + pct(s.baseline.mean) + ').',
  boost_low_share:   s => 'Stærk boost-disciplin: kun ' + pct(s.value) + ' af tiden under ' + BOOST_LOW_AT + ' boost (normalt ' + pct(s.baseline.mean) + ').',
  boost_avg:         s => 'Boost-niveau ' + fmt('boost_avg', s.value) + ' i snit — over din normal (' + fmt('boost_avg', s.baseline.mean) + ').',
  touches_per_min:   s => fmt('touches_per_min', s.value) + ' touches/min — mere på bolden end normalt (' + fmt('touches_per_min', s.baseline.mean) + ').',
  demo_diff:         s => 'Demo-differens ' + fmt('demo_diff', s.value) + ' (' + s.evidence.inflicted + ' ude, ' + s.evidence.received + ' hjemme).',
  // Movement. Asleep with their rules — praise needs a deltaPct, and a metric
  // that is not coachable never gets one. Written now so flipping one flag
  // turns on the whole metric, not half of it: a coach that can criticise a
  // number but never credit it is not the coach this product is.
  speed_avg:         s => 'Gennemsnitsfart ' + fmt('speed_avg', s.value) + ' — over din normal (' + fmt('speed_avg', s.baseline.mean) + ').',
  supersonic_share:  s => pct(s.value) + ' af spilletiden i supersonic — mere end du plejer (' + pct(s.baseline.mean) + ').',
  slow_share:        s => 'Kun ' + pct(s.value) + ' af tiden ved lav fart (normalt ' + pct(s.baseline.mean) + ') — du blev ved med at bevæge dig.',
  distance_per_min:  s => fmt('distance_per_min', s.value) + ' ' + distW(false) + ' kørt pr. minut — mere end din normal (' + fmt('distance_per_min', s.baseline.mean) + ' ' + distW(false) + ').',
  dist_per_touch:    s => fmt('dist_per_touch', s.value) + ' ' + distW(false) + ' kørt pr. touch mod normalt ' + fmt('dist_per_touch', s.baseline.mean) + ' ' + distW(false) + ' — kortere vej til bolden end du plejer.',
  speed_drift:       s => 'Du holdt tempoet: sidste tredjedel lå på ' + fmt('speed_drift', s.value) + ' gange den første (normalt ' + fmt('speed_drift', s.baseline.mean) + ').'
};

/* English sisters. Same data, same evidence fields, same order — the language
 * switch in director.js picks the map; nothing else changes. */
const PRAISE_EN = {
  kickoff_self_ft:   s => 'First touch on ' + s.evidence.won + '/' + s.evidence.total + ' kickoffs — above your normal (' + pct(s.baseline.mean) + ').',
  kickoff_team_ft:   s => 'The team won the first touch on ' + s.evidence.won + '/' + s.evidence.total + ' kickoffs — normally ' + pct(s.baseline.mean) + '.',
  kickoff_self_speed:s => 'Kickoff touch power ' + fmt('kickoff_self_speed', s.value) + ' on average — above your normal (' + fmt('kickoff_self_speed', s.baseline.mean) + ').',
  hit_power_avg:     s => 'Touch power ' + fmt('hit_power_avg', s.value) + ' on average — ' + pct(Math.abs(s.deltaPct)) + ' above your normal.',
  hit_power_max:     s => 'Hardest touch: ' + fmt('hit_power_max', s.value) + ' — above your normal (' + fmt('hit_power_max', s.baseline.mean) + ').',
  off_touch_share:   s => pct(s.value) + ' of your touches on the opponent half — further up than usual (' + pct(s.baseline.mean) + ').',
  boost_low_share:   s => 'Strong boost discipline: only ' + pct(s.value) + ' of the time below ' + BOOST_LOW_AT + ' boost (normally ' + pct(s.baseline.mean) + ').',
  boost_avg:         s => 'Boost level ' + fmt('boost_avg', s.value) + ' on average — above your normal (' + fmt('boost_avg', s.baseline.mean) + ').',
  touches_per_min:   s => fmt('touches_per_min', s.value) + ' touches/min — more on the ball than usual (' + fmt('touches_per_min', s.baseline.mean) + ').',
  demo_diff:         s => 'Demo differential ' + fmt('demo_diff', s.value) + ' (' + s.evidence.inflicted + ' dealt, ' + s.evidence.received + ' taken).',
  speed_avg:         s => 'Average speed ' + fmt('speed_avg', s.value) + ' — above your normal (' + fmt('speed_avg', s.baseline.mean) + ').',
  supersonic_share:  s => pct(s.value) + ' of playing time at supersonic — more than usual (' + pct(s.baseline.mean) + ').',
  slow_share:        s => 'Only ' + pct(s.value) + ' of the time at low speed (normally ' + pct(s.baseline.mean) + ') — you kept moving.',
  distance_per_min:  s => fmt('distance_per_min', s.value) + ' ' + distW(true) + ' driven per minute — more than your normal (' + fmt('distance_per_min', s.baseline.mean) + ' ' + distW(true) + ').',
  dist_per_touch:    s => fmt('dist_per_touch', s.value) + ' ' + distW(true) + ' driven per touch against your normal ' + fmt('dist_per_touch', s.baseline.mean) + ' ' + distW(true) + ' — a shorter path to the ball than usual.',
  speed_drift:       s => 'You held your tempo: the final third sat at ' + fmt('speed_drift', s.value) + ' times the first (normally ' + fmt('speed_drift', s.baseline.mean) + ').'
};

module.exports = { RULES, PRAISE, PRAISE_EN };
