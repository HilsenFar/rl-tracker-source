/* RL Director — M3 grounding validator.
 *
 * The trust boundary. rl-director/DESIGN.md §4 makes one promise the whole
 * product rests on: "hvert tal i outputtet skal findes ordret i inputtet".
 * This file is what actually enforces it. If it is wrong, the product lies —
 * so it is deliberately strict and deliberately separate from the code that
 * talks to the network, and it has no dependencies.
 *
 * Strategy: build the set of numbers the engine actually measured, extract
 * every number the model wrote, and reject the whole answer if a single one
 * is unaccounted for. There is no partial pass — a debrief with one invented
 * number is not "mostly true", it is untrustworthy.
 *
 * False rejections are cheap (one retry, then the template ships). A false
 * ACCEPT is the failure that costs the user's trust, so every judgement call
 * below leans towards rejecting.
 *
 * Since 19/8 the same file also holds the second promise the tags depend on:
 * a line is ABOUT the metric its id names. The problem is bound to the
 * engine's own choice (template.problemMetricId), and both lines must quote
 * numbers from the row they claim — see validateAnswer.
 */
'use strict';

/* Canonical string form of a number, so "31%", "+2", "5,2" and 5.2 all
 * compare cleanly. Returns null for anything that isn't a finite number. */
function canon(x){
  if (typeof x === 'number') return Number.isFinite(x) ? String(x) : null;
  if (typeof x !== 'string') return null;
  const s = x.trim().replace(/%$/, '').replace(',', '.').replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

/* Every number the model is allowed to write, gathered from the payload it
 * was given. Anything not in here is, by definition, invented.
 *
 * Both the raw value and its formatted form go in: the engine says "31%"
 * (rounded) while the underlying value is 0.3142, and the model is expected
 * to quote the formatted one.
 */
function allowedNumbers(payload){
  const set = sharedNumbers(payload);
  for (const own of metricNumberSets(payload).values()) for (const c of own) set.add(c);
  return set;
}

/* The numbers that say nothing about WHICH metric a line is about: the
 * constants, the score, the player's own line, the continuity streak — and
 * every baselineN, because "normalen hviler på 7 kampe" must be sayable about
 * any row, and most rows share the same count anyway. */
function sharedNumbers(payload){
  const set = new Set();
  const add = v => { const c = canon(v); if (c !== null) set.add(c); };

  // Structural constants the model is told about in the persona block:
  // the boost threshold appears inside a metric's own name, and the
  // minimum-baseline figure is used in honest "still learning" sentences.
  add(payload.constants && payload.constants.boostLowAt);
  add(payload.constants && payload.constants.minBaseline);

  const m = payload.match || {};
  add(m.playlistSize);
  if (typeof m.myScore === 'string') for (const part of m.myScore.split('-')) add(part);

  for (const k of Object.keys(payload.me || {})) add(payload.me[k]);

  for (const met of payload.metrics || []) add(met.baselineN);

  // Continuity numbers are grounded too — a streak the model may cite has to
  // come from the payload, never from counting the history array itself.
  for (const k of Object.keys(payload.continuity || {})) add(payload.continuity[k]);

  return set;
}

/* Which numbers belong to which metric row: its value (raw and formatted), its
 * baseline (both forms) and its evidence counts. This is the set a line ABOUT
 * that metric can quote — and, read the other way, the receipt that a line
 * quoting one of them is about that row. */
function metricNumberSets(payload){
  const own = new Map();
  for (const met of payload.metrics || []){
    const set = new Set();
    const add = v => { const c = canon(v); if (c !== null) set.add(c); };
    add(met.valueText); add(met.value);
    add(met.baselineText); add(met.baseline);
    for (const k of Object.keys(met.evidence || {})) add(met.evidence[k]);
    own.set(met.id, set);
  }
  return own;
}

/* What a line actually cites: the numbers in it that can ONLY have come from a
 * metric row (shared numbers are skipped — a "3" that is also the save count
 * proves nothing about which row the line is about), and the rows they belong
 * to. A number that is in no row at all is not this function's business; the
 * plain grounding check rejects it as invented. */
function citation(text, own, shared){
  const nums = [], rows = new Set();
  for (const n of extractNumbers(text)){
    if (shared.has(n.canon)) continue;
    let hit = false;
    for (const [id, set] of own) if (set.has(n.canon)){ rows.add(id); hit = true; }
    if (hit) nums.push(n);
  }
  return { nums, rows };
}
function describeCitation(c){
  return 'tal fra "' + [...c.rows].join('"/"') + '" (' + c.nums.map(n => n.raw).join(', ') + ')';
}

/* Same promise, different payload shape.
 *
 * allowedNumbers() enumerates the debrief payload field by field, which is
 * right for a shape that is fixed and small. The weekly payload is neither: it
 * carries per-playlist rows, trend rows, proof rows and totals, and an
 * enumeration would silently fall behind the day a field is added — the worst
 * kind of failure here, because a MISSING allowed number rejects a true
 * sentence and the report quietly loses its narrative.
 *
 * So walk the whole object instead. That is not a loosening of the rule: the
 * payload is built exclusively from the engine's own measurements, so "every
 * number anywhere in the payload" IS the set of numbers the model may write.
 * Strings are mined too, because the engine hands over formatted text
 * ("31W-17L", "63%", "≥ 55%") and the model is expected to quote that form.
 */
function allowedDeep(payload){
  const set = new Set();
  const add = v => { const c = canon(v); if (c !== null) set.add(c); };
  const walk = (v, depth) => {
    if (v === null || v === undefined || depth > 8) return;
    if (typeof v === 'number'){ add(v); return; }
    if (typeof v === 'string'){
      add(v);
      for (const m of v.match(NUM_RE) || []) add(m);
      return;
    }
    if (Array.isArray(v)){ for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object'){ for (const k of Object.keys(v)) walk(v[k], depth + 1); }
  };
  walk(payload, 0);
  return set;
}

/* Pull every number out of a sentence.
 *
 * The lookbehind is load-bearing: without it "4-3" yields 4 and -3, and the
 * -3 fails against an allowed set that holds 3 — a false rejection on every
 * scoreline. With it, a hyphen sitting between two digits is read as a
 * separator (score, range) rather than a minus sign, while a genuine "-4"
 * after a space still parses as negative.
 */
const NUM_RE = /(?<!\d)-?\d+(?:[.,]\d+)?%?/g;

function extractNumbers(text){
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.match(NUM_RE) || []){
    const c = canon(raw);
    if (c !== null) out.push({ raw, canon: c });
  }
  return out;
}

/* A line has to say WHAT was measured, not just quote figures.
 *
 * Measured failure: "17% mod normalt 34%." — every number real, grounding
 * passed it, and it is useless. It names a shortfall without naming the thing
 * that fell short, so the player is told he did badly without being told at
 * what, when, or how. That is blame, not coaching, and it is worse than
 * silence: it cannot be acted on and it cannot be checked.
 *
 * Strip the numbers and see whether a sentence is left. Short words are
 * dropped too ("af", "på", "i") because a line can clear a raw word count
 * while still being pure filler around two figures.
 *
 * Threshold calibrated against real output, not guessed. It started at 4 and
 * that rejected "Holdets førstetouch på 67% — normalt 58%" (three long words),
 * which does name what was measured — a false rejection, and those cost a
 * usable debrief. At 3 the genuine failures still fall: "17% mod normalt 34%"
 * leaves two, "62% mod 53%" leaves one.
 */
function hasSubstance(text){
  const words = String(text || '')
    .replace(/[\d.,%/+\-–—:]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  return words.length >= 3;
}

/* Check one or more model-written strings against the allowed set.
 * Returns { ok, offenders: [{field, raw}] } — offenders are reported back to
 * the model on the single retry, which makes the retry a correction rather
 * than a reroll.
 */
function validateText(fields, allowed){
  const offenders = [];
  for (const [field, text] of Object.entries(fields)){
    for (const n of extractNumbers(text)){
      if (!allowed.has(n.canon)) offenders.push({ field, raw: n.raw });
    }
  }
  return { ok: offenders.length === 0, offenders };
}

/* Full check of a model answer. Text grounding plus the two structural rules:
 * the instruction must be a bank id that was offered, and the cited metric
 * ids must be metrics that actually exist in this payload.
 */
function validateAnswer(answer, payload, allowedInstructionIds, bankFor){
  const problems = [];

  if (!answer || typeof answer !== 'object') return { ok: false, problems: ['svar er ikke et objekt'] };
  for (const f of ['ros', 'problem']){
    if (typeof answer[f] !== 'string' || !answer[f].trim()){ problems.push('feltet "' + f + '" mangler eller er tomt'); continue; }
    if (!hasSubstance(answer[f]))
      problems.push('"' + f + '" er tal uden indhold ("' + answer[f].trim()
                    + '") — sig HVAD der blev målt, ikke kun hvor meget');
  }

  if (!allowedInstructionIds.includes(answer.instruks_id))
    problems.push('instruks_id "' + String(answer.instruks_id) + '" er ikke på listen over tilladte id\'er');

  const byId = new Map((payload.metrics || []).map(m => [m.id, m]));
  for (const id of Array.isArray(answer.metric_ids) ? answer.metric_ids : []){
    if (!byId.has(id)) problems.push('metric_id "' + id + '" findes ikke i denne kamps målinger');
  }

  /* The praise must be true, not just numerically real.
   *
   * A model can quote two genuine numbers and still invert their meaning —
   * measured: "Touchkraft 59 i snit mod normalt 65 — dine hårdeste touches i
   * denne playlist", praising a metric that fell. Numbers alone cannot catch
   * that, so the engine states which metrics actually beat their own baseline
   * (direction applied) and the claim is checked against it. This matters most
   * on the inverted metric, boost_low_share, where lower is better. */
  const rosId = typeof answer.ros_metric_id === 'string' ? answer.ros_metric_id.trim() : '';
  if (rosId){
    const m = byId.get(rosId);
    if (!m) problems.push('ros_metric_id "' + rosId + '" findes ikke i denne kamps målinger');
    else if (m.betterThanNormal === false)
      problems.push('rosen hænger på "' + rosId + '", som ligger DÅRLIGERE end spillerens normal ('
                    + m.valueText + ' mod ' + m.baselineText + ') — det er ikke en ros');
  }

  /* The same check, mirrored — and it is the one that actually bit.
   *
   * Measured on real matches 27/7: two of four voiced debriefs put boost in
   * the problem slot at 11% and 13% against a normal of 20% and 19%, then
   * advised collecting pads. The player's best metric of the night, presented
   * as the thing to fix. Numbers all real, praise correctly placed, and the
   * advice still pointed at the wrong habit — because only the praise was
   * being checked for direction. */
  const probId = typeof answer.problem_metric_id === 'string' ? answer.problem_metric_id.trim() : '';
  if (probId){
    const m = byId.get(probId);
    if (!m) problems.push('problem_metric_id "' + probId + '" findes ikke i denne kamps målinger');
    else if (m.betterThanNormal === true)
      problems.push('problemet hænger på "' + probId + '", som ligger BEDRE end spillerens normal ('
                    + m.valueText + ' mod ' + m.baselineText + ') — det er ikke et problem');
    // A metric the engine does not yet trust to judge cannot become the
    // match's problem, no matter how the persona is worded. The persona asks
    // for this in prose; prose is a request, and this is the rule. (M4b: the
    // movement metrics are measured and shown long before they are believed.)
    else if (m.coachable === false)
      problems.push('problemet hænger på "' + probId + '", som endnu kun MÅLES — den er ikke godkendt '
                    + 'til at bære et råd, og må kun nævnes');
  }

  /* The instruction has to answer the problem that was just stated.
   *
   * The allowed-id list is derived from every metric measured in the match, so
   * a kickoff drill stays legal even when the problem is about positioning —
   * and the model took that liberty: "32% af dine touches faldt på
   * modstanderhalvdelen" followed by "Kickoffs er spillets eneste faste
   * situation". Both halves true, the pair useless. Bind them here rather than
   * narrowing the list up front: the model picks the problem, so the coupling
   * can only be checked once it has. */
  if (probId && bankFor && typeof answer.instruks_id === 'string' && answer.instruks_id !== 'hold_the_line'){
    const entry = bankFor(answer.instruks_id);
    if (entry && Array.isArray(entry.metrics) && !entry.metrics.includes(probId))
      problems.push('instruksen "' + answer.instruks_id + '" handler ikke om "' + probId
                    + '", som problemet peger på — rådet skal svare på problemet');
  }

  /* The problem is the ENGINE's to choose. The voice rephrases it.
   *
   * Measured 18/8 on three real debriefs in one afternoon: the engine fired
   * driving_not_touching (dist_per_touch) and the model wrote about kickoffs;
   * the engine fired stuck_in_own_half (off_touch_share) and the model wrote
   * about boost. Every number real, every direction right, the instruction
   * matched the model's own problem — and the stored debrief still carried
   * the engine's metricId/ruleId next to a sentence about something else.
   * Those tags are what the tape's receipt row, the advice cool-down, the
   * continuity streak and the focus chain are all computed from, so a voice
   * that quietly picks a different problem leaves every one of them pointing
   * at a metric the player never read about.
   *
   * The bind is the template's own problemMetricId: rule fired or "weakest
   * today", that is the match's problem, and the model may only change the
   * words. No metric below normal (null) means no problem: "" and
   * hold_the_line, as the persona already says. Re-mapping the tags to
   * whatever the model chose instead would make the voice a second decision
   * maker — with a ruleId that may never have fired and a cool-down that was
   * charged to a different rule. */
  const tpl = payload.template && typeof payload.template === 'object' ? payload.template : null;
  const own = metricNumberSets(payload), shared = sharedNumbers(payload);
  let boundId = '';
  if (tpl){
    boundId = typeof tpl.problemMetricId === 'string' ? tpl.problemMetricId.trim() : '';
    const bound = boundId ? byId.get(boundId) : null;
    // A bound metric the engine does not trust to judge cannot be required of
    // the model either (the coachable rule above would then reject every
    // answer) — the expected id is "" and the line may still quote the row.
    const expected = bound && bound.coachable !== false ? boundId : '';
    if (probId !== expected){
      if (expected)
        problems.push('problem_metric_id skal være "' + expected + '" (' + bound.label + ') — den metrik motoren '
                      + 'valgte som kampens problem; skift ordlyd og vinkel, aldrig metrik'
                      + (probId ? ' (du skrev "' + probId + '")' : ' (du skrev "")'));
      else
        problems.push('motoren fandt intet problem at coache på i denne kamp — problem_metric_id skal være "" '
                      + 'og instruks_id "hold_the_line"' + (probId ? ' (du skrev "' + probId + '")' : ''));
    }
  }

  /* And the LINE has to be about the id it carries. An id is a claim, and a
   * claim about "which row is this sentence about" cannot be checked by
   * numbers being real — it is checked by WHOSE numbers they are. A line that
   * quotes a metric-only number must quote at least one from its own row; a
   * line that quotes metric-only numbers with an empty id has a row and is
   * hiding it (which is also the one way left to praise a metric that fell,
   * or to blame one that rose: leave the id blank and skip the direction
   * check above). Shared numbers — score, saves, a streak, baselineN — carry
   * no such signal and are ignored here. */
  const rosCite = citation(answer.ros, own, shared);
  if (rosId && own.has(rosId) && rosCite.nums.length && !rosCite.nums.some(n => own.get(rosId).has(n.canon)))
    problems.push('rosen hænger på "' + rosId + '" men citerer ingen af dens tal (' + byId.get(rosId).valueText
                  + ' mod ' + byId.get(rosId).baselineText + ') — den bruger ' + describeCitation(rosCite)
                  + '; sæt ros_metric_id på den metrik rosen faktisk handler om');
  if (!rosId && rosCite.nums.length)
    problems.push('rosen citerer ' + describeCitation(rosCite) + ' men ros_metric_id er tom — sæt id\'et på den '
                  + 'metrik rosen hænger på');

  if (tpl){
    const probCite = citation(answer.problem, own, shared);
    const rowSet = boundId ? own.get(boundId) : null;
    if (probCite.nums.length && !(rowSet && probCite.nums.some(n => rowSet.has(n.canon))))
      problems.push(rowSet
        ? 'problemet hænger på "' + boundId + '" men citerer ingen af dens tal (' + byId.get(boundId).valueText
          + ' mod ' + byId.get(boundId).baselineText + ') — den bruger ' + describeCitation(probCite)
          + ', som hører til en anden række; skriv om "' + boundId + '"'
        : 'problemet citerer ' + describeCitation(probCite) + ', men motoren fandt intet problem at coache på '
          + 'i denne kamp — lad tallet stå i tabellen');
  }

  // No problem named, no instruction owed: a drill with nothing to answer is
  // the bank text the persona forbids for exactly this case.
  if (!probId && typeof answer.instruks_id === 'string' && answer.instruks_id !== 'hold_the_line'
      && allowedInstructionIds.includes(answer.instruks_id))
    problems.push('uden et problem_metric_id skal instruks_id være "hold_the_line" — et råd uden et problem at '
                  + 'svare på hænger i luften');

  const allowed = allowedNumbers(payload);
  const v = validateText({ ros: answer.ros, problem: answer.problem }, allowed);
  for (const o of v.offenders)
    problems.push('tallet ' + o.raw + ' i ' + o.field + ' findes ikke i inputtet');

  return { ok: problems.length === 0, problems };
}

/* A training-pack code, e.g. 2D89-9321-42D2-48BA. The engine prints these from
 * the curated bank; a model writing one has invented a code that will send the
 * player to whatever pack happens to own it. Cheaper to forbid the shape than
 * to check it against the bank — the narrative has no business quoting codes. */
const PACK_CODE_RE = /\b[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}\b/;

/* The weekly narrative: free-running Danish prose rather than three fixed
 * lines, so the checks are the ones prose can break — every number grounded,
 * something actually said, no invented pack codes, and a length the board and
 * the report can both hold. */
function validateNarrative(text, payload, maxChars){
  const problems = [];
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return { ok: false, problems: ['narrativen er tom'] };
  if (s.length > (maxChars || 1200))
    problems.push('narrativen er ' + s.length + ' tegn — over grænsen på ' + (maxChars || 1200));
  if (!hasSubstance(s)) problems.push('narrativen er tal uden indhold — sig HVAD der blev målt');
  const code = s.match(PACK_CODE_RE);
  if (code) problems.push('træningsbane-koden ' + code[0] + ' må ikke skrives af dig — motoren udskriver koderne');
  const allowed = allowedDeep(payload);
  for (const n of extractNumbers(s))
    if (!allowed.has(n.canon)) problems.push('tallet ' + n.raw + ' findes ikke i inputtet');
  return { ok: problems.length === 0, problems };
}

module.exports = { canon, allowedNumbers, allowedDeep, sharedNumbers, metricNumberSets, citation,
                   extractNumbers, validateText, validateAnswer, validateNarrative, hasSubstance,
                   NUM_RE, PACK_CODE_RE };
