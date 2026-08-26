/* RL Director — M3 LLM gateway (BYOK, zero dependencies, multi-provider).
 *
 * The deterministic debrief is built FIRST and always. This module only ever
 * tries to say the same true thing better; if anything at all goes wrong — no
 * key, budget spent, network down, model invents a number — the template
 * debrief the user already has on screen simply stays. That is the "ægte
 * nul-kroner-tilstand" from rl-director/DESIGN.md §4, and it is why this file
 * can never throw into the recorder path.
 *
 * Backends live in providers.js. This file owns the parts that are the same
 * everywhere: budget, the structured-output degradation ladder, robust JSON
 * extraction, one corrective retry, and handing the result to grounding.js.
 *
 * grounding.js is deliberately untouched by any of this. On a backend with no
 * structured output it is the ONLY thing standing between the user and an
 * invented number, so it stays independent of who generated the text.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const M = require('./metrics');
const store = require('./store');
const persona = require('./persona');
const grounding = require('./grounding');
const { PROVIDERS, resolveEndpoint } = require('./providers');

const MAX_TOKENS = 900;   // reasoning models spend part of this on thought before answering
const DAILY_LIMIT_DEFAULT = 60;
const HISTORY_FOR_CONTINUITY = 3;        // DESIGN §4: "de sidste 3 debriefs"

let ROOT = null, log = () => {};
let cfg = null;
let cacheWarned = false, providerWarned = false;

function cfgPath(){ return path.join(ROOT, 'director-ai.json'); }

function defaultCfg(){
  return {
    schema: 'director-ai/2',
    enabled: true,
    /* 'da' or 'en'. Chooses the frozen persona block, the user-message framing
     * and the instruction-bank text. Lives in config (never per call): each
     * language is its own Anthropic cache prefix, so it must stay stable
     * across a session. DEFAULT FØLGER MASKINENS OS-SPROG (26/8, Reddit-
     * testrunden): en frisk engelsk tester må aldrig fødes med dansk motor —
     * ejerens/K4W's eksisterende config-filer er uberørte af denne default. */
    language: (function(){ try{
      return String(Intl.DateTimeFormat().resolvedOptions().locale || '')
        .toLowerCase().startsWith('da') ? 'da' : 'en';
    }catch(e){ return 'en'; } })(),
    provider: 'anthropic',
    providers: {
      anthropic: { key: '', model: 'claude-haiku-4-5' },
      nvidia:    { key: '', model: 'google/gemma-3-27b-it' },
      ollama:    { key: '', model: 'gemma3:12b' },
      custom:    { baseUrl: '', key: '', model: '' }
    },
    dailyLimit: DAILY_LIMIT_DEFAULT,
    day: '', used: 0,
    spentUsd: 0,
    caps: {},               // learned at runtime: "provider:model" -> {responseFormat}
    lastError: null
  };
}

/* v1 kept key+model at the root and only ever meant Anthropic. Move them in
 * place rather than making the user re-enter a key they already pasted. */
function migrate(c){
  if (c && c.schema === 'director-ai/1'){
    const key = c.key || '', model = c.model || 'claude-haiku-4-5';
    const out = defaultCfg();
    out.enabled = c.enabled !== false;
    out.providers.anthropic = { key, model };
    out.dailyLimit = c.dailyLimit || DAILY_LIMIT_DEFAULT;
    out.day = c.day || ''; out.used = c.used || 0;
    out.spentUsd = c.spentUsd || 0;
    return { cfg: out, migrated: true };
  }
  return { cfg: c, migrated: false };
}

function today(){ return new Date().toISOString().slice(0, 10); }
function save(){ try{ store.writeJSON(cfgPath(), cfg, 1); }catch{} }
function lang(){ return cfg && cfg.language === 'en' ? 'en' : 'da'; }

function def(){ return PROVIDERS[cfg.provider] || null; }
function pcfg(){
  const p = (cfg.providers && cfg.providers[cfg.provider]) || {};
  return Object.assign({}, p, { model: p.model || (def() && def().defaultModel) || '', maxTokens: MAX_TOKENS });
}
function capsKey(){ return cfg.provider + ':' + pcfg().model; }

function init(opts){
  ROOT = opts.root;
  log = opts.log || log;
  const raw = store.readJSON(cfgPath(), defaultCfg);
  const m = migrate(raw);
  cfg = m.cfg;
  if (m.migrated){ save(); log('[voice] config migreret til director-ai/2 (nøglen er flyttet, ikke tabt)'); }
  if (!fs.existsSync(cfgPath())) save();

  const d = def();
  if (!d){ log('[voice] ukendt provider "' + cfg.provider + '" — slået fra'); return module.exports; }

  // The cache-floor warning is an Anthropic concept. Logging it for a backend
  // without prompt caching would report a problem that cannot exist there.
  if (d.supportsCache){
    const est = persona.estimateTokens(lang());
    if (est < 4096)
      log('[voice] ADVARSEL: persona-blokken er ca. ' + est + ' tokens — UNDER Anthropics cache-grænse på 4096. '
          + 'Caching slår ikke til, og hvert kald koster fuld pris.');
  }
  log('[voice] ' + (ready() ? 'klar — ' + d.label + ', model ' + pcfg().model + ', ' + quota().used + '/' + quota().limit + ' kald i dag'
                            : 'slået fra — ' + reasonNotReady()));
  return module.exports;
}

