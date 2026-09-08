/* RL Director — spillerens tier (8/9-2026).
 *
 * EEN kilde til "hvilket niveau er spilleren paa", saa session.js, weekly.js
 * og radar.js aldrig kan doemme forskelligt. Anledningen var en tester paa
 * Champion 2, der fik Bronze-baner efter sine kampe: banken (packs.js) var
 * kurateret til ejeren (Silver), og radar.js' svaerhedsloft var fast paa
 * "Diamond+ er for svaert". Begge er nu RELATIVE til spillerens tier.
 *
 * Kontrakten:
 *   - tier = rangens navn uden division ('Champion II' -> 'Champion'), fra
 *     spillerens seneste kendte rank pr. playlist. Flere playlister -> den
 *     HOEJESTE kendte tier (traeningsbaner maaler mekanik, og den bedste
 *     liste er taettest paa loftet); ved lighed den med hoejest MMR.
 *   - vinduet er [tier-1, tier+1], klippet til skalaen (Bronze -> Bronze..Silver,
 *     Supersonic Legend -> Grand Champion..Supersonic Legend).
 *   - ukendt rank (ingen opslag, 'Unranked', placeringskampe) -> Silver, ejerens
 *     standard, og begrundelsen SIGER det ("rank ukendt, baner paa Silver-niveau").
 *   - en banes eget niveau er katalogets difficulty (Prejump); Lander-kataloget
 *     har ingen, saa der siger NAVNET det (air dribbles, flip resets, ceiling,
 *     double taps, redirects = Diamond-mekanik uanset rating — heuristikken fra
 *     radar.js 7/9, flyttet hertil). Ukendt niveau er ikke "for svaert" og
 *     heller ikke "for let": en bane uden niveau passer altid (ukendt != svaer).
 *
 * resolve()/fits()/windowOf() er RENE (ingen I/O, intet ur). load() er den
 * eneste der laeser disk: rank-cache.json (boardets egne opslag, ogsaa for
 * gaester — den ligger i EJERENS rod, noeglet paa pid) og rank-history.json
 * (ejerens egen kurve). Nyeste punkt vinder. load() kaster aldrig: en fejl
 * giver standard-tieren med "rank ukendt" i begrundelsen. */
'use strict';

const fs = require('fs');
const path = require('path');

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion', 'Grand Champion', 'Supersonic Legend'];
const DEFAULT_TIER = 'Silver';
const SPAN = 1;                                  // vinduet er tier ± SPAN
const PLAYLIST_OF = { p1: '1v1', p2: '2v2', p3: '3v3' };
const PLAYLISTS = ['1v1', '2v2', '3v3'];

/* 'Champion II' -> 'Champion'; 'Grand Champion I' -> 'Grand Champion';
 * 'Unranked'/'Tier 3'/tom -> null. Store/smaa bogstaver er ligegyldige. */
function tierOf(label){
  const s = String(label || '').trim().replace(/\s+(IV|III|II|I)$/i, '').trim().toLowerCase();
  if (!s) return null;
  const t = TIERS.find(x => x.toLowerCase() === s);
  return t || null;
}
function indexOf(tier){ return TIERS.indexOf(tierOf(tier)); }

/* [tier-1 .. tier+1] i skalaens orden, klippet til enderne. Ukendt tier -> []. */
function windowOf(tier, span){
  const i = indexOf(tier);
  if (i < 0) return [];
  const s = Number.isFinite(span) ? span : SPAN;
  return TIERS.slice(Math.max(0, i - s), Math.min(TIERS.length, i + s + 1));
}

/* Lander1984s katalog baerer ingen difficulty — der siger navnet det: air dribbles,
 * flip resets, ceiling shots, double taps og musty flicks er Diamond-mekanik
 * uanset rating (radar.js 7/9). Bruges kun naar kataloget ikke selv siger et niveau. */
const NAME_DIAMOND = /air ?(&|and|\+)? ?wall|air ?dribbl|flip ?reset|ceiling|double ?tap|musty|kuxir|pinch|redirect/i;

/* Banens eget niveau: katalogets difficulty foerst, ellers navnet, ellers null. */
function packTier(difficulty, name){
  const t = tierOf(difficulty);
  if (t) return t;
  return NAME_DIAMOND.test(String(name || '')) ? 'Diamond' : null;
}

function texts(tier, known, label, playlist){
  const win = windowOf(tier);
  const range = win[0] + '–' + win[win.length - 1];
  const short = { da: 'baner på ' + tier + '-niveau (±1)', en: 'packs at ' + tier + ' level (±1)' };
  const da = known
    ? 'Baner på ' + tier + '-niveau (±1: ' + range + ') — din rank er ' + label + (playlist ? ' i ' + playlist : '') + '.'
    : 'Rank ukendt — baner på ' + tier + '-niveau (±1: ' + range + ').';
  const en = known
    ? 'Packs at ' + tier + ' level (±1: ' + range + ') — your rank is ' + label + (playlist ? ' in ' + playlist : '') + '.'
    : 'Rank unknown — packs at ' + tier + ' level (±1: ' + range + ').';
  return { reason: { da, en }, short };
}

