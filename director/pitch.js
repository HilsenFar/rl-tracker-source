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
 * det eksisterende arkiv.
 *
 * Baneradar (6/9, RADAR-DESIGN.md §0+§2): skudstederne binder nu til
 * scorerens SIDSTE beroering paa vaegur — den gamle "laveste t"-regel valgte
 * kickoff-beroeringen EFTER maalet (uret staar stille gennem replay +
 * nedtaelling, saa den har praecis t == clock) i 49 % af uge 36's
 * indkasseringer. Posterne er udvidet til [x, y, minut, z, day, ko], egne
 * beroeringer taelles pr. angrebszone (mineZones), private lobbyer og
 * mutator-kampe holdes ude af radar-felterne (aldrig af tegningen), og
 * ubundne maal taelles i stedet for at gaettes. Tegningens felter
 * (mine/mates/opps/layers/dots) er uaendrede, byte for byte.
 *
 * Maal uden for banen (8/9, tester-feedback 7/9): tre ting maalt paa arkivet.
 *  - Ingen standard-arena (ca. 600 kampe, 45 arenaer) har en beroering med
 *    |x| > 4064 eller mere end EEN med |y| > 5300 pr. kamp. Labs_4v4_Arena15_*
 *    (4v4), Labs_Galleon_Mast_P, Labs_PillarWings_P og ShatterShot_P har
 *    beroeringer jaevnt fordelt op til |y| 6028 og |x| 4976 uden kobling til
 *    maal-ure: de baner er STOERRE end standardbanen, og et skudsted derfra kan
 *    ikke laegges paa standard-tegningen. Saadanne kampe holdes ude af
 *    radar-felterne som private og mutator-kampe og taelles i excluded.arena
 *    (arenaFits: navn ELLER geometri, saa en ukendt bane fanges ogsaa).
 *  - En beroering med |y| > NET_Y (5300) paa en standard-arena er bolden i
 *    nettet EFTER maalet (bolden er talt ved 5213 = 5120 + radius): aldrig et
 *    skudsted. bindGoal springer den over, saa scorerens forrige beroering i
 *    vinduet vinder — eller maalet er ubundet.
 *  - 5120 < |y| <= 5300 er bolden paa stregen (16 af 2058 maal i arkivet, alle
 *    5121-5276): et aegte sidste touch, som siden tegner INDE i maalet. */
'use strict';
const fs = require('fs');
const path = require('path');
const radar = require('./radar');
const M = require('./metrics');

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
/* OT-maal faar minut-indeks 4: feedet kan ikke skelne OT fra kampens 5.
 * minut (se minuteOf), og lagene laegger OT-beroeringer samme sted. */
const OT_MINUTE = 4;
const BIND_WINDOW_S = 10;      // skudsted = scorerens beroering hoejst 10 s foer maalet
const KICKOFF_GAP_S = 5;       // >= 5 s stilhed paa vaegur foer en t==clock-beroering = kickoffet efter maalet
const OT_TURN_MAX_PREV = 10;   // OT taeller op fra 0: en stigning fra t > 10 er aldrig OT-starten (alle 63 OT-kampe i arkivet: prev = 0)
/* Banens geometri (8/9). GOAL_Y = maallinjen (RLBot: ±5120); NET_Y = dybere end
 * ~2 boldradier bag stregen — bolden er talt som maal ved 5213, saa en beroering
 * dybere end 5300 sker EFTER maalet (nettet gaar til 6000); WALL_X = sidevaeggen.
 * Maalt paa arkivet: standard-arenaer topper i 5376 (een beroering) og 4064. */
const GOAL_Y = 5120;
const NET_Y = 5300;
const WALL_X = 4096;
const ARENA_NET_MIN = 3;       // >= 3 net-beroeringer i EEN kamp = en laengere bane (standard: hoejst 1 pr. kamp)
/* Baner med en anden geometri end standardbanen, paa navn: Rocket Labs
 * (Labs_ — herunder 4v4's Labs_4v4_Arena15_) og ShatterShot_P (|x| til 4976
 * i arkivet). Geometrien i arenaFits fanger dem ogsaa uden navn. */
