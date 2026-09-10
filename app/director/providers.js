/* RL Director — M3 provider table.
 *
 * One place that knows how each backend differs. voice.js orchestrates
 * (budget, retry, grounding); this file only translates a request and reads a
 * response. Adding a backend should mean adding a row here and nothing else.
 *
 * Everything below was verified against primary documentation or measured on
 * the user's own machine (2026-07-27) — the notes say which, because several
 * of these details fail SILENTLY when wrong:
 *
 *  - NVIDIA's temperature range is 0-1, not OpenAI's 0-2.
 *  - Ollama's /v1 endpoint takes no auth header and, on an 8 GB card, silently
 *    truncates a long system prompt to whatever its VRAM-derived context
 *    allows (measured: 6268 tokens in, 2051 accepted, HTTP 200, no warning —
 *    the model then answered in English and ignored the persona rules).
 *  - Structured output is NOT documented on NVIDIA's hosted endpoint, so the
 *    caller must be prepared to fall back to prompt-only JSON.
 */
'use strict';

/* Shared OpenAI-compatible chat body. `level` is the structured-output
 * capability currently believed for this provider+model (see voice.js's
 * degradation ladder): 'json_schema' | 'json_object' | 'none'. */
function openaiBody(p, system, user, schema, level){
  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_tokens: p.maxTokens || 500,
    temperature: 0.4,        // NIM accepts 0-1 (NOT OpenAI's 0-2)
    top_p: 0.9,
    stream: false
  };
  if (level === 'json_schema')
    body.response_format = { type: 'json_schema', json_schema: { name: 'rl_debrief', schema, strict: true } };
  else if (level === 'json_object')
    body.response_format = { type: 'json_object' };
  // Per-model knobs from director-ai.json, merged last. Needed because
  // reasoning models spend the token budget thinking: measured on
  // openai/gpt-oss-20b, "reasoning_effort":"low" cut reasoning from 89 to 22
  // tokens, and llama-3.3-nemotron-super burned all 200 on thought and
  // returned finish_reason "length" with an empty content field. Keeping this
  // as config rather than code means a new model's quirk needs no rebuild.
  if (p.extraBody && typeof p.extraBody === 'object') Object.assign(body, p.extraBody);
  return body;
}

/* choices[0].message.content, with the honest failure cases named.
 * finish_reason 'length' means the JSON was cut off mid-object — reported as
 * an error rather than handed to a parser that might "repair" it into
 * something that smuggles an ungrounded number past the validator. */
function openaiRead(data){
  const ch = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!ch) return { error: 'svar uden choices' };
  if (ch.finish_reason === 'length') return { error: 'svaret blev afskåret (max_tokens ramt)' };
  const msg = ch.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (!text.trim())
    return { error: 'tomt indhold (finish_reason ' + ch.finish_reason + ')' };
  return { text };
}

/* usage is named differently everywhere; normalise to one shape. */
function openaiUsage(data){
  const u = (data && data.usage) || {};
  return { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0,
           cacheRead: 0, cacheWrite: 0 };
}

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    secure: true, host: 'api.anthropic.com', path: '/v1/messages',
    timeout: 12000,
    needsKey: true,
    supportsCache: true,          // the only backend with prompt caching
    structured: 'native',         // never degrades — output_config is documented
    defaultModel: 'claude-haiku-4-5',
    priceIn: 1.0, priceOut: 5.0,  // $/MTok, Haiku 4.5
    headers: p => ({ 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }),
    body(p, system, user, schema){
      return {
        model: p.model,
        max_tokens: p.maxTokens || 500,
        // 1h TTL: matches are 7-9 minutes apart, so the 5-minute default would
        // expire between every pair and each call would pay the write premium.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema } }
      };
    },
    read(data){
      if (!data || !Array.isArray(data.content)) return { error: 'svar uden content' };
      if (data.stop_reason === 'refusal') return { error: 'modellen afviste forespørgslen' };
      const text = data.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
      if (!text.trim()) return { error: 'tomt tekstsvar (stop_reason ' + data.stop_reason + ')' };
      return { text };
    },
    usage(data){
      const u = (data && data.usage) || {};
      return { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0,
               cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
    }
  },

  nvidia: {
    label: 'NVIDIA NIM',
    secure: true, host: 'integrate.api.nvidia.com', path: '/v1/chat/completions',
    // Measured on the free tier 2026-07-27: a 31B model answered in 12.7s once
    // and exceeded 25s twice. Latency varies with shared-capacity load, not
    // with our request. The debrief is asynchronous — the template is already
    // on screen — so waiting is cheap and giving up is not.
    timeout: 60000,
    needsKey: true,
    supportsCache: false,
    // Neither response_format nor nvext.guided_json appears in the Body Params
    // of NIM's hosted model references (guided_json is documented for
    // SELF-HOSTED containers only). So we probe and degrade rather than assume.
    structured: 'probe',
    defaultModel: 'google/gemma-3-27b-it',   // widest documented multilingual claim (140+ languages)
    headers: p => ({ authorization: 'Bearer ' + p.key, accept: 'application/json' }),
    body: openaiBody, read: openaiRead, usage: openaiUsage
  },

  ollama: {
    label: 'Ollama (lokal)',
    secure: false, host: '127.0.0.1', port: 11434, path: '/v1/chat/completions',
    // Measured cold start on the user's RTX 4060 Laptop: 22.6s. A 12s timeout
    // would kill every first call of a session.
    timeout: 60000,
    needsKey: false,              // measured: HTTP 200 with no Authorization header
    supportsCache: false,
    structured: 'probe',          // json_schema measured working; still probed for other builds
    defaultModel: 'gemma3:12b',
    headers: () => ({}),
    body: openaiBody, read: openaiRead, usage: openaiUsage,
    // Surfaced by voice.js on first use: the /v1 endpoint has no num_ctx field,
    // so a long system prompt is silently truncated to the VRAM-derived
    // context. Fixing it needs a derived model (Modelfile: PARAMETER num_ctx 8192).
    warn: 'Ollamas /v1-endpoint afkorter lange systemprompter stille. '
        + 'Lav en afledt model med "PARAMETER num_ctx 8192" hvis debriefs kommer på engelsk.'
  },

  custom: {
    label: 'Egen OpenAI-kompatibel',
    fromBaseUrl: true,            // host/path/secure resolved from providers.custom.baseUrl
    timeout: 30000,
    needsKey: false,
    supportsCache: false,
    structured: 'probe',
    defaultModel: '',
    headers: p => (p.key ? { authorization: 'Bearer ' + p.key } : {}),
    body: openaiBody, read: openaiRead, usage: openaiUsage
  }
};

/* Resolve a custom provider's endpoint from its baseUrl once, so the request
 * path doesn't re-parse a URL on every call. */
function resolveEndpoint(def, p){
  if (!def.fromBaseUrl) return { secure: def.secure, host: def.host, port: def.port, path: def.path };
  const raw = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let u;
  try{ u = new URL(raw); }catch{ return null; }
  return {
    secure: u.protocol === 'https:',
    host: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: (u.pathname === '/' ? '' : u.pathname) + '/chat/completions'
  };
}

module.exports = { PROVIDERS, resolveEndpoint };