function reasonNotReady(){
  if (!cfg || !cfg.enabled) return 'enabled=false';
  const d = def();
  if (!d) return 'ukendt provider';
  if (d.needsKey && !String(pcfg().key || '').trim()) return 'ingen nøgle til ' + d.label + ' i director-ai.json';
  if (d.fromBaseUrl && !resolveEndpoint(d, pcfg())) return 'ingen gyldig baseUrl';
  if (!pcfg().model) return 'ingen model valgt';
  return 'ukendt årsag';
}

function quota(){
  if (cfg.day !== today()){ cfg.day = today(); cfg.used = 0; save(); }
  return { used: cfg.used, limit: cfg.dailyLimit, exhausted: cfg.used >= cfg.dailyLimit };
}

function ready(){
  if (!cfg || !cfg.enabled) return false;
  const d = def();
  if (!d || !pcfg().model) return false;
  if (d.needsKey && !String(pcfg().key || '').trim()) return false;
  if (d.fromBaseUrl && !resolveEndpoint(d, pcfg())) return false;
  return true;
}

/* ---------------- payload ----------------
 * Everything the model may know. Nothing else reaches it: no raw stream, no
 * opponent detail, no free text from the game — so it cannot "notice"
 * anything the engine did not measure (DESIGN §4).
 */
function buildPayload(debrief, history){
  const metrics = (debrief.metrics || [])
    .filter(m => M.DEFS[m.id])
    .map(m => ({
      id: m.id,
      // The unit rides on the LABEL, never on the value: grounding.canon()
      // rejects any string that is not a bare number, so "46 km/t" as a
      // valueText would drop the number out of the allowed set and get every
      // true sentence quoting it thrown away.
      label: M.labelWithUnit(m.id),
      direction: M.DEFS[m.id].direction,
      // Measured but not yet trusted to judge (M4b). The model is told in
      // prose that it may only name these; grounding.js enforces it here as a
      // rule, because prose is a request and this is not negotiable.
      coachable: M.coachable(m.id),
      value: m.value,
      valueText: M.fmt(m.id, m.value),
      baseline: m.baseline ? m.baseline.mean : null,
      baselineText: m.baseline ? M.fmt(m.id, m.baseline.mean) : null,
      baselineN: m.baseline ? m.baseline.n : 0,
      // Direction already applied, so the model never has to reason about it.
      // Measured need: gpt-oss-20b praised "touchkraft 59 mod normalt 65" as
      // the player's hardest touches — both numbers real, the claim false.
      // grounding.js checks numbers, not logic, so the engine states the
      // verdict here and validates it on the way back.
      // null, not false, when there is no verdict to give: a metric with no
      // direction (time off the ground, speed after conceding) is a
      // measurement the engine refuses to call good or bad, and `false` would
      // read to the model as "this was worse" — the persona forbids praising a
      // false, so the metric would silently become a criticism.
      betterThanNormal: m.baseline && M.DEFS[m.id].direction
        ? (m.value - m.baseline.mean) * M.DEFS[m.id].direction > 0
        : null,
      // Which bank entries actually address this metric. Handing the
      // coupling over up front is cheaper than rejecting a mismatch after
      // the fact: measured, the model paired "32% af dine touches faldt paa
      // modstanderhalvdelen" with a kickoff drill, and the corrective retry
      // then came back empty three times running.
      instruksIds: persona.INSTRUCTION_BANK
        .filter(e => e.id !== 'hold_the_line' && e.metrics.includes(m.id))
        .map(e => e.id),
      evidence: m.evidence || {}
    }));

  const recent = (history || []).slice(0, HISTORY_FOR_CONTINUITY).map(d => ({
    at: d.at,
    playlist: d.match && d.match.playlist,
    result: d.match && d.match.result,
    ros: d.ros && d.ros.text,
    problem: d.problem && d.problem.text,
    problemMetric: d.problem && d.problem.metricId
  }));

  const thisProblem = debrief.problem && debrief.problem.metricId;
  let streak = thisProblem ? 1 : 0;
  if (thisProblem) for (const d of recent){ if (d.problemMetric === thisProblem) streak++; else break; }

  const playlist = debrief.match.playlist || '';
  return {
    constants: { boostLowAt: M.BOOST_LOW_AT, minBaseline: M.MIN_BASELINE },
    match: {
      playlist,
      playlistSize: Number(String(playlist).split('v')[0]) || null,
      myScore: (debrief.match.myTeam === 1
        ? [debrief.match.score[1], debrief.match.score[0]]
        : debrief.match.score).join('-'),
      result: debrief.match.result,
      abandoned: !!debrief.match.abandoned
    },
    me: {
      goals: debrief.me ? debrief.me.goals : undefined,
      assists: debrief.me ? debrief.me.assists : undefined,
      saves: debrief.me ? debrief.me.saves : undefined,
      shots: debrief.me ? debrief.me.shots : undefined,
      touches: debrief.me ? debrief.me.touches : undefined
    },
    metrics,
    template: {
      ros: debrief.ros && debrief.ros.text,
      problem: debrief.problem && debrief.problem.text,
      advice: debrief.advice && debrief.advice.text,
      firedRule: debrief.problem && debrief.problem.ruleId,
      // The engine's choice of problem, by id. This is what problem_metric_id
      // MUST be (grounding.js binds it): the tags the engine stamped on the
      // debrief — metricId, ruleId, the tape's receipt row, the advice
      // cool-down — were all computed for THIS metric, and a voice that wrote
      // about another would leave them describing a sentence nobody read.
      // null when nothing fell below normal, and then the answer is "".
      problemMetricId: (debrief.problem && debrief.problem.metricId) || null
    },
    continuity: { sameProblemStreak: streak },
    history: recent
  };
}