const ARENA_OTHER = /^(Labs_|ShatterShot_P$)/i;

/* Spilledoegn 06:00 -> 06:00 lokal, samme regel som weekly.playDay (og
 * form.js). Kopieret frem for at traekke hele weekly.js (rapporter, stemme,
 * persona) ind i banekortet; pitch.test.js pinner ligheden med weekly. */
const DAY_START_HOUR = 6;
const p2 = n => String(n).padStart(2, '0');
function playDay(iso){
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - DAY_START_HOUR * 3600e3);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
const zoneCounts = () => ({ O1: 0, O2: 0, O3: 0, O4: 0, O5: 0, O6: 0 });

function emptyAggregate(){
  return { matches: 0, touches: 0, withX: 0, dotsDropped: 0,
           mine: mk(), mates: mk(), opps: mk(),
           layers: { mine: mk6(), mates: mk6(), opps: mk6() },
           goalsFor: 0, goalsAgainst: 0, dots: [],
           /* Skudsteder (26/8, udvidet 6/9): scorerens sidste beroering
            * foer maalet, hoejst 10 s foer. [x|null, y, minut, z|null, day, ko]
            * — siden laeser kun [0..2]. scoredFrom = mine maal, concededFrom =
            * modstandernes. mineZones = ejerens beroeringer med x pr. O-zone;
            * excluded = kampe holdt ude af radar-felterne (privat/mutator);
            * unbound = mine/deres maal der ikke kunne stedfaestes. */
           scoredFrom: [], concededFrom: [],
           mineZones: zoneCounts(), excluded: { private: 0, mutators: 0, arena: 0 }, unbound: 0 };
}

/* Kampens kickoff: indekset paa den FOERSTE beroering med kampens hoejeste t.
 * Alt foer det er forrige kamps hale: feedet kobler paa under dens slutning,
 * saa de foerste hitEvents baerer dens ur (fx 133..129, saa denne kamps 300)
 * — 5 kampe i arkivet 6/9 + fixture 16-27-14. Uden hale er svaret 0.
 * Null-stemplede beroeringer taeller ikke; ingen numerisk t = 0.
 * Kendt restrisiko (verifikation 7/9, ikke set i arkivet): en kamp joinet
 * UNDERVEJS (foerste egne beroering ved t < 300) efter en stale hale med
 * hoejere t ville lade halen ligge i `live`. Alle 5 hale-kampe i arkivet
 * starter ved 300; falder det, er svaret at kraeve et vaegur-spring (w)
 * mellem hale og kamp — ikke gaettet nu. */
function liveFrom(hits){
  let peak = -1;
  for (let i = 0; i < hits.length; i++){
    const t = hits[i].t;
    if (typeof t === 'number' && (peak < 0 || t > hits[peak].t)) peak = i;
  }
  return peak < 0 ? 0 : peak;
}

/* Vendepunktet: OT-uret taeller OP fra 0 efter ordinaer tid har talt NED til
 * 0, saa en stigning i t er starten paa OT. Samme ide som metrics.curveIndexAt,
 * men over hitEvents. Tre vaern, alle maalt paa arkivet 6/9 (436 online-kampe,
 * 63 med OT):
 *  - kun stigninger EFTER kampens kickoff (liveFrom): den naive "foerste
 *    stigning" fyrede paa forrige kamps hale (129 -> 300) og gjorde hele den
 *    ordinaere tid ubundet — 7 af 7 maal i 2026-08-03T11-16-15, skjult af
 *    mutator-vagten indtil verifikationen fjernede boost-dataene.
 *  - stigningen skal komme fra t <= OT_TURN_MAX_PREV: OT starter ved 0, saa
 *    129 -> 300 er aldrig OT (alle 63 OT-kampe: prev = 0).
 *  - OT-halvdelen starter ved OT-KICKOFFET, ikke ved stigningen: kickoffet er
 *    selv t = 0 (samme som ordinaer tids sidste sekund) og laa derfor FOER
 *    vendepunktet, saa et OT-maal scoret direkte af kickoffets foersteberoerer
 *    var ubundet (2026-08-17T11-48-25). Gaa tilbage over t == 0-beroeringerne
 *    til den foerste hvor vaeguret gik >= KICKOFF_GAP_S mere end kampuret
 *    (replay + nedtaelling: uret frosset) — det er kickoffet i 61 af 61
 *    OT-kampe med beroeringer i OT, og spilleren er kickoffs[].firstTouch i
 *    alle 61. En buzzer-beroering ved 0 efter 10 s vaegur og 8 s kampur er
 *    levende spil, ikke et kickoff.
 * Null-stemplede beroeringer springes over (`5 > null` er sandt i JS).
 * -1 = ingen OT i beroeringerne. */
