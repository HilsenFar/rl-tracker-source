/* RL Director — event-radar: banetryk over alle digests (26/8, flyttet fra
 * server.js 3/9-2026).
 *
 * Laeser matches/*.json og bygger banetryk langs laengdeaksen: ejerens egne
 * beroeringer, medspilleres og modstanderes, hver i 44 buckets over
 * [-5500, 5500] uu (banen er ±5120, resten er maalzonen). Kampene vendes saa
 * ejerens forsvar ALTID ligger i minus-enden — på tvaers af hold-tildeling.
 * Ejeren = director.getTracked() (pid foerst, navn som fallback); kampe hvor
 * ejeren ikke er på banen (gaester m.v.) taelles ikke med.
 *
 * Hvorfor per-fil-cache (3/9): den gamle cache var (antal filer + nyeste
 * filnavn) → EN ny kamp gjorde det foerste /api/pitch-kald til en fuld
 * genlaesning af hele arkivet (600+ filer, 0,7-1,3 s maalt) i HTTP-handleren,
 * dvs. paa hovedtraaden lige efter kampafslutning. Nu huskes hvert enkelt
 * digests BIDRAG (contribution), og kun nye filer laeses; foldningen af
 * bidragene er billig. Kampfiler skrives een gang (atomisk rename) og aendres
 * aldrig, saa filnavnet er en tilstraekkelig noegle. Bidraget afhaenger af
 * ejeren, saa et ejerskifte (gaestetilstand) toemmer cachen.
 *
 * Kontrakt: fold(contributions) for ALLE filer giver praecis det samme som
 * den gamle fulde genlaesning — dots-loftet paalaegges i filorden ved
 * foldning, aldrig pr. fil. director/test/pitch.test.js beviser lighed
 * mellem inkrementel opbygning, fuld opbygning og den gamle algoritme paa
 * det eksisterende arkiv. */
'use strict';
const fs = require('fs');
const path = require('path');

const PITCH_BUCKETS = 44, PITCH_SPAN = 5500, PITCH_DOTS_MAX = 4000;

const mk = () => new Array(PITCH_BUCKETS).fill(0);
const mk6 = () => [mk(), mk(), mk(), mk(), mk(), mk()];   // kampens 5 minutter + (OT blandes i minut 5)
const bucket = y => Math.max(0, Math.min(PITCH_BUCKETS - 1,
  Math.floor((y + PITCH_SPAN) / (2 * PITCH_SPAN) * PITCH_BUCKETS)));
/* Kampuret taeller NED fra 300; minut-indeks 0-4 = kampens 1.-5. minut.
 * t null, uden for ]0,300] ELLER praecis 0 kan ikke minut-placeres og
 * taeller kun i totalen: private lobbyer uden ur-feed stempler ALT t=0
 * (maalt 26/8: 10.088 hits i 7 filer — de druknede minut 5). Prisen er
 * de faa aegte buzzer-beroeringer. OT kan feedet ikke skelne fra minut 5. */
const minuteOf = t => typeof t === 'number' && t > 0 && t <= 300
  ? Math.min(4, Math.floor((300 - t) / 60)) : -1;

function emptyAggregate(){
  return { matches: 0, touches: 0, withX: 0, dotsDropped: 0,
           mine: mk(), mates: mk(), opps: mk(),
           layers: { mine: mk6(), mates: mk6(), opps: mk6() },
           goalsFor: 0, goalsAgainst: 0, dots: [],
           /* Skudsteder (26/8): scorerens sidste beroering foer maalet
            * (samme kampur, hoejst 10 s foer). [x|null, y, minut] —
            * scoredFrom = mine maal, concededFrom = modstandernes. */
           scoredFrom: [], concededFrom: [] };
}

/* Eet digests bidrag til aggregatet, eller null naar kampen ikke taeller.
 * Rent: ingen I/O. `dots` er UDEN loft her — loftet haandhaeves i fold(). */