/* Stable across calls: keeps Anthropic's 24h schema cache warm, and gives the
 * OpenAI-compatible backends a schema that already satisfies `strict`
 * (every property required, additionalProperties false). */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ros', 'problem', 'instruks_id', 'metric_ids', 'ros_metric_id', 'problem_metric_id'],
  properties: {
    ros: { type: 'string' },
    problem: { type: 'string' },
    instruks_id: { type: 'string' },
    metric_ids: { type: 'array', items: { type: 'string' } },
    // Naming the praised metric is what makes the praise checkable: the engine
    // knows whether that metric actually beat its own baseline, and rejects
    // the answer if it did not. Empty string when the praise is not about a
    // metric (a save, a goal, touches).
    ros_metric_id: { type: 'string' },
    // Same check in the other direction. Measured 27/7 on real matches: two of
    // four debriefs put boost — the player's BEST metric that night — in the
    // problem slot and told him to train it. Validating only the praise left
    // the mirror image wide open.
    problem_metric_id: { type: 'string' }
  }
};

/* The shape instruction lives in the USER message, never in the persona block.
 * Putting it in the system prompt would change Anthropic's cached prefix and
 * throw away the cache; here it costs a few uncached tokens and makes the
 * prompt identical no matter which capability level we ended up at. */
const FORM_RULE =
  'Svar KUN med ét JSON-objekt og intet andet. Ingen markdown, ingen kodehegn, '
  + 'ingen forklaring før eller efter. Nøjagtigt disse fire nøgler:\n'
  + '{"ros": <streng>, "problem": <streng>, "instruks_id": <streng>, "metric_ids": [<streng>]}';

/* English sister of FORM_RULE. The JSON keys stay the Danish identifiers on
 * purpose — OUTPUT_SCHEMA is byte-stable across languages (see its comment),
 * so only the prose around the keys changes with the language setting. */
const FORM_RULE_EN =
  'Reply ONLY with one JSON object and nothing else. No markdown, no code fences, '
  + 'no explanation before or after. Exactly these four keys:\n'
  + '{"ros": <string>, "problem": <string>, "instruks_id": <string>, "metric_ids": [<string>]}';

/* Pull one JSON object out of a model message. Handles ```json fences and
 * prose on either side. Brace counting is string-aware: a brace inside a
 * Danish sentence in "ros" must not close the object. No regex-only version
 * works — /\{.*\}/s grabs too much, /\{[^}]*\}/ too little.
 *
 * Returns null on an unterminated object. Deliberately makes NO repair
 * attempt: a guessed-at fix could smuggle a number past grounding.js, which
 * would then validate it in good faith. */
function extractJson(raw){
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++){
    const c = s[i];
    if (esc){ esc = false; continue; }
    if (c === '\\' && inStr){ esc = true; continue; }
    if (c === '"'){ inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0){
      try{ return JSON.parse(s.slice(start, i + 1)); }catch{ return null; }
    }
  }
  return null;
}

function post(ep, headers, body, timeout){
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done){ done = true; resolve(r); } };
    const payload = Buffer.from(JSON.stringify(body));
    const mod = ep.secure ? https : http;
    const req = mod.request({
      host: ep.host, port: ep.port, path: ep.path, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': payload.length }, headers)
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; if (buf.length > 2e6) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return finish({ status: res.statusCode, error: 'HTTP ' + res.statusCode + ': ' + buf.slice(0, 400) });
        try{ finish({ status: 200, data: JSON.parse(buf) }); }
        catch(e){ finish({ status: 200, error: 'ugyldigt JSON-svar: ' + (e.message || e) }); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); finish({ error: 'timeout efter ' + timeout + ' ms' }); });
    req.on('error', e => finish({ error: String(e.message || e) }));
    req.end(payload);
  });
}

/* Transport failures worth trying once more.
 *
 * Measured on NVIDIA's free tier 2026-07-27: a request either answered in
 * 4-13s or the connection was reset by the server at a consistent ~37.5s.
 * That is shared-capacity load, not anything about our request — the same
 * payload succeeded on the next call. Retrying converts a class of failures
 * into successes at no cost to correctness, and the debrief is asynchronous
 * so the extra wait costs the user nothing.
 *
 * Deliberately NOT retried: 429 (retrying a rate limit is how you stay rate
 * limited), and every 4xx that is a real answer about a bad request.
 */