function otTurn(hits){
  const start = liveFrom(hits);
  let prev = null, turn = -1;
  for (let i = start; i < hits.length; i++){
    const t = hits[i].t;
    if (typeof t !== 'number') continue;
    if (prev !== null && t > prev && prev <= OT_TURN_MAX_PREV){ turn = i; break; }
    prev = t;
  }
  if (turn < 0) return -1;
  for (let j = turn - 1; j > start; j--){
    const e = hits[j], p = hits[j - 1];
    if (e.t !== 0) break;
    if (typeof e.w !== 'number' || typeof p.w !== 'number' || typeof p.t !== 'number') continue;
    if ((e.w - p.w) - (p.t - e.t) >= KICKOFF_GAP_S) return j;
  }
  return turn;
}

const numW = e => typeof e.w === 'number' ? e.w : -Infinity;

/* Skudstedet for eet maal: scorerens sidste beroering foer maalet, eller null
 * naar ingen kandidat findes (taelles i unbound, gaettes aldrig).
 *
 * Tre veje, i denne orden:
 *   1. maalet har selv `w` (recorder >= 1.5.0): sidste beroering af scoreren
 *      med w <= goal.w og goal.w - w <= 10 — vaeguret lyver ikke.
 *   2. OT (ot:true): uret taeller op, saa kandidater ligger EFTER vendepunktet
 *      med clock-10 <= t <= clock; hoejeste t (ved lighed hoejeste w).
 *   3. ordinaer tid: kandidater FOER vendepunktet med clock <= t <= clock+10.
 *      En kandidat med t == clock droppes naar den ligger inden for 1500 uu
 *      af centercirklen ELLER kommer efter >= 5 s stilhed paa vaegur: det er
 *      kickoffet efter maalet (uret staar stille gennem replay + nedtaelling
 *      og vaagner paa praecis maalets sekund). Blandt resten vinder HOEJESTE w
 *      = den sidste beroering foer maalet. Uden w (ingen i arkivet, men
 *      aeldre adaptere kunne) falder valget tilbage paa laveste t som foer.
 * En beroering med |y| > NET_Y (bolden i nettet efter maalet) er aldrig en
 * kandidat (8/9): scorerens forrige beroering i vinduet vinder i stedet.
 * Ordinaer tid er begraenset til foer vendepunktet fordi OT's t-vaerdier ogsaa
 * findes i ordinaer tid — ellers vandt en OT-beroering (hoejest w) et
 * ordinaert maal med lavt ur. Uden x (digests foer 26/8) doemmes naerhed til
 * centrum paa y alene: en beroering inden for 1500 uu af midten i samme
 * ur-sekund som et maal ved ±5120 er fysisk urimelig. */
