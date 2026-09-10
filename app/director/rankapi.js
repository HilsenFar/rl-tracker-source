/* RL Director — rank lookup (RapidAPI "rocket-league10", api.tonykun.fr).
 *
 * One provider, two callers: the server's /api/playerranks (opponent chips on
 * the board) and rank-snapshot.js (the tracked player's own MMR point for the
 * weekly curve). Until 18/8-2026 both carried their own copy of the URL and
 * their own normaliser, so a provider swap meant fixing the same thing twice —
 * and when the rocket-league1 subscription was cancelled, only the server was
 * told. Everything provider-shaped now lives here.
 *
 * The swap changed the lookup KEY. rocket-league1 took the platform account id
 * straight out of the feed's PrimaryId; this one takes platform + DISPLAY NAME
 * (/stats/epic/DXX%C3%98). Steam is the exception — the id64 IS its public
 * identity — so target() decides per platform. The five slugs are the API's
 * own, verified from its 400 body: epic, steam, playstation, xbox, switch.
 * Nintendo included, which the 16/8 note assumed impossible.
 *
 * Quota is the binding constraint: the free plan allows 10 lookups per DAY and
 * a 3v3 lobby holds six players. So (a) never spend a call we can predict will
 * fail — an Unknown|0|0 pid has no platform and no name to look up — and (b)
 * believe the provider over ourselves: every response carries
 * x-ratelimit-requests-remaining, which survives restarts, the RapidAPI web
 * console and any other machine sharing the key. Callers sync to it.
 */
'use strict';

const HOST = 'rocket-league10.p.rapidapi.com';
const DAILY_LIMIT = Number(process.env.RANK_DAILY_LIMIT) || 10;

/* PrimaryId prefix (from the game's own feed) -> the API's platform slug.
 * PS5/XboxSeries are guesses at what a future feed might call them; an
 * unmapped prefix costs nothing, it just means no lookup is attempted. */
const PLATFORM = {
  Epic: 'epic', Steam: 'steam',
  PS4: 'playstation', PS5: 'playstation', PSN: 'playstation', Playstation: 'playstation',
  XboxOne: 'xbox', Xbox: 'xbox', XboxSeries: 'xbox',
  Switch: 'switch', Nintendo: 'switch'
};

/* What to put in the URL for this player, or null when no call can succeed.
 * Steam publishes profiles under the id64 we already hold; every other
 * platform is keyed by the display name the feed gives us. A renamed player
 * is a different lookup — callers store the ident with the cache entry so a
 * name change re-opens the question instead of serving a stale miss forever. */
function target(pid, name){
  const [prefix, id] = String(pid || '').split('|');
  const platform = PLATFORM[prefix] || null;
  if (!platform) return null;
  const ident = platform === 'steam' ? (id || name) : name;
  if (!ident || !String(ident).trim()) return null;
  return { platform, ident: String(ident).trim() };
}

/* "Division II" -> 2. The old provider sent bare numbers, this one spells them
 * in Roman numerals inside a word, and Number('Division II') is NaN. */
const ROMAN = { I: 1, II: 2, III: 3, IV: 4 };
function divisionOf(v){
  const s = String(v ?? '').trim();
  if (!s) return null;
  const roman = s.match(/\b(IV|III|II|I)\b/);
  if (roman) return ROMAN[roman[1]];
  return Number(s.replace(/\D/g, '')) || null;
}

/* playlistId is the provider's stable key; the printed name is the fallback
 * for anything it stops sending. 10/11/13 are the three ranked playlists the
 * board draws chips for — Hoops, Rumble, Dropshot, Snowday and Quads arrive
 * under "additional" and are deliberately dropped: they are not the ladder. */
const PLAYLIST_KEY = { 10: 'p1', 11: 'p2', 13: 'p3' };
function keyOf(it){
  const byId = PLAYLIST_KEY[Number(it.playlistId)];
  if (byId) return byId;
  const pl = String(it.playlistName ?? it.playlist ?? it.name ?? it.mode ?? '');
  return /duel|1v1/i.test(pl) ? 'p1' : /doubles|2v2/i.test(pl) ? 'p2'
    : /standard|3v3/i.test(pl) ? 'p3' : null;
}