function isTransient(res){
  if (!res) return false;
  if (res.status === 502 || res.status === 503 || res.status === 504) return true;
  if (res.status) return false;                       // a real HTTP answer: not transient
  return /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|timeout efter/i.test(String(res.error || ''));
}

async function postWithRetry(ep, headers, body, timeout, label){
  let res = await post(ep, headers, body, timeout);
  if (isTransient(res)){
    log('[voice] ' + label + ' svigtede (' + res.error + ') — ét genforsøg');
    res = await post(ep, headers, body, timeout);
  }
  return res;
}

/* Does this error look like "I don't know that parameter"? Only then is
 * degrading the right move — a 400 about a bad model name must not silently
 * turn into a weaker structured-output mode. */
function isFormatRejection(res){
  if (!res || (res.status !== 400 && res.status !== 422)) return false;
  return /response_format|json_schema|guided|unsupported|unknown|not supported|invalid.*format/i.test(String(res.error || ''));
}

function accountFor(d, u){
  if (!u) return;
  if (d.supportsCache){
    const inTok = u.inputTokens + u.cacheWrite * 2 + u.cacheRead * 0.1;   // 1h TTL: write 2x, read 0.1x
    cfg.spentUsd = Math.round((cfg.spentUsd + (inTok * d.priceIn + u.outputTokens * d.priceOut) / 1e6) * 1e6) / 1e6;
    if (!cacheWarned && !u.cacheRead && !u.cacheWrite){
      cacheWarned = true;
      log('[voice] ADVARSEL: intet blev cachet — hvert kald koster fuld pris.');
    }
  }
}

/* A VALIDATED answer -> the three voiced lines, tagged. Pure, so the tagging
 * can be tested without a network.
 *
 * Who owns which tag (19/8-2026, after three debriefs in one afternoon carried
 * engine tags next to sentences about other metrics):
 *  - ros.metricId      = the model's ros_metric_id — the metric it PRAISED,
 *                        which grounding.js has checked is better than normal
 *                        and is the row the line quotes. Until 19/8 this was
 *                        metric_ids[0], i.e. whichever id the model happened
 *                        to list first — usually the problem's.
 *  - problem.metricId,
 *    problem.ruleId    = the engine's. grounding.js has rejected any answer
 *                        whose problem_metric_id is not the template's, so
 *                        the engine tag and the model's sentence now name the
 *                        same row — and the tape receipt, the advice
 *                        cool-down, the continuity streak and the focus chain
 *                        keep one author.
 *  - advice.ruleId     = the engine's fired rule; the bank entry the model
 *                        chose is one of that rule's metric's own phrasings
 *                        (grounding.js: the instruction must address the
 *                        problem metric), and its id rides along as bankId.
 */
function compose(debrief, answer, L, meta){
  const bank = persona.BANK_BY_ID.get(answer.instruks_id);
  const rosId = typeof answer.ros_metric_id === 'string' ? answer.ros_metric_id.trim() : '';
  return {
    ros: { text: String(answer.ros).trim(), metricId: rosId || null },
    problem: { text: String(answer.problem).trim(),
               metricId: debrief.problem ? debrief.problem.metricId : null,
               ruleId: debrief.problem ? debrief.problem.ruleId : null },
    // The engine renders the instruction — the model only chose which one.
    // A silent template advice (null — repetition suppressed, see
    // applyAdviceSilence in director.js) stays silent: the model still
    // picks an instruks_id (the schema requires one), but the engine owns
    // the decision to speak, and a suppressed line must not be revived
    // by the voice pass seconds later.
    advice: debrief.advice
      ? persona.adviceFrom(bank, L, debrief.advice.ruleId)
      : null,
    meta: meta || {}
  };
}

/* ---------------- main entry ----------------
 * Returns { ros, problem, advice, meta } on success, or null. NEVER throws.
 * `advice` is null when the template's advice was null (silence preserved).
 */