function bindGoal(g, hits, turn){
  if (!g || !g.scorer) return null;
  const scorer = g.scorer;
  let best = null;
  if (typeof g.w === 'number'){
    for (const e of hits){
      if (e.name !== scorer || typeof e.w !== 'number' || inNet(e)) continue;
      if (e.w > g.w || g.w - e.w > BIND_WINDOW_S) continue;
      if (!best || e.w > best.w) best = e;
    }
  } else if (typeof g.clock !== 'number'){
    return null;
  } else if (g.ot){
    if (turn < 0) return null;
    for (let i = turn; i < hits.length; i++){
      const e = hits[i];
      if (e.name !== scorer || typeof e.t !== 'number' || inNet(e)) continue;
      if (e.t > g.clock || g.clock - e.t > BIND_WINDOW_S) continue;
      if (!best || e.t > best.t || (e.t === best.t && numW(e) > numW(best))) best = e;
    }
  } else {
    const end = turn >= 0 ? turn : hits.length;
    for (let i = 0; i < end; i++){
      const e = hits[i];
      if (e.name !== scorer || typeof e.t !== 'number' || inNet(e)) continue;
      if (e.t < g.clock || e.t - g.clock > BIND_WINDOW_S) continue;
      if (e.t === g.clock){
        const nearCentre = typeof e.y === 'number' && Math.abs(e.y) < radar.CENTER_R
          && (typeof e.x !== 'number' || Math.abs(e.x) < radar.CENTER_R);
        const prev = i > 0 ? hits[i - 1] : null;
        const silence = !!prev && typeof e.w === 'number' && typeof prev.w === 'number'
          && e.w - prev.w >= KICKOFF_GAP_S;
        if (nearCentre || silence) continue;
      }
      if (!best) best = e;
      else if (typeof e.w === 'number' && typeof best.w === 'number'){ if (e.w > best.w) best = e; }
      else if (e.t < best.t) best = e;
    }
  }
  return best && typeof best.y === 'number' ? best : null;
}

/* Kickoff-maal (ko:1): den bundne beroering ER kickoff-beroeringen. Ur og
 * navn alene raekker ikke (verifikation 7/9): kickoffet EFTER maalet deler ur
 * med maalet (frosset ur gennem replay + nedtaelling), saa naar scoreren
 * vinder det naeste kickoff og skuddet selv ligger i maalets sekund, blev et
 * rigtigt skud foran maalet stemplet kickoff-maal — 16 af 26 x-baerende ko:1
 * i arkivet laa >= 1500 uu fra centrum (2026-08-26T00-59-46 ur 203: skud paa
 * (-265, -4272) mod kickoffs[{clock 203, speed 108}] = kickoffet bagefter).
 * To vaern:
 *  - kickoffs[].speed == beroeringens spd: recorderen skriver begge fra samme
 *    touch (server.js: hitEvents.push + kickoffs.push i eet traek, samme
 *    afrunding), saa lighed peger paa PRAECIS den beroering. 2782 af 2782
 *    kickoffs med hitEvents i arkivet har sin beroering med samme spd.
 *    Manglende fart (null) beviser intet → ko:0.
 *  - naer centrum naar x kendes (|x|, |y| < CENTER_R; uden x kun y, som i
 *    bindGoal): en kickoff-beroering sker paa bolden i midten. 6 speed-match
 *    langt fra midten i arkivet er alle ubegraenset-boost-kampe (ude af
 *    radaren i forvejen) eller et kickoff-flag der fyrede 7 s for sent
 *    (2026-08-29T01-40-33 ur 293 paa (3387, 3723)) — ingen af dem er et
 *    kickoff-maal.
 * Rapporteres for sig og driver aldrig en forsvarsbane (§3). */
function isKickoffTouch(hit, scorer, kickoffs){
  if (typeof hit.spd !== 'number') return 0;
  const onSpot = Math.abs(hit.y) < radar.CENTER_R
    && (typeof hit.x !== 'number' || Math.abs(hit.x) < radar.CENTER_R);
  if (!onSpot) return 0;
  return kickoffs.some(k => k && k.clock === hit.t && k.firstTouch === scorer
    && typeof k.speed === 'number' && k.speed === hit.spd) ? 1 : 0;
}

/* Passer kampens bane paa standard-tegningen? Nej naar arenaen hedder
 * Labs_… eller ShatterShot_P, naar en beroering ligger uden for sidevaeggen,
 * eller naar mindst ARENA_NET_MIN beroeringer ligger dybere end NET_Y (en
 * standard-kamp har hoejst een net-beroering; Arena15-kampe har 20-30). Rent. */