/* Ranks -> tier-info. `ranks` er enten boardets/relaeets form {p1,p2,p3:{label,
 * division,mmr}} eller kurvens {'1v1':{label,mmr},'2v2':...}. Poster uden
 * genkendelig tier (Unranked, null) ignoreres. Svarer altid et komplet objekt:
 *   { known, tier, window, playlist, label, mmr, byPlaylist, source, at, reason:{da,en}, short:{da,en} }
 * known=false -> tier = DEFAULT_TIER og begrundelsen siger "rank ukendt". */
function resolve(ranks, opts){
  const o = opts || {};
  const byPlaylist = {};
  const src = ranks && typeof ranks === 'object' ? ranks : {};
  for (const k of Object.keys(src)){
    const pl = PLAYLIST_OF[k] || (PLAYLISTS.includes(k) ? k : null);
    if (!pl) continue;
    const r = src[k];
    if (!r || typeof r !== 'object') continue;
    const t = tierOf(r.label);
    if (!t) continue;
    byPlaylist[pl] = { tier: t, label: String(r.label), mmr: Number.isFinite(Number(r.mmr)) ? Number(r.mmr) : null,
                       division: Number.isFinite(Number(r.division)) ? Number(r.division) : null };
  }
  let best = null;
  for (const pl of PLAYLISTS){
    const b = byPlaylist[pl];
    if (!b) continue;
    if (!best || indexOf(b.tier) > indexOf(best.tier) || (indexOf(b.tier) === indexOf(best.tier) && (b.mmr || 0) > (best.mmr || 0)))
      best = Object.assign({ playlist: pl }, b);
  }
  if (!best){
    const t = texts(DEFAULT_TIER, false, null, null);
    return { known: false, tier: DEFAULT_TIER, window: windowOf(DEFAULT_TIER), playlist: null, label: null, mmr: null,
             byPlaylist, source: o.source || null, at: o.at || null, reason: t.reason, short: t.short };
  }
  const t = texts(best.tier, true, best.label, best.playlist);
  return { known: true, tier: best.tier, window: windowOf(best.tier), playlist: best.playlist, label: best.label, mmr: best.mmr,
           byPlaylist, source: o.source || null, at: o.at || null, reason: t.reason, short: t.short };
}

/* Standard-infoen (Silver, ukendt) — til kaldere uden spillerdata (tests, replay). */
const DEFAULT_INFO = Object.freeze(resolve(null));

function infoOf(x){ return x && Array.isArray(x.window) && x.window.length ? x : DEFAULT_INFO; }

/* Passer en bane med dette katalog-niveau/navn i spillerens vindue?
 * Ukendt niveau (null difficulty og intet i navnet) passer altid. */
function fits(info, difficulty, name){
  const t = packTier(difficulty, name);
  if (!t) return true;
  return infoOf(info).window.includes(t);
}

/* Passer en bank-post med et deklareret `tiers`-felt (liste af tier-navne)?
 * Tom/manglende liste -> som fits() paa navnet alene. */
function fitsTiers(info, tiers, name){
  if (!Array.isArray(tiers) || !tiers.length) return fits(info, null, name);
  const win = infoOf(info).window;
  return tiers.some(t => win.includes(tierOf(t)));
}

/* ---------------- disk (den eneste I/O) ----------------
 * rank-cache.json: {players:{pid:{t:ms, data:{p1,p2,p3}}}} — boardets egne
 * opslag, ogsaa for gaester (filen ligger i EJERENS rod). rank-history.json:
 * {points:[{at:iso, playlists:{'1v1':{label,mmr}}}]} — ejerens kurve; kun med
 * naar kalderen siger history:true (en gaest har ingen kurve). Nyeste vinder. */
function readJSON(p){ try{ return JSON.parse(fs.readFileSync(p, 'utf8')); }catch{ return null; } }

function load(root, pid, opts){
  const o = opts || {};
  const cands = [];
  try{
    if (root && pid){
      const rc = readJSON(path.join(root, 'rank-cache.json'));
      const e = rc && rc.players && Object.prototype.hasOwnProperty.call(rc.players, pid) ? rc.players[pid] : null;
      if (e && e.data && typeof e.data === 'object'){
        const at = Number.isFinite(Number(e.t)) ? new Date(Number(e.t)).toISOString() : null;
        cands.push({ ranks: e.data, at, source: 'rank-cache' });
      }
    }
    if (root && o.history){
      const rh = readJSON(path.join(root, 'rank-history.json'));
      const last = rh && Array.isArray(rh.points) && rh.points.length ? rh.points[rh.points.length - 1] : null;
      if (last && last.playlists) cands.push({ ranks: last.playlists, at: last.at || null, source: 'rank-history' });
    }
  }catch{ /* en laesefejl maa aldrig koste rapporten: standard-tieren tager over */ }
  const known = cands.map(c => Object.assign({ info: resolve(c.ranks, { source: c.source, at: c.at }) }, c)).filter(c => c.info.known);
  if (!known.length) return resolve(null, { source: cands.length ? cands[0].source : null });
  known.sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0));
  return known[0].info;
}

module.exports = { TIERS, DEFAULT_TIER, SPAN, DEFAULT_INFO, NAME_DIAMOND, tierOf, indexOf, windowOf, packTier, resolve, fits, fitsTiers, load };