async function speak(debrief, history){
  if (!ready()) return null;
  const q = quota();
  if (q.exhausted){ log('[voice] dagsloft nået (' + q.used + '/' + q.limit + ') — skabelon-debrief beholdes'); return null; }

  const d = def(), p = pcfg();
  const ep = resolveEndpoint(d, p);
  if (!ep) return null;
  if (d.warn && !providerWarned){ providerWarned = true; log('[voice] ' + d.warn); }

  const payload = buildPayload(debrief, history);
  const allowedIds = persona.allowedInstructionIds(payload.metrics.map(m => m.id));
  const L = lang();
  const userMsg = (L === 'en'
      ? 'Write the debrief for this match.\n\nAllowed instruction ids: '
      : 'Skriv debriefen for denne kamp.\n\nTilladte instruks-id\'er: ')
    + JSON.stringify(allowedIds) + '\n\n'
    + JSON.stringify(payload) + '\n\n' + (L === 'en' ? FORM_RULE_EN : FORM_RULE);

  const key = capsKey();
  if (!cfg.caps[key]) cfg.caps[key] = {};
  if (d.structured === 'native') cfg.caps[key].responseFormat = 'native';
  else if (!cfg.caps[key].responseFormat) cfg.caps[key].responseFormat = 'json_schema';

  let messages = [{ role: 'user', content: userMsg }];
  let lastProblems = null;

  for (let attempt = 0; attempt < 2; attempt++){
    let res = null;

    // Capability ladder. A rejection of the FORMAT parameter is not a failed
    // attempt — it costs no quota, is retried immediately one rung down, and
    // the outcome is remembered so the same 400 is only ever paid once.
    // Anthropic never enters the ladder: output_config is documented, so a 400
    // there means something else is wrong and must surface as an error.
    for (let rung = 0; rung < 3; rung++){
      const level = cfg.caps[key].responseFormat;
      const body = d.body(p, persona.systemFor(L), userMsg, OUTPUT_SCHEMA, level);
      // Multi-turn (the corrective retry) replaces the turns, never the system
      // block: Anthropic keeps `system` separate, OpenAI wants it as turn one.
      body.messages = d.structured === 'native'
        ? messages
        : [{ role: 'system', content: persona.systemFor(L) }].concat(messages);

      cfg.used++; save();
      res = await postWithRetry(ep, d.headers(p), body, d.timeout, d.label);

      if (d.structured === 'native' || !isFormatRejection(res)) break;
      if (level === 'none') break;                  // nothing left to fall back to

      cfg.used--; save();                           // capability probe, not an attempt
      cfg.caps[key].responseFormat = level === 'json_schema' ? 'json_object' : 'none';
      save();
      log('[voice] ' + d.label + ' afviste ' + level + ' — falder tilbage til ' + cfg.caps[key].responseFormat);
    }

    if (res.error){
      cfg.lastError = res.error; save();
      log('[voice] kald fejlede: ' + res.error);
      return null;
    }
    accountFor(d, d.usage(res.data));

    const parsed = d.read(res.data);
    if (parsed.error){
      cfg.lastError = parsed.error; save();
      log('[voice] ' + parsed.error);
      return null;
    }
    const answer = extractJson(parsed.text);
    if (!answer){
      cfg.lastError = 'kunne ikke udtrække JSON af svaret';
      save();
      log('[voice] svaret indeholdt ikke et brugbart JSON-objekt (normal drift uden struktureret output)');
      return null;
    }

    const check = grounding.validateAnswer(answer, payload, allowedIds, id => persona.BANK_BY_ID.get(id));
    if (check.ok){
      const u = d.usage(res.data);
      cfg.lastError = null; save();
      return compose(debrief, answer, L, {
        provider: cfg.provider, model: res.data.model || p.model,
        attempt: attempt + 1,
        responseFormat: cfg.caps[key].responseFormat,
        instruksId: answer.instruks_id,
        cacheRead: u.cacheRead, usage: u
      });
    }

    lastProblems = check.problems;
    log('[voice] grounding afviste svaret (forsøg ' + (attempt + 1) + '): ' + check.problems.join('; '));
    if (attempt === 0){
      // Single turn, not a conversation. Replaying the rejected answer as an
      // assistant turn made this model return an empty content field three
      // times in a row (finish_reason "stop"); folding the correction into one
      // user message keeps it answering.
      // The validator's reason strings are Danish regardless of output
      // language — in English mode they are framed as quoted diagnostics so
      // the model corrects the fault without drifting into Danish prose.
      // The bind is restated by id, so the correction names the row to write
      // about rather than only the row not to.
      const bound = payload.template.problemMetricId;
      messages = [{ role: 'user', content: L === 'en'
        ? userMsg + '\n\nYOUR PREVIOUS REPLY WAS REJECTED. Validator reasons (in Danish):\n- '
          + check.problems.join('\n- ')
          + '\n\nFix exactly that and reply again, in English. Use ONLY numbers that appear '
          + 'verbatim in the input. '
          + (bound
            ? 'The problem line is about "' + bound + '" and nothing else — quote THAT metric\'s '
              + 'valueText and baselineText, set problem_metric_id to "' + bound + '", and pick an '
              + 'instruks_id from its own instruksIds list so the advice answers the problem. '
            : 'The engine found no problem to coach in this match: problem_metric_id is "" and '
              + 'instruks_id is "hold_the_line". ')
          + 'When in doubt about a number, leave it out of the sentence.'
        : userMsg + '\n\nDIT FORRIGE SVAR BLEV AFVIST:\n- ' + check.problems.join('\n- ')
          + '\n\nRet præcis det, og svar igen. Brug KUN tal der står ordret i inputtet. '
          + (bound
            ? 'Problem-linjen handler om "' + bound + '" og intet andet — citér DEN metriks valueText og '
              + 'baselineText, sæt problem_metric_id til "' + bound + '", og vælg et instruks_id fra dens '
              + 'egen instruksIds-liste, så rådet svarer på problemet. '
            : 'Motoren fandt intet problem at coache på i denne kamp: problem_metric_id er "" og '
              + 'instruks_id er "hold_the_line". ')
          + 'Er du i tvivl om et tal, så lad det være ude af sætningen.' }];
    }
  }

  log('[voice] to forsøg afvist — skabelon-debrief beholdes');
  cfg.lastError = 'grounding: ' + (lastProblems || []).join('; ');
  save();
  return null;
}