function arenaFits(d, hits){
  if (d && typeof d.arena === 'string' && ARENA_OTHER.test(d.arena)) return false;
  let net = 0;
  for (const e of hits || []){
    if (!e) continue;
    if (typeof e.x === 'number' && Math.abs(e.x) > WALL_X) return false;
    if (typeof e.y === 'number' && Math.abs(e.y) > NET_Y && ++net >= ARENA_NET_MIN) return false;
  }
  return true;
}
const inNet = e => typeof e.y === 'number' && Math.abs(e.y) > NET_Y;   // bolden i nettet efter maalet: aldrig et skudsted

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
              goalsFor: 0, goalsAgainst: 0, dots: [], scoredFrom: [], concededFrom: [],
              mineZones: zoneCounts(), excluded: { private: 0, mutators: 0, arena: 0 }, unbound: 0 };
  /* Radar-felterne (skudsteder, egne zoner, ubundne) holdes ude for private
   * lobbyer og mutator-kampe: en privat lobby er ikke ranked-populationen, og
   * med ubegraenset boost skydes der fra steder man aldrig naar i en rigtig
   * kamp. Tegningen (mine/mates/opps/layers/dots) taeller dem stadig, som
   * den altid har gjort. Een aarsag pr. kamp: privat foerst, saa excluded
   * summerer til antal udeladte kampe. Baner med en anden geometri (8/9,
   * arenaFits) holdes ude paa samme maade: privat foerst, saa mutator, saa bane. */
  const isPrivate = M.privacyOf(d).private === true;
  const isMutator = M.mutatorsOf(d, me).length > 0;
  const arenaOut = !arenaFits(d, hits);
  const radarOut = isPrivate || isMutator || arenaOut;
  if (radarOut) c.excluded[isPrivate ? 'private' : isMutator ? 'mutators' : 'arena'] = 1;
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
      // egne beroeringer pr. angrebszone (til maal pr. 100 beroeringer, trin B)
      if (who === 'mine' && !radarOut){
        const z = radar.zoneOf(e.x * flip, e.y * flip, typeof e.z === 'number' ? e.z : null, 'off');
        if (z) c.mineZones[z]++;
      }
    }
  }
  const day = playDay(d.startedAt);
  /* Binderen ser kun kampens EGNE beroeringer (fra kickoffet, liveFrom): en
   * stale beroering fra forrige kamp paa t 141 er ellers en gyldig kandidat
   * for et maal ved ur 140 (fixture 16-27-14 uden mutator-vagten). Tegningen
   * ovenfor taeller stadig alle hits (legacy-lighed). Vendepunktet bruges kun
   * for kampe der HAR OT: recorderens `overtime` og goals[].ot stemmer i 436
   * af 436 arkiv-kampe, saa en ikke-OT-kamp kan aldrig blive delt i to. */
  const live = hits.slice(liveFrom(hits));
  const hasOt = d.overtime === true || (d.goals || []).some(g => g && g.ot);
  const turn = hasOt ? otTurn(live) : -1;
  const kickoffs = Array.isArray(d.kickoffs) ? d.kickoffs : [];
  for (const g of (d.goals || [])){
    g.team === me.team ? c.goalsFor++ : c.goalsAgainst++;
    if (radarOut || !g || !g.scorer) continue;
    /* Kun mine egne maal og modstandernes — medspilleres er ikke
     * efterspurgt. Skudstedet bindes af bindGoal; et maal uden kandidat
     * taelles i unbound og udelades aerligt. */
    const isMine = g.scorer === me.name && g.team === me.team;
    const isOpp = g.team !== me.team;
    if (!isMine && !isOpp) continue;
    const best = bindGoal(g, live, turn);
    if (!best){ c.unbound++; continue; }
    const ko = isKickoffTouch(best, g.scorer, kickoffs);
    (isMine ? c.scoredFrom : c.concededFrom).push([
      typeof best.x === 'number' ? Math.round(best.x * flip) : null,
      Math.round(best.y * flip),
      g.ot ? OT_MINUTE : minuteOf(best.t),
      typeof best.z === 'number' ? Math.round(best.z) : null,
      day, ko]);
  }
  return c;
}

/* Radar-felterne foldes ens i fold() og foldEntries(). */
function addRadar(out, c){
  for (const s of c.scoredFrom) out.scoredFrom.push(s);
  for (const s of c.concededFrom) out.concededFrom.push(s);
  for (const z of Object.keys(out.mineZones)) out.mineZones[z] += (c.mineZones && c.mineZones[z]) || 0;
  out.excluded.private += (c.excluded && c.excluded.private) || 0;
  out.excluded.mutators += (c.excluded && c.excluded.mutators) || 0;
  out.excluded.arena += (c.excluded && c.excluded.arena) || 0;
  out.unbound += c.unbound || 0;
}