/* -> { p1, p2, p3, lifetime?, username? } or null when the shape is foreign.
 * p1/p2/p3 keep the {label, division, mmr} contract the board and weekly.js
 * were written against; peak/matches/lifetime ride along because a lookup
 * costs a tenth of a day and this data is free once we have paid for it. */
function normalize(j){
  if (!j || typeof j !== 'object') return null;
  const items = Array.isArray(j) ? j
    : [].concat(j.ranked || [], j.ranks || j.playlists || j.data || []);
  const out = {};
  for (const it of items){
    if (!it || typeof it !== 'object') continue;
    const key = keyOf(it);
    if (!key) continue;
    const label = typeof it.rank === 'string' ? it.rank
      : (it.rank && it.rank.name) || it.tier || null;
    const mmr = Number(it.rating ?? it.mmr) || null;
    if (!label && !mmr) continue;
    out[key] = {
      label, division: divisionOf(it.division ?? it.div), mmr,
      peak: Number(it.peakRating) || null,
      matches: Number.isFinite(Number(it.matchesPlayed)) ? Number(it.matchesPlayed) : null
    };
  }
  if (!Object.keys(out).length) return null;
  if (j.username) out.username = j.username;
  const lt = j.lifetime;
  if (lt && typeof lt === 'object'){
    out.lifetime = { wins: lt.wins ?? null, goals: lt.goals ?? null, saves: lt.saves ?? null,
      assists: lt.assists ?? null, shots: lt.shots ?? null, mvps: lt.mvps ?? null };
  }
  return out;
}

/* One upstream call. Returns what the caller needs in order to decide how long
 * to remember the answer:
 *   data       normalised ranks, or null
 *   status     HTTP status (404 = the provider has never seen this player)
 *   retryable  a hiccup worth asking about again soon, vs a settled "no"
 *   remaining  the provider's own count of calls left today, or null
 * season is optional (the API's /stats/:platform/:username/:season form). */
async function fetchRank({ pid, name, key, season, log }){
  const t = target(pid, name);
  if (!t) return { data: null, status: 0, retryable: false, skipped: true, remaining: null };
  const url = 'https://' + HOST + '/stats/' + t.platform + '/' + encodeURIComponent(t.ident)
    + (season ? '/' + encodeURIComponent(season) : '');
  const say = log || (() => {});
  try{
    const r = await fetch(url, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': HOST,
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/json',
        'User-Agent': 'GitatoRLTracker/1.0'
      }
    });
    /* Number(null) is 0, and a missing header read as "0 left" would convince
     * the caller its quota was spent and stop lookups for the rest of the day.
     * No header means no information, which is not the same as no quota. */
    const raw = r.headers.get('x-ratelimit-requests-remaining');
    const left = (raw === null || raw === '' || !Number.isFinite(Number(raw))) ? null : Number(raw);
    if (!r.ok){
      // 404 is an answer, not a failure: this player is not in the provider's
      // database, and asking again tomorrow costs a tenth of the day's quota.
      say('[rankapi] ' + t.platform + '/' + t.ident + ' HTTP ' + r.status
        + (left === null ? '' : ' (kvote ' + left + ' tilbage)'));
      return { data: null, status: r.status, retryable: r.status >= 500, remaining: left, ident: t.ident };
    }
    const j = await r.json();
    const data = normalize(j);
    if (!data) say('[rankapi] ukendt svarform: ' + JSON.stringify(j).slice(0, 300));
    return { data, status: 200, retryable: false, remaining: left, ident: t.ident };
  }catch(e){
    say('[rankapi] ' + t.platform + '/' + t.ident + ' ' + String(e.message || e));
    return { data: null, status: 0, retryable: true, remaining: null, ident: t.ident };
  }
}

module.exports = { HOST, DAILY_LIMIT, PLATFORM, target, normalize, divisionOf, fetchRank };