/* ---------------- the weekly narrative (M4) ----------------
 *
 * Once a week, so the economics are irrelevant and the quality bar is higher:
 * this is the one piece of text in the product that is allowed to be a
 * paragraph. It reuses the SAME cached persona block (the rules about numbers,
 * honesty and "dig mod dig" are identical), and adds only the shape rule.
 *
 * The deterministic report is already written and linked when this runs. A
 * failure here leaves a complete report without a narrative — never a missing
 * report and never an unchecked sentence.
 */
const WEEKLY_MAX_CHARS = 900;

const WEEKLY_FORM_RULE =
  'Skriv ugens opsamling som SAMMENHÆNGENDE DANSK PROSA — 3 til 5 sætninger, højst '
  + WEEKLY_MAX_CHARS + ' tegn. Ingen overskrifter, ingen punktopstilling, ingen markdown.\n'
  + 'Struktur (uden at skrive overskrifterne): hvad ugen VISTE i tal · hvad fokus beviste eller ikke beviste · '
  + 'hvad han tager med ind i næste uge.\n'
  + 'Hver trend har felterne "status" og "retning" — brug DEM til at afgøre om et tal er godt eller skidt. '
  + 'Regn det aldrig ud selv: på "tid under 15 boost" er et LAVERE tal det gode.\n'
  + 'Er "trends" tom, er ugens normal endnu ikke moden nok til at dømme — så SIG det, og hold dig til '
  + 'kampe, mål, skud og bevis-opsamlingen. Find aldrig en trend frem for at fylde plads ud.\n'
  + 'Vil du sige noget om trendene SAMLET ("de fleste", "ingen af dem"), så brug tallene i '
  + '"trendOpsamling" — påstande om hvor mange der gik op eller ned skal komme derfra, ikke fra din egen optælling.\n'
  + 'Bevis: skriv KUN det, "bevisOpsamling" siger — gengiv "linje" eller omskriv den med de samme tal. '
  + 'Nævn ALDRIG et enkelt fokus ved navn sammen med en dom (nået, på vej, stod stille, gik tilbage, ikke målbart): '
  + 'du får ikke at vide hvilket fokus der fik hvilken dom, og motoren viser rækkerne med navn lige under din tekst.\n'
  + 'Sidste sætning skal handle om "fokusNaesteUge", hvis feltet findes — ellers om hvad der mangler data til. '
  + 'Giv ikke dine egne råd ud over det: motoren udskriver træningsbaner og missioner lige under din tekst.\n'
  + 'FORBUDT: at skrive en træningsbane-kode (motoren udskriver dem selv), at nævne rank som bevis for en vane, '
  + 'og at bruge et tal der ikke står ordret i inputtet.\n'
  + 'Svar KUN med ét JSON-objekt: {"narrativ": <streng>}';

/* The proof rows collapsed to what the model may say about them: counts per
 * verdict and the verdict line, written here so the model has a true sentence
 * to quote instead of one to compose. The verdict strings are weekly.js's own
 * (proofFor); an unknown verdict counts as nothing rather than as a judgement.
 * Danish regardless of report language, like the rest of the narrative. */
const VERDICT_KEY = { 'opnået': 'opnaaet', 'på vej': 'paaVej', 'ikke rykket': 'ikkeRykket',
                      'tilbagegang': 'tilbagegang', 'ikke målbart': 'ikkeMaalbart' };
function proofSummary(proof){
  const c = { opnaaet: 0, paaVej: 0, ikkeRykket: 0, tilbagegang: 0, ikkeMaalbart: 0 };
  for (const p of proof || []){ const k = VERDICT_KEY[p && p.verdict]; if (k) c[k]++; }
  const bedoemte = c.opnaaet + c.paaVej + c.ikkeRykket + c.tilbagegang;
  const parts = [];
  if (bedoemte){
    parts.push(c.opnaaet + ' af ' + bedoemte + ' bedømte fokus nåede målet');
    if (c.paaVej) parts.push(c.paaVej + ' på vej');
    if (c.ikkeRykket) parts.push(c.ikkeRykket + ' stod stille');
    if (c.tilbagegang) parts.push(c.tilbagegang + ' gik tilbage');
  }
  if (c.ikkeMaalbart) parts.push(c.ikkeMaalbart + ' fokus havde for få kampe til en dom');
  const linje = parts.length ? 'Bevis: ' + parts.join(' · ') + '.' : 'Bevis: intet fokus var sat i denne uge.';
  return Object.assign({ fokusIAlt: bedoemte + c.ikkeMaalbart, bedoemte }, c, { linje });
}