/* Kun radar-felterne + maal, til session/uge der har deres egne kampfiler
 * (contributionsFor) og ikke skal baere 44-bucket-lagene rundt. */
function foldEntries(contribs){
  const out = { matches: 0, goalsFor: 0, goalsAgainst: 0, scoredFrom: [], concededFrom: [],
                mineZones: zoneCounts(), excluded: { private: 0, mutators: 0, arena: 0 }, unbound: 0 };
  for (const c of contribs){
    if (!c) continue;
    out.matches++;
    out.goalsFor += c.goalsFor; out.goalsAgainst += c.goalsAgainst;
    addRadar(out, c);
  }
  return out;
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
    addRadar(out, c);
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

/* ---- server-siden: eet aggregat pr. (arkiv, ejer), inkrementelt ----
 * Cachen er noeglet pr. (arkiv, ejer) med et lille loft (verifikation 7/9):
 * foer smed et kald med en anden ejer (gaest) ejerens per-fil-cache vaek, saa
 * naeste aggregate() genlaeste hele arkivet paa hovedtraaden (109 ms for 692
 * filer). Gaester har egen mappe (dir er anden), saa skiftet ejer<->gaest
 * rammer nu to adskilte poster i stedet for een der bygges om og om. Loftet
 * holder hukommelsen nede (hver post baerer alle filers dots); den aeldste
 * post ryger foerst. */
const CACHE_MAX = 3;
const caches = new Map();   // '<dir>|<ownerKey>' -> { key, data, files: Map }
const ownerKeyOf = owner => ((owner && owner.pid) || '') + '|' + ((owner && owner.name) || '');
function cacheFor(dir, owner){
  const id = dir + '|' + ownerKeyOf(owner);   // '|' kan ikke staa i en Windows-sti, og ownerKey er allerede '|'-delt
  let c = caches.get(id);
  if (!c){
    c = { key: '', data: null, files: new Map() };   // key '' matcher aldrig et arkiv: aggregate folder selv
    if (caches.size >= CACHE_MAX) caches.delete(caches.keys().next().value);
    caches.set(id, c);
  }
  return c;
}
function aggregate(dir, owner){
  const files = listFiles(dir);
  const key = files.length + ':' + (files[files.length - 1] || '');
  const c = cacheFor(dir, owner);
  if (c.key === key && c.data) return c.data;
  const live = new Set(files);
  for (const f of [...c.files.keys()]) if (!live.has(f)) c.files.delete(f);
  c.data = foldFiles(dir, files, owner, c.files);
  c.key = key;
  return c.data;
}
function reset(){ caches.clear(); }

/* Bidragene for netop DISSE filer (session, uge) fra den delte per-fil-cache:
 * kun filer der ikke staar i cachen laeses, og aggregate() genbruger samme
 * Map bagefter. Ulaeselige filer springes over som i foldFiles. Cachen
 * tilhoerer (arkiv, ejer) — en gaest paa ejerens arkiv faar sin egen post og
 * roerer ikke ejerens. */
function contributionsFor(dir, files, owner){
  const c = cacheFor(dir, owner);
  const out = [];
  for (const f of files){
    if (!c.files.has(f)){
      const d = readDigest(dir, f);
      if (d === undefined) continue;
      c.files.set(f, contribution(d, owner));
    }
    out.push(c.files.get(f));
  }
  return out;
}

module.exports = { aggregate, reset, contribution, fold, foldFiles, foldEntries, contributionsFor,
                   listFiles, emptyAggregate, bindGoal, otTurn, liveFrom, playDay, isKickoffTouch, arenaFits,
                   PITCH_BUCKETS, PITCH_SPAN, PITCH_DOTS_MAX, BIND_WINDOW_S, KICKOFF_GAP_S, OT_TURN_MAX_PREV, OT_MINUTE, CACHE_MAX,
                   GOAL_Y, NET_Y, WALL_X, ARENA_NET_MIN, ARENA_OTHER };