function contribution(d, owner){
  if (!d || typeof d !== 'object') return null;
  const myPid = (owner && owner.pid) || '', myName = (owner && owner.name) || '';
  /* Kun rigtige kampe paa banekortet: offline (freeplay/traeningsbaner) er
   * 76 solo-filer/19.087 hits der alle ligger i angrebszonen og baerer
   * pakke-timere i stedet for kampur (maalt 26/8). Samme graense som
   * motorens baselines. Casual/turnering/privat-online taeller med. */
  if (d.mode !== 'online') return null;
  const hits = d.hitEvents || [];
  if (!hits.length) return null;
  const me = (d.players || []).find(p =>
    (myPid && p.pid === myPid) || (myName && p.name === myName));
  if (!me) return null;
  const flip = me.team === 1 ? -1 : 1;   // hold 0 forsvarer minus-y i feedet
  const c = { touches: 0, withX: 0, mine: mk(), mates: mk(), opps: mk(),
              layers: { mine: mk6(), mates: mk6(), opps: mk6() },
              goalsFor: 0, goalsAgainst: 0, dots: [], scoredFrom: [], concededFrom: [] };
  for (const e of hits){
    if (typeof e.y !== 'number') continue;
    c.touches++;
    const who = e.name === me.name ? 'mine' : e.team === me.team ? 'mates' : 'opps';
    const b = bucket(e.y * flip), min = minuteOf(e.t);
    c[who][b]++;
    if (min >= 0) c.layers[who][min][b]++;
    if (typeof e.x === 'number'){
      c.withX++;
      c.dots.push([Math.round(e.x * flip), Math.round(e.y * flip),
                   who === 'mine' ? 0 : who === 'mates' ? 1 : 2, min]);
    }
  }
  for (const g of (d.goals || [])){
    g.team === me.team ? c.goalsFor++ : c.goalsAgainst++;
    /* Skudstedet: scorerens sidste beroering foer maalet. Uret taeller ned,
     * saa beroeringen FOER maalet har hoejere t; naermeste inden for 10 s.
     * Findes ingen (OT/ur-huller), udelades maalet aerligt. Kun mine egne
     * maal og modstandernes — medspilleres er ikke efterspurgt. */
    if (typeof g.clock !== 'number' || !g.scorer) continue;
    const isMine = g.scorer === me.name && g.team === me.team;
    const isOpp = g.team !== me.team;
    if (!isMine && !isOpp) continue;
    let best = null;
    for (const e of hits){
      if (e.name !== g.scorer || typeof e.t !== 'number') continue;
      const dt = e.t - g.clock;
      if (dt >= 0 && dt <= 10 && (!best || e.t < best.t)) best = e;
    }
    if (!best || typeof best.y !== 'number') continue;
    (isMine ? c.scoredFrom : c.concededFrom).push([
      typeof best.x === 'number' ? Math.round(best.x * flip) : null,
      Math.round(best.y * flip), minuteOf(best.t)]);
  }
  return c;
}

/* Fold bidrag (i filorden) til det aggregat siden tegner fra. Dots-loftet
 * paalaegges her, i samme orden som den gamle fulde genlaesning. */
function fold(contribs){
  const out = emptyAggregate();
  for (const c of contribs){
    if (!c) continue;
    out.matches++;
    out.touches += c.touches; out.withX += c.withX;
    out.goalsFor += c.goalsFor; out.goalsAgainst += c.goalsAgainst;
    for (const who of ['mine', 'mates', 'opps']){
      const dst = out[who], src = c[who];
      for (let b = 0; b < PITCH_BUCKETS; b++) dst[b] += src[b];
      for (let m = 0; m < 6; m++){
        const dl = out.layers[who][m], sl = c.layers[who][m];
        for (let b = 0; b < PITCH_BUCKETS; b++) dl[b] += sl[b];
      }
    }
    for (const dot of c.dots){
      if (out.dots.length < PITCH_DOTS_MAX) out.dots.push(dot);
      else out.dotsDropped++;
    }
    for (const s of c.scoredFrom) out.scoredFrom.push(s);
    for (const s of c.concededFrom) out.concededFrom.push(s);
  }
  return out;
}

function listFiles(dir){
  try{ return fs.readdirSync(dir).filter(f => /^\d{4}-/.test(f) && f.endsWith('.json')).sort(); }
  catch{ return []; }
}
function readDigest(dir, f){
  try{ return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }catch{ return undefined; }
}

/* Fold de givne filer med en genbrugelig bidrags-cache (filnavn -> bidrag).
 * Kun filer der ikke staar i cachen laeses. En ulaeselig fil caches IKKE
 * (den kan vaere paa vej ind), saa den proeves igen naeste gang — praecis som
 * den gamle genlaesning sprang den over. */
function foldFiles(dir, files, owner, cache){
  const contribs = [];
  for (const f of files){
    if (!cache.has(f)){
      const d = readDigest(dir, f);
      if (d === undefined) continue;
      cache.set(f, contribution(d, owner));
    }
    contribs.push(cache.get(f));
  }
  return fold(contribs);
}

/* ---- server-siden: eet aggregat pr. (arkiv, ejer), inkrementelt ---- */
let cache = null;   // { dir, ownerKey, key, data, files: Map }
function aggregate(dir, owner){
  const files = listFiles(dir);
  const key = files.length + ':' + (files[files.length - 1] || '');
  const ownerKey = ((owner && owner.pid) || '') + '|' + ((owner && owner.name) || '');
  if (cache && cache.dir === dir && cache.ownerKey === ownerKey && cache.key === key) return cache.data;
  // bidragene afhaenger af hvem ejeren er: nyt arkiv eller ny ejer = ny cache
  const files_ = cache && cache.dir === dir && cache.ownerKey === ownerKey ? cache.files : new Map();
  const live = new Set(files);
  for (const f of [...files_.keys()]) if (!live.has(f)) files_.delete(f);
  const data = foldFiles(dir, files, owner, files_);
  cache = { dir, ownerKey, key, data, files: files_ };
  return data;
}
function reset(){ cache = null; }

module.exports = { aggregate, reset, contribution, fold, foldFiles, listFiles, emptyAggregate,
                   PITCH_BUCKETS, PITCH_SPAN, PITCH_DOTS_MAX };