/* Only what the engine measured, in the form it formatted. Immature trends are
 * included but flagged: leaving them out would hide the honest "still
 * collecting" answer, which is the whole reason the maturity gate exists. */
function buildWeeklyPayload(r){
  const t = r.totals;
  return {
    constants: { minBaseline: M.MIN_BASELINE, boostLowAt: M.BOOST_LOW_AT },
    uge: {
      nummer: r.week, fra: r.from, til: r.to,
      kampe: t.matches, spilledage: t.days, sessioner: t.sessions,
      resultat: t.wl.w + 'W-' + t.wl.l + 'L',
      sejre: t.wl.w, nederlag: t.wl.l,
      maal: t.goals, skud: t.shots,
      konvertering: t.conversion === null ? null : Math.round(t.conversion * 100) + '%'
    },
    playlists: Object.keys(r.playlists).map(k => ({
      navn: k, kampe: r.playlists[k].n,
      resultat: r.playlists[k].w + 'W-' + r.playlists[k].l + 'L',
      maal: r.playlists[k].goals, skud: r.playlists[k].shots,
      konvertering: r.playlists[k].conversion === null ? null : Math.round(r.playlists[k].conversion * 100) + '%'
    })),
    /* What the game said the matches were, per size (17/8): counts by kind, so
     * "40 turneringskampe" is a number the model was given, not one it made. An
     * id-less match is listed as exactly that — the model may say the tracker
     * cannot tell what those were, never guess it. Empty on reports stored
     * before the field existed. */
    hvadKampeneVar: Object.keys(r.modes || {}).sort().map(k => {
      const o = { holdstoerrelse: k, kampe: r.modes[k].n };
      for (const kind of M.KIND_ORDER) if (r.modes[k].kinds[kind]) o[M.kindLabel(kind, false)] = r.modes[k].kinds[kind];
      return o;
    }),
    /* ONLY mature trends, and their numbers are the only trend numbers in the
     * payload at all.
     *
     * Measured 27/7: told that a trend carried "mature": false and that immature
     * trends may not be used as evidence, gpt-oss-20b built the whole narrative
     * on one — a 3v3 boost figure whose "normal" rested on a single match. Every
     * number was real, so grounding passed it, and the paragraph was still
     * false. Flagging did not work; removing does. An immature number that is
     * not in the payload cannot be written, because the validator's allowed set
     * is built from the payload itself.
     *
     * The count of what was withheld stays, so the model can say the true thing
     * ("for tidligt at sige") instead of inventing something to fill the space. */
    /* `direction` must be non-zero as well. Every row here is handed to the
     * model already judged — "værre end hans normal", "lavere tal er bedre" —
     * and a metric with NO direction (time off the ground, speed after
     * conceding) has no such answer to give. Falsy direction would fall to the
     * "lavere tal er bedre" branch below and teach the model a verdict the
     * engine explicitly refuses to make. Today no direction-0 metric can reach
     * this far, because none of them is coachable; this is the guard for the
     * day one of them becomes so. */
    trends: r.trends.filter(x => x.mature && x.goodness !== null && x.direction).map(x => ({
      label: x.label, playlist: x.playlist, kampe: x.n,
      ugeSnit: M.fmt(x.id, x.weekAvg),
      normalVedUgensStart: M.fmt(x.id, x.normStart),
      aendring: x.deltaPct === null ? null : Math.abs(Math.round(x.deltaPct * 100)) + '%',
      // Direction applied by the engine, exactly as for the debrief — the model
      // must never work out which way is up. It got this backwards unaided:
      // "hold boost-niveauet lavere" on a metric where lower time under 15 boost
      // is the GOOD outcome.
      status: x.goodness > 0 ? 'bedre end hans normal' : 'værre end hans normal',
      retning: x.direction > 0 ? 'højere tal er bedre' : 'lavere tal er bedre'
    })),
    trendsIkkeModneEndnu: r.trends.filter(x => !x.mature || x.goodness === null).length,
    /* Counted here so a sentence ABOUT the trends has a source too.
     * Measured: with nine trends listed, seven worse and two better, the model
     * wrote "ingen af dem er bedre end den sædvanlige baseline" — an aggregate
     * claim, made of words rather than figures, so no number-validator can
     * catch it. It cannot be validated after the fact, but it can be made
     * unnecessary: the count it needed is now in the payload. */
    trendOpsamling: {
      bedreEndNormal: r.trends.filter(x => x.mature && x.goodness !== null && x.goodness > 0).length,
      vaerreEndNormal: r.trends.filter(x => x.mature && x.goodness !== null && x.goodness <= 0).length
    },
    /* The proof rows go to the model as COUNTS and one engine-written line —
     * never as (label, verdict) pairs.
     *
     * Two measured failures, same shape. First: given "40% før, 29% efter, dom:
     * ikke målbart" over two matches, the model wrote "så den har ikke
     * forbedret sig" — so the figures behind "ikke målbart" were withheld.
     * Then 17/8 (W33): given eleven rows with labels and verdicts, it folded
     * "touches per minute" (opnået, 5.5 mod ≥ 5.3) and "distance per touch"
     * (ikke målbart) into one sentence with one verdict. Both labels real, one
     * verdict wrong, and no number-validator can see it — the claim is made of
     * words. A validator for it would need every paraphrase of every label
     * ("kickoff‑first touch" for "team first touch on kickoffs") and of every
     * verdict, AND the playlist binding, because the same label carries
     * different verdicts in different playlists. That list falls behind the
     * day it is written.
     *
     * Same lesson as the trends, applied one level up: what cannot be
     * validated is not sent. The model gets how many focuses were judged and
     * how they fell, plus the sentence the engine would write itself. The rows
     * with names are printed under the narrative by the engine, so nothing the
     * player needs is lost — only the model's chance to misattribute it. */
    bevisOpsamling: proofSummary(r.proof),
    fokusNaesteUge: r.focusNext ? { label: r.focusNext.label, playlist: r.focusNext.playlist,
                                    maal: r.focusNext.targetText, hvorfor: r.focusNext.why } : null,
    // names only. The codes are printed by the engine right under the narrative
    traeningsbaner: r.packs.map(p => p.name),
    tilt: { maalIndkasseretFoersteMinut: r.tilt.earlyConceded, scoringerSidsteMinut: r.tilt.lateOwn,
            sessionerMedStopSignal: r.tilt.stops }
  };
}

const WEEKLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['narrativ'], properties: { narrativ: { type: 'string' } }
};

async function speakWeekly(report){
  if (!ready()) return null;
  const q = quota();
  if (q.exhausted){ log('[voice] dagsloft nået — ugerapporten står uden narrativ'); return null; }

  const d = def();
  // A paragraph needs more room than three lines, and a reasoning model spends
  // part of the budget before it starts writing. Raised here rather than in the
  // provider table: it is a property of THIS call, not of the backend.
  const p = Object.assign({}, pcfg(), { maxTokens: 1600 });
  const ep = resolveEndpoint(d, p);
  if (!ep) return null;

  const payload = buildWeeklyPayload(report);
  const userMsg = 'Skriv ugens opsamling til spilleren.\n\n' + JSON.stringify(payload) + '\n\n' + WEEKLY_FORM_RULE;
  const key = capsKey();
  if (!cfg.caps[key]) cfg.caps[key] = {};
  if (d.structured === 'native') cfg.caps[key].responseFormat = 'native';
  else if (!cfg.caps[key].responseFormat) cfg.caps[key].responseFormat = 'json_schema';

  let messages = [{ role: 'user', content: userMsg }];
  for (let attempt = 0; attempt < 2; attempt++){
    const level = cfg.caps[key].responseFormat;
    const body = d.body(p, persona.SYSTEM, userMsg, WEEKLY_SCHEMA, level);
    body.messages = d.structured === 'native'
      ? messages
      : [{ role: 'system', content: persona.SYSTEM }].concat(messages);

    cfg.used++; save();
    const res = await postWithRetry(ep, d.headers(p), body, d.timeout, d.label);
    if (res.error){ cfg.lastError = res.error; save(); log('[voice] uge-kald fejlede: ' + res.error); return null; }
    accountFor(d, d.usage(res.data));

    const parsed = d.read(res.data);
    if (parsed.error){ cfg.lastError = parsed.error; save(); log('[voice] ' + parsed.error); return null; }
    const answer = extractJson(parsed.text);
    const text = answer && typeof answer.narrativ === 'string' ? answer.narrativ : null;
    if (!text){ log('[voice] uge-svaret indeholdt ingen narrativ'); return null; }

    const check = grounding.validateNarrative(text, payload, WEEKLY_MAX_CHARS);
    if (check.ok){
      cfg.lastError = null; save();
      return { text: text.trim(), model: res.data.model || p.model, provider: cfg.provider,
               at: new Date().toISOString(), attempt: attempt + 1 };
    }
    log('[voice] grounding afviste ugens narrativ (forsøg ' + (attempt + 1) + '): ' + check.problems.join('; '));
    if (attempt === 0)
      messages = [{ role: 'user', content: userMsg + '\n\nDIT FORRIGE SVAR BLEV AFVIST:\n- '
        + check.problems.join('\n- ') + '\n\nRet præcis det, og svar igen. Brug KUN tal der står ordret i inputtet.' }];
  }
  log('[voice] ugens narrativ afvist to gange — rapporten står uden');
  return null;
}

function status(){
  if (!cfg) return { ready: false };
  const q = quota(), d = def();
  return { ready: ready(), provider: cfg.provider, providerLabel: d ? d.label : '?',
           model: pcfg().model, used: q.used, limit: q.limit, exhausted: q.exhausted,
           spentUsd: d && d.supportsCache ? cfg.spentUsd : null,
           responseFormat: (cfg.caps[capsKey()] || {}).responseFormat || null,
           lastError: cfg.lastError, notReady: ready() ? null : reasonNotReady() };
}

module.exports = { init, speak, speakWeekly, ready, status, quota, lang,
                   buildPayload, buildWeeklyPayload, compose, extractJson, OUTPUT_SCHEMA };
