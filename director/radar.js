/* RL Director — baneradar: zoner for skudsteder, profiler, gates og valg af
 * traeningsbane (6/9-2026 trin A = geometri, 7/9 trin B = resten).
 *
 * Kontrakten er director/RADAR-DESIGN.md §1, §3, §4, §5. Modulet er RENT:
 * ingen I/O, intet ur, ingen tilstand — kun geometri og taelling over
 * koordinater i EJERENS ramme, som pitch.js allerede laver den: ejerens
 * forsvar ved -y, angreb mod +y. Sproget spoerges hos metrics.currentLanguage
 * (samme EN()-moenster som director.js/focus.js) naar kalderen ikke selv siger
 * 'da'/'en'; gate-tekster baerer altid begge sprog.
 *
 * Hvorfor to zonefamilier over samme bane: de steder der bliver scoret MOD
 * spilleren skal traenes defensivt (D-zoner, skudstedet for indkasserede
 * maal), de steder han sjaeldent selv scorer FRA skal traenes offensivt
 * (O-zoner, skudstedet for egne maal og hans egne beroeringer). O er D
 * spejlet i y — samme nummer, samme betydning set fra det maal der er i spil.
 *
 * Orientering: RLBot-wikien siger "+x er spillerens VENSTRE" set fra eget maal
 * mod deres, men det er IKKE set i spillet endnu (brugeren skal se een kendt
 * beroering — Blues venstre hjoerne-kickoff-plet (2048, -2560)). Saa laenge
 * ORIENTATION_VERIFIED er false maa INGEN tekst sige venstre/hoejre — kun
 * "fra siden af dit forsvar". Koden og zonerne maa godt skelne ±x. */
'use strict';

const M = require('./metrics');
const T = require('./tier');   // spillerens tier og vindue (8/9): svaerhed er relativ, ikke et fast loft
const EN = () => M.currentLanguage() === 'en';

const THIRD = 5120 / 3;     // tredjedelslinjen (≈ 1707 uu); banen er ±5120 langs y
const POST = 893;           // maalets halve bredde (RLBot: 892,755 uu)
const AIR_Z = 150;          // bold paa/lige over jorden: boldradius 92,75 + lidt luft
const CENTER_R = 1500;      // centercirklens "naerhed" for kickoff-frasortering (pitch.js)
const ORIENTATION_VERIFIED = false;

const ZONES = [
  { id: 'D1', family: 'def', label: { da: 'foran eget mål (jord)',      en: 'in front of own goal (ground)' } },
  { id: 'D2', family: 'def', label: { da: 'foran eget mål (luft)',      en: 'in front of own goal (air)' } },
  { id: 'D3', family: 'def', label: { da: 'siden af dit forsvar (+x)',  en: 'side of your defence (+x)' } },
  { id: 'D4', family: 'def', label: { da: 'siden af dit forsvar (−x)',  en: 'side of your defence (−x)' } },
  { id: 'D5', family: 'def', label: { da: 'midterzonen',                en: 'the middle zone' } },
  { id: 'D6', family: 'def', label: { da: 'deres tredjedel',            en: 'their third' } },
  { id: 'O1', family: 'off', label: { da: 'foran deres mål (jord)',     en: 'in front of their goal (ground)' } },
  { id: 'O2', family: 'off', label: { da: 'foran deres mål (luft)',     en: 'in front of their goal (air)' } },
  { id: 'O3', family: 'off', label: { da: 'siden af deres tredjedel (+x)', en: 'side of their third (+x)' } },
  { id: 'O4', family: 'off', label: { da: 'siden af deres tredjedel (−x)', en: 'side of their third (−x)' } },
  { id: 'O5', family: 'off', label: { da: 'midterzonen',                en: 'the middle zone' } },
  { id: 'O6', family: 'off', label: { da: 'egen tredjedel',             en: 'own third' } }
];
const DEF_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const OFF_IDS = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6'];
const SIDE_RE = /^[DO][34]$/;
/* Siderne deler pulje (ingen katalogpost skelner venstre/hoejre — packs.js
 * SHARED_SIDES), og positions-niveauet foelger samme regel: en bane der
 * daekker D3 kan lige saa godt traene D4, for teksten naevner aldrig siden. */
const SIDE_MATE = { D3: 'D4', D4: 'D3', O3: 'O4', O4: 'O3' };

/* Zone for et punkt i ejerens ramme. family 'def' (indkasserede maal) eller
 * 'off' (egne maal/beroeringer). Regler ordret fra kontrakten:
 *   D1 y ≤ -THIRD, |x| ≤ POST, z ≤ AIR_Z   D2 samme, z > AIR_Z
 *   D3 y ≤ -THIRD, x > POST                D4 y ≤ -THIRD, x < -POST
 *   D5 -THIRD < y < THIRD                   D6 y ≥ THIRD
 * O-zonerne er D spejlet i y (O1 y ≥ THIRD ... O6 y ≤ -THIRD).
 * x == null → null (kan ikke stedfaestes, taelles i noX af den der kalder).
 * z == null med x kendt → jord (z var ikke i feedet foer x kom, og en bold
 * uden hoejde er en jordbold indtil andet er maalt — taelles i noZ). */
function zoneOf(x, y, z, family){
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const off = family === 'off';
  if (!off && family !== 'def') return null;
  const yy = off ? -y : y;                    // spejlet: deres maal ligger ved +y
  const p = off ? 'O' : 'D';
  if (yy >= THIRD) return p + '6';
  if (yy > -THIRD) return p + '5';
  if (x > POST) return p + '3';
  if (x < -POST) return p + '4';
  const air = typeof z === 'number' && Number.isFinite(z) && z > AIR_Z;
  return p + (air ? '2' : '1');
}

/* ---------------- §4a: baner med maalte skudpositioner ---------------- */

/* En bane "daekker" en zone naar ≥ 40 % af dens skud starter der (≥ 30 % for
 * sidezonerne D3/D4/O3/O4). Kun zoner der kan drive en bane (packs.RADAR_ZONES)
 * kan daekkes — D6/O6/O1/O2 taelles i `zones` men staar aldrig i `covers`. */
const COVER_SHARE = 0.40;
const COVER_SHARE_SIDE = 0.30;
/* Ikke i kontrakten (7/9, afvigelse deklareret i handover): 24 af de 55
 * importerede baner har 1-4 skud, og eet skud "daekker" sin zone 100 %. En
 * bane med saa faa skud siger intet om hvor den traener, saa den bliver
 * liggende i `zones` men faar tomt `covers`. */
const POS_MIN_SHOTS = 5;
/* Ikke i kontrakten (7/9, runde 1 — §9 aerlighed): en bane hvis skudtal i
 * Prejump ikke laengere er filens (`stale`, banen er aendret efter importen)
 * har maalte skud der ikke er banens NUVAERENDE skud. "Valgt paa banens skud"
 * ville lyve, saa den bliver liggende i `zones` men faar tomt `covers` og
 * staar dermed aldrig i positions-niveauet. */
const DRIVABLE = ['D1', 'D2', 'D3', 'D4', 'D5', 'O3', 'O4', 'O5'];   // == packs.RADAR_ZONES (kopieret: radar.js traekker ikke packs ind)

/* Katalogposter (pack-catalog*.json: {packs:[{code,name,tags}]} eller en raa
 * liste) → kode → {name, tags}. Flere kataloger maa gives; foerste vinder. */
function catalogIndex(catalogs){
  const idx = new Map();
  const list = Array.isArray(catalogs) && catalogs.length && !catalogs[0].code ? catalogs : [catalogs];
  for (const cat of list){
    const packs = !cat ? [] : Array.isArray(cat) ? cat : Array.isArray(cat.packs) ? cat.packs : [];
    for (const p of packs){
      if (!p || !p.code || idx.has(p.code)) continue;
      idx.set(p.code, { name: p.name || '', tags: Array.isArray(p.tags) ? p.tags : [], difficulty: p.difficulty || null });
    }
  }
  return idx;
}

/* Hoops-baner har en anden maalgeometri (ringe, ikke en mund) og maa ALDRIG
 * vaelges: Prejump-tagget 'Hoops' eller /hoops/ i navnet (fil eller katalog). */
function isHoops(name, cat){
  return /hoops/i.test(name || '') || !!(cat && (cat.tags.some(t => /^hoops$/i.test(String(t))) || /hoops/i.test(cat.name)));
}

/* Svaerhedsvindue (7/9 fast loft → 8/9 relativt til spilleren, director/tier.js):
 * Prejumps difficulty er banens eget rangniveau. En bane maa kun i puljen naar den
 * ligger i SPILLERENS vindue [tier-1, tier+1] — en Diamond-bane som 'dit
 * forsvarsproblem' er demotiverende for en Silver, en Bronze-bane er det for en
 * Champion (testerens klage 7/9). Lander-kataloget har ingen difficulty; der siger
 * NAVNET det (tier.packTier: air dribbles, flip resets, ceiling shots, double taps,
 * redirects = Diamond-mekanik uanset rating). Baner uden niveau slipper igennem
 * (ukendt ≠ svaer). Uden tier-info gaelder standarden (Silver: Bronze..Gold), saa
 * kaldere uden spillerdata (tests, replay) doemmer som ejeren. */
function isTooHard(cat, name, info){
  return !T.fits(info || T.DEFAULT_INFO, cat && cat.difficulty, name || (cat && cat.name));
}

/* Zonefordeling pr. bane fra pack-positions.json. Traeningsbaner saetter
 * spilleren til at angribe +y med eget maal ved y = -5120, saa et 'save'-
 * spawn ligger allerede i forsvarerens ramme → zoneOf(..., 'def'); et 'shot'-
 * spawn er skyttens sted → zoneOf(..., 'off'). Zonen regnes af BOLDENS spawn
 * (kontrakten §4a). Resultat pr. kode:
 *   {name, zones:{D1:andel,...}, covers:[zoneId], kind:'positions', hoops, stale, n}
 * (stale → covers altid tom, se POS_MIN_SHOTS-noten). */
function packZones(positionsJson, catalogs){
  const idx = catalogIndex(catalogs);
  const out = {};
  for (const code of Object.keys(positionsJson || {}).sort()){
    const e = positionsJson[code];
    const shots = (e && Array.isArray(e.shots)) ? e.shots : [];
    const cnt = {};
    let n = 0;
    for (const s of shots){
      if (!s || !s.ball) continue;
      const z = zoneOf(s.ball.x, s.ball.y, s.ball.z, s.kind === 'save' ? 'def' : 'off');
      if (!z) continue;
      n++;
      cnt[z] = (cnt[z] || 0) + 1;
    }
    const zones = {};
    for (const z of DEF_IDS.concat(OFF_IDS)) if (cnt[z]) zones[z] = cnt[z] / n;
    const stale = !!(e && e.stale);
    const covers = n >= POS_MIN_SHOTS && !stale
      ? DRIVABLE.filter(z => (zones[z] || 0) >= (SIDE_RE.test(z) ? COVER_SHARE_SIDE : COVER_SHARE))
      : [];
    const cat = idx.get(code) || null;
    out[code] = { name: (e && e.name) || (cat && cat.name) || code, zones, covers, kind: 'positions',
                  hoops: isHoops(e && e.name, cat), hard: isTooHard(cat, e && e.name), difficulty: cat && cat.difficulty || null,
                  stale, n };
  }
  return out;
}

/* Kandidaterne for een zone, ordnet: positions-niveauet foerst (stoerste
 * andel i zonen eller dens sidemakker foerst, kode som tie-break), derefter
 * tag-niveauet i BANK-orden (packs.forZone). Hoops ude, dublet-koder ude
 * (positions vinder, for den er maalt). `bank` er packs.BANK-lignende poster
 * med {id,name,code,zones}; `positions` er packZones()' resultat. Begge maa
 * mangle. */
function poolFor(zone, src){
  const positions = (src && src.positions) || {};
  const bank = (src && Array.isArray(src.bank)) ? src.bank : [];
  const info = (src && src.tier) || T.DEFAULT_INFO;   // spillerens vindue (tier.js); uden = Silver-standarden
  const mate = SIDE_MATE[zone] || null;
  const seen = new Set();
  const out = [];
  const pos = [];
  for (const code of Object.keys(positions)){
    const p = positions[code];
    if (!p || p.hoops || !T.fits(info, p.difficulty, p.name)) continue;   // Hoops = anden geometri; uden for vinduet = ikke spillerens niveau
    const hit = p.covers.includes(zone) || (mate && p.covers.includes(mate));
    if (!hit) continue;
    pos.push({ id: 'pos:' + code, name: p.name, code, confidence: 'positions', zones: p.covers.slice(),
               share: Math.max(p.zones[zone] || 0, mate ? (p.zones[mate] || 0) : 0) });
  }
  pos.sort((a, b) => (b.share - a.share) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const p of pos){ if (!seen.has(p.code)){ seen.add(p.code); out.push({ id: p.id, name: p.name, code: p.code, confidence: 'positions', zones: p.zones }); } }
  let dropped = 0;   // bank-baner i zonen uden for spillerens vindue → lige saa mange erstatninger
  const push = p => {
    seen.add(p.code);
    const e = { id: p.id || ('tags:' + p.code), name: p.name, code: p.code, confidence: 'tags', zones: (Array.isArray(p.zones) ? p.zones : []).slice() };
    if (p.difficulty) e.difficulty = p.difficulty;    // katalogets ord, til kortet
    if (p.substitute) e.substitute = p.substitute;    // erstatning for bankens bane (8/9)
    if (p.source) e.source = p.source;
    out.push(e);
  };
  for (const p of bank){
    if (!p || !p.code || seen.has(p.code)) continue;
    const zs = Array.isArray(p.zones) ? p.zones : [];
    if (!zs.includes(zone) && !(mate && zs.includes(mate))) continue;
    if (isHoops(p.name, null)) continue;
    if (!T.fitsTiers(info, p.tiers, p.name)){ dropped++; continue; }
    push(p);
  }
  /* Erstatninger (8/9): for hver bank-bane vinduet tog, een Prejump-bane med zonens
   * behov paa spillerens niveau (packs.substitutesForZone via src.substitute(zone,
   * antal, koder-i-brug)) — bagest, saa bankens egne baner beholder deres plads i
   * rotationen. Intet taget → intet tilfoejet: ejerens puljer er uroerte. */
  if (dropped && src && typeof src.substitute === 'function'){
    for (const p of (src.substitute(zone, dropped, Array.from(seen)) || [])){
      if (!p || !p.code || seen.has(p.code) || isHoops(p.name, null) || !T.fits(info, p.difficulty, p.name)) continue;
      push(p);
    }
  }
  return out;
}

/* ---------------- §3: vinduer, gates, profiler ---------------- */

const SESSION_GATE = Object.freeze({ min: 8, zoneMin: 5, zoneShare: 0.30, window: 'session' });
const WEEK_GATE = Object.freeze({ min: 40, zoneMin: 10, zoneShare: 0.25, window: 'week' });
const OFFENSE_GATE = Object.freeze({ minTouches: 40 });
const LONGRUN_MIN = 100;   // langtidsandelen bruges kun til tie-break naar ≥ 100 stedfaestede

const pct = (n, d) => d > 0 ? Math.round(100 * n / d) : 0;
const num = v => typeof v === 'number' && Number.isFinite(v);

/* Vinduets ord i teksterne: session = i aften, uge = i uge N (eller "i ugen"
 * naar nummeret ikke er givet), all = over alle kampe (banekortets 'Alt'-
 * vindue, 8/9). */
function windowWord(win, week, en){
  if (win === 'week') return num(week) ? (en ? 'in week ' + week : 'i uge ' + week) : (en ? 'this week' : 'i ugen');
  if (win === 'all') return en ? 'over all matches' : 'over alle kampe';
  return en ? 'tonight' : 'i aften';
}
const windowOf = o => o && (o.window === 'week' || o.window === 'all') ? o.window : 'session';

/* Profil over skudsteder ([x|null, y, minut, z|null, day, ko] fra pitch.js).
 * Kickoff-maal (ko) holdes UDE af zonerne og af `located` — de rapporteres for
 * sig ("heraf N kickoff-maal") og foedes til kickoff-koblingerne, aldrig til en
 * forsvarsbane (§3). noX = ikke stedfaestet (x ELLER y mangler — navnet er
 * kontraktens, taelleren er "kunne ikke saettes i en zone"); z == null → jord + noZ.
 * opts: {min, zoneMin, zoneShare, window, week, family}. Familien er 'def'
 * (indkasserede) medmindre andet siges; 'off' giver samme profil over egne
 * maal (O-zoner) til rapportens "scored"-tabel. D6/O6 er aldrig dominerende. */
function profile(entries, opts){
  const o = Object.assign({}, SESSION_GATE, opts || {});
  const family = o.family === 'off' ? 'off' : 'def';
  const ids = family === 'off' ? OFF_IDS : DEF_IDS;
  const zones = {};
  for (const z of ids) zones[z] = { n: 0, share: 0 };
  let n = 0, located = 0, noX = 0, noZ = 0, ko = 0;
  for (const e of (Array.isArray(entries) ? entries : [])){
    if (!Array.isArray(e)) continue;
    n++;
    if (e[5]){ ko++; continue; }
    const x = e[0], y = e[1], z = e[3];
    if (!num(x)){ noX++; continue; }
    const id = zoneOf(x, y, num(z) ? z : null, family);
    if (!id){ noX++; continue; }                 // y mangler/NaN: ogsaa ikke stedfaestet
    if (!num(z)) noZ++;
    located++;
    zones[id].n++;
  }
  for (const z of ids) zones[z].share = located > 0 ? zones[z].n / located : 0;
  // dominerende: stoerste n blandt de fem foerste (6'eren driver aldrig en bane); lighed → foerste i orden
  let dominant = null;
  for (const z of ids.slice(0, 5)) if (zones[z].n > 0 && (!dominant || zones[z].n > zones[dominant].n)) dominant = z;
  const win = windowOf(o);
  const gate = gateOf({ n, located, ko, zones, dominant, family }, o, win);
  return { n, located, noX, noZ, ko, zones, dominant, family, window: win, week: num(o.week) ? o.week : null, gate };
}

function gateOf(p, o, win){
  const what = p.family === 'off'
    ? { da: 'stedfæstede egne mål', en: 'located goals of your own' }
    : { da: 'stedfæstede indkasseringer', en: 'located goals conceded' };
  const w = { da: windowWord(win, o.week, false), en: windowWord(win, o.week, true) };
  if (p.located < o.min){
    return { ok: false, reason: {
      da: 'for få ' + what.da + ' ' + w.da + ' (n=' + p.located + ', kræver ' + o.min + ')',
      en: 'too few ' + what.en + ' ' + w.en + ' (n=' + p.located + ', needs ' + o.min + ')' } };
  }
  const d = p.dominant ? p.zones[p.dominant] : null;
  if (!d || d.n < o.zoneMin || d.share < o.zoneShare){
    const lbl = p.dominant ? zoneLabel(p.dominant) : null;
    return { ok: false, reason: {
      da: 'ingen zone skiller sig ud ' + w.da + (lbl ? ' (største: ' + lbl.da + ' ' + d.n + ' af ' + p.located : ' (0 af ' + p.located)
          + ', kræver ' + o.zoneMin + ' og ' + Math.round(o.zoneShare * 100) + ' %)',
      en: 'no zone stands out ' + w.en + (lbl ? ' (largest: ' + lbl.en + ' ' + d.n + ' of ' + p.located : ' (0 of ' + p.located)
          + ', needs ' + o.zoneMin + ' and ' + Math.round(o.zoneShare * 100) + ' %)' } };
  }
  const lbl = zoneLabel(p.dominant);
  return { ok: true, reason: {
    da: p.located + ' ' + what.da + ' ' + w.da + ', ' + lbl.da + ' ' + d.n + ' (' + pct(d.n, p.located) + ' %)',
    en: p.located + ' ' + what.en + ' ' + w.en + ', ' + lbl.en + ' ' + d.n + ' (' + pct(d.n, p.located) + ' %)' } };
}

/* Angrebsprofil: egne maal pr. O-zone mod egne beroeringer i zonen (pitch.js
 * mineZones), maal pr. 100 beroeringer. Front = O1+O2 (foran deres maal).
 * Svag zone: O3/O4/O5 med ≥ minTouches beroeringer og en rate ≤ halvdelen af
 * fronten — HANS eget forhold zone mod zone, aldrig en benchmark (§3).
 * Kickoff-maal holdes ude af zonerne som i profile(). */
function offenseProfile(scoredFrom, mineZones, opts){
  const o = Object.assign({}, OFFENSE_GATE, opts || {});
  const touchesOf = z => (mineZones && num(mineZones[z]) ? mineZones[z] : 0);
  const goals = {};
  for (const z of OFF_IDS) goals[z] = 0;
  let n = 0, located = 0, noX = 0, ko = 0;
  for (const e of (Array.isArray(scoredFrom) ? scoredFrom : [])){
    if (!Array.isArray(e)) continue;
    n++;
    if (e[5]){ ko++; continue; }
    if (!num(e[0])){ noX++; continue; }
    const id = zoneOf(e[0], e[1], num(e[3]) ? e[3] : null, 'off');
    if (!id){ noX++; continue; }
    located++;
    goals[id]++;
  }
  const rate = (g, t) => t > 0 ? 100 * g / t : null;
  const zones = {};
  for (const z of OFF_IDS){
    const t = touchesOf(z);
    zones[z] = { goals: goals[z], touches: t, per100: rate(goals[z], t) };
  }
  const fg = goals.O1 + goals.O2, ft = touchesOf('O1') + touchesOf('O2');
  const front = { goals: fg, touches: ft, per100: rate(fg, ft) };
  const cands = ['O3', 'O4', 'O5'].filter(z => zones[z].touches >= o.minTouches);
  /* Fronten skal have mindst eet maal: med 0 maal foran maalet ville enhver
   * sidezone uden maal opfylde "≤ halvdelen" (0 ≤ 0) og faa en bane paa tal
   * der ikke siger noget (runde 1, 7/9). */
  const weak = front.per100 === null || front.goals < 1 ? []
    : cands.filter(z => zones[z].per100 !== null && zones[z].per100 <= front.per100 / 2)
           .sort((a, b) => (zones[a].per100 - zones[b].per100) || (OFF_IDS.indexOf(a) - OFF_IDS.indexOf(b)));
  const win = windowOf(o);
  const week = num(o.week) ? o.week : null;
  const w = { da: windowWord(win, week, false), en: windowWord(win, week, true) };
  let gate;
  if (!cands.length){
    const most = Math.max(zones.O3.touches, zones.O4.touches, zones.O5.touches);
    gate = { ok: false, reason: {
      da: 'for få egne berøringer i siderne ' + w.da + ' (n=' + most + ', kræver ' + o.minTouches + ')',
      en: 'too few of your own touches in the sides ' + w.en + ' (n=' + most + ', needs ' + o.minTouches + ')' } };
  } else if (front.per100 === null){
    gate = { ok: false, reason: {
      da: 'ingen egne berøringer foran deres mål ' + w.da + ' at måle imod',
      en: 'no touches of your own in front of their goal ' + w.en + ' to measure against' } };
  } else if (front.goals < 1){
    gate = { ok: false, reason: {
      da: 'ingen egne mål foran deres mål ' + w.da + ' at måle imod (0 mål på ' + front.touches + ' berøringer)',
      en: 'no goals of your own in front of their goal ' + w.en + ' to measure against (0 goals on ' + front.touches + ' touches)' } };
  } else if (!weak.length){
    const best = cands.slice().sort((a, b) => zones[a].per100 - zones[b].per100)[0];
    gate = { ok: false, reason: {
      da: 'ingen zone ligger under halvdelen af din rate foran målet ' + w.da + ' (' + fmtRate(front.per100, false) + ' pr. 100; laveste: '
          + zoneLabel(best).da + ' ' + fmtRate(zones[best].per100, false) + ' pr. 100)',
      en: 'no zone sits below half your rate in front of goal ' + w.en + ' (' + fmtRate(front.per100, true) + ' per 100; lowest: '
          + zoneLabel(best).en + ' ' + fmtRate(zones[best].per100, true) + ' per 100)' } };
  } else {
    const z = weak[0];
    gate = { ok: true, reason: {
      da: zoneLabel(z).da + ': ' + zones[z].goals + ' mål på ' + zones[z].touches + ' berøringer ' + w.da + ' (' + fmtRate(zones[z].per100, false) + ' pr. 100) mod ' + fmtRate(front.per100, false) + ' pr. 100 foran målet',
      en: zoneLabel(z).en + ': ' + zones[z].goals + ' goals on ' + zones[z].touches + ' touches ' + w.en + ' (' + fmtRate(zones[z].per100, true) + ' per 100) against ' + fmtRate(front.per100, true) + ' per 100 in front of goal' } };
  }
  return { n, located, noX, ko, zones, front, weak, window: win, week, gate };
}

/* ---------------- §5: udvaelgelse ---------------- */

/* Sidst-vist-indeks pr. kode over packHistory[] ({pack, at, variety, shown:[codes], radar}).
 * Aldrig vist → -1. */
function lastSeenIndex(history){
  const seen = {};
  (Array.isArray(history) ? history : []).forEach((h, i) => {
    if (!h) return;
    const codes = (Array.isArray(h.shown) ? h.shown : [h.pack]).concat(h.variety || [], h.radar || []);
    for (const c of codes) if (c) seen[c] = i;
  });
  return seen;
}

/* Forrige rapports radar-kode: ctx.lastRadar naar kalderen siger den (null =
 * "ingen"), ellers `radar`-feltet paa historikkens sidste post (kontrakten §5:
 * packHistory faar feltet). Uden nogen af delene udelukkes intet. */
function lastRadarOf(ctx){
  if (ctx && ctx.lastRadar !== undefined) return ctx.lastRadar || null;
  const h = ctx && Array.isArray(ctx.history) ? ctx.history : [];
  const last = h.length ? h[h.length - 1] : null;
  return (last && last.radar) || null;
}

/* Mindst-nyligt-vist i puljen, aldrig forrige rapports radar-kode; puljens
 * orden er tie-break. Poster uden kode kan ikke vises og springes over.
 * Svarer {p, seen} (seen -1 = aldrig vist) eller null naar intet er tilbage. */
function rotateWithSeen(pool, history, lastRadar){
  const seen = lastSeenIndex(history);
  const last = lastRadar || null;
  const cands = (Array.isArray(pool) ? pool : []).map((p, idx) => ({ p, idx, seen: p && p.code && Object.prototype.hasOwnProperty.call(seen, p.code) ? seen[p.code] : -1 }))
                    .filter(c => c.p && c.p.code && c.p.code !== last);
  if (!cands.length) return null;
  cands.sort((a, b) => (a.seen - b.seen) || (a.idx - b.idx));
  return cands[0];
}
function rotate(pool, history, lastRadar){
  const c = rotateWithSeen(pool, history, lastRadar);
  return c ? c.p : null;
}

/* Puljen for zonen fra ctx: ctx.pools[zone] (fx packs.forZone eller poolFor's
 * svar) eller ctx.pools som funktion. Sidezoner deler pulje: mangler zonens
 * egen post, bruges makkerens. */
function poolOf(zone, ctx){
  const pools = ctx && ctx.pools;
  if (typeof pools === 'function') return pools(zone) || [];
  if (pools && Array.isArray(pools[zone])) return pools[zone];
  const mate = SIDE_MATE[zone];
  if (mate && pools && Array.isArray(pools[mate])) return pools[mate];
  return [];
}

const packOf = p => {
  const o = { id: p.id, name: p.name, code: p.code, confidence: p.confidence === 'positions' ? 'positions' : 'tags' };
  if (p.difficulty) o.difficulty = p.difficulty;    // katalogets ord (Prejump), til kortet
  if (p.substitute) o.substitute = p.substitute;    // erstatning for en bank-bane uden for vinduet (8/9)
  if (p.source) o.source = p.source;
  return o;
};

/* Zonen for forsvarsvalget (kontrakten §3): dominerende; ved lighed stoerst
 * afvigelse fra langtidsandelen (kun naar longRun.located ≥ 100); staar de
 * stadig lige → rotation: den zone hvis naeste bane er mindst nyligt vist
 * (aldrig vist foerst, en udtoemt pulje sidst); til sidst foerste i orden. */
function chooseZone(prof, longRun, ctx){
  const ids = (prof.family === 'off' ? OFF_IDS : DEF_IDS).slice(0, 5);
  const top = prof.zones[prof.dominant].n;
  let tied = ids.filter(z => prof.zones[z].n === top);
  if (tied.length < 2) return prof.dominant;
  if (longRun && num(longRun.located) && longRun.located >= LONGRUN_MIN && longRun.zones){
    const devOf = z => prof.zones[z].share - (longRun.zones[z] && num(longRun.zones[z].share) ? longRun.zones[z].share : 0);
    const bestDev = Math.max.apply(null, tied.map(devOf));
    tied = tied.filter(z => devOf(z) === bestDev);
    if (tied.length < 2) return tied[0];
  }
  const last = lastRadarOf(ctx);
  let best = tied[0], bestSeen = Infinity;
  for (const z of tied){
    const c = rotateWithSeen(poolOf(z, ctx), ctx && ctx.history, last);
    const seen = c ? c.seen : Infinity;          // udtoemt/tom pulje taber til enhver bane
    if (seen < bestSeen){ bestSeen = seen; best = z; }
  }
  return best;
}

/* Hvorfor puljen ikke gav en bane: tom, eller brugt op (eneste bane var
 * forrige rapports). null naar der faktisk ER et valg. */
function poolWhy(zone, ctx){
  const pool = poolOf(zone, ctx);
  const lbl = zoneLabel(zone);
  if (!pool.length) return { da: 'ingen bane i banken dækker ' + lbl.da, en: 'no pack in the bank covers ' + lbl.en };
  const last = lastRadarOf(ctx);
  const only = pool.find(p => p && p.code === last);
  if (!only || pool.length > 1) return null;
  return {
    da: lbl.da + ' har kun én bane i banken (' + only.name + ' ' + only.code + '), og den stod i forrige rapport',
    en: lbl.en + ' has only one pack in the bank (' + only.name + ' ' + only.code + '), and it was in the previous report' };
}

/* EET sted afgoer forsvarsvalget, saa pickDefensive og whyNoPick aldrig kan
 * vaelge forskellig zone (runde 1, 7/9): {zone, pack|null, why|null}. */
function resolveDefensive(prof, longRun, ctx){
  if (!prof || !prof.gate || !prof.gate.ok || !prof.dominant) return { zone: null, pack: null, why: null };
  const zone = chooseZone(prof, longRun, ctx);
  const pack = rotate(poolOf(zone, ctx), ctx && ctx.history, lastRadarOf(ctx));
  return { zone, pack, why: pack ? null : poolWhy(zone, ctx) };
}

/* Angreb: de svage zoner proeves i raekkefoelge (laveste rate foerst); er en
 * zones pulje tom eller brugt op, gaar valget videre til den naeste svage
 * zone (runde 1, 7/9 — "aldrig en bane alligevel" gaelder gaten, ikke en
 * udtoemt pulje). why = foerste svage zones grund naar ingen zone gav noget. */
function resolveOffensive(off, ctx){
  if (!off || !off.gate || !off.gate.ok || !Array.isArray(off.weak) || !off.weak.length) return { zone: null, pack: null, why: null };
  const last = lastRadarOf(ctx);
  for (const zone of off.weak){
    const pack = rotate(poolOf(zone, ctx), ctx && ctx.history, last);
    if (pack) return { zone, pack, why: null };
  }
  return { zone: off.weak[0], pack: null, why: poolWhy(off.weak[0], ctx) };
}

/* Forsvarsbane. Zone = dominerende; ved lighed stoerst afvigelse fra
 * langtidsandelen (kun naar longRun.located ≥ 100), derefter rotation.
 * null naar gaten ikke er bestaaet eller puljen er brugt op — begrundelsen
 * hentes med whyNoPick(prof, longRun, ctx) — SAMME argumenter. */
function pickDefensive(prof, longRun, ctx){
  const r = resolveDefensive(prof, longRun, ctx);
  if (!r.pack) return null;
  const zone = r.zone, z = prof.zones[zone];
  return { family: 'def', zone, pack: packOf(r.pack), window: prof.window, week: prof.week,
           counts: { n: prof.n, located: prof.located, zoneN: z.n, share: z.share, ko: prof.ko, noX: prof.noX, noZ: prof.noZ },
           reason: defReason(prof, zone, r.pack) };
}

/* Angrebsbane: den svageste zone (laveste rate) fra offenseProfile hvis pulje
 * giver en bane; ellers naeste svage zone. Begrundelse: whyNoPick(off, null, ctx). */
function pickOffensive(off, ctx){
  const r = resolveOffensive(off, ctx);
  if (!r.pack) return null;
  const zone = r.zone, z = off.zones[zone];
  return { family: 'off', zone, pack: packOf(r.pack), window: off.window, week: off.week,
           counts: { goals: z.goals, touches: z.touches, per100: z.per100, frontGoals: off.front.goals, frontTouches: off.front.touches, frontPer100: off.front.per100, ko: off.ko },
           reason: offReason(off, zone, r.pack) };
}

/* Hvorfor blev der ikke valgt: gaten, tom pulje eller puljen brugt op (eneste
 * bane var forrige rapports). Altid tekst — kontrakten forbyder tavshed.
 * Tager de SAMME argumenter som pickDefensive (angreb: longRun null), og
 * gaar gennem samme resolve-funktion, saa zonen aldrig kan afvige. */
function whyNoPick(prof, longRun, ctx){
  if (!prof) return { da: 'ingen profil', en: 'no profile' };
  if (!prof.gate || !prof.gate.ok) return prof.gate ? prof.gate.reason : { da: 'ingen gate', en: 'no gate' };
  const r = prof.weak ? resolveOffensive(prof, ctx) : resolveDefensive(prof, longRun, ctx);
  if (!r.zone) return prof.gate.reason;
  return r.why || prof.gate.reason;   // der ER et valg — kalderen spurgte forkert
}

/* ---------------- §5: begrundelsens tekst ---------------- */

/* Zonens ord i teksten. Sidezonerne siger "siden af dit forsvar" / "siden af
 * deres tredjedel" uden ±x saa laenge orienteringen ikke er set — ALDRIG
 * venstre/hoejre. D2/O2 siger "bolden var i luften", aldrig "aerial". */
function zoneLabel(id){
  switch (id){
    case 'D1': return { da: 'foran dit mål med bolden på jorden', en: 'in front of your goal with the ball on the ground' };
    case 'D2': return { da: 'foran dit mål mens bolden var i luften', en: 'in front of your goal while the ball was in the air' };
    case 'D3': case 'D4': return { da: 'siden af dit forsvar', en: 'the side of your defence' };
    case 'D5': return { da: 'midterzonen', en: 'the middle zone' };
    case 'D6': return { da: 'deres tredjedel', en: 'their third' };
    case 'O1': return { da: 'foran deres mål med bolden på jorden', en: 'in front of their goal with the ball on the ground' };
    case 'O2': return { da: 'foran deres mål mens bolden var i luften', en: 'in front of their goal while the ball was in the air' };
    case 'O3': case 'O4': return { da: 'siden af deres tredjedel', en: 'the side of their third' };
    case 'O5': return { da: 'midterzonen', en: 'the middle zone' };
    case 'O6': return { da: 'din egen tredjedel', en: 'your own third' };
    default: return { da: String(id), en: String(id) };
  }
}

/* Hvad zonen maaler — skyttens sidste beroering, aldrig hvor spilleren stod. */
function zoneHow(id){
  switch (id){
    case 'D1': return { da: 'skyttens sidste berøring i din tredjedel, mellem stolperne, bolden på jorden', en: "the scorer's last touch in your third, between the posts, ball on the ground" };
    case 'D2': return { da: 'skyttens sidste berøring i din tredjedel, mellem stolperne, bolden var i luften', en: "the scorer's last touch in your third, between the posts, ball in the air" };
    case 'D3': case 'D4': return { da: 'skyttens sidste berøring i din tredjedel, uden for stolperne', en: "the scorer's last touch in your third, outside the posts" };
    case 'D5': return { da: 'skyttens sidste berøring mellem tredjedelslinjerne', en: "the scorer's last touch between the third lines" };
    default: return { da: 'skyttens sidste berøring', en: "the scorer's last touch" };
  }
}

const SOURCE = {
  positions: { da: 'Valgt på banens skud.', en: "Chosen on the pack's shots." },
  tags: { da: 'Valgt på banens tags, ikke på målte skudpositioner.', en: "Chosen on the pack's tags, not on measured shot positions." }
};

/* Erstatningens egen saetning (8/9): en Prejump-bane paa spillerens niveau i stedet
 * for bankens bane(r), som laa uden for vinduet. Tom for bankens egne baner. */
function subNote(pack){
  if (!pack || !pack.substitute) return { da: '', en: '' };
  const d = pack.difficulty || '?';
  const f = pack.substitute.for;
  return {
    da: ' Prejump-bane på ' + d + '-niveau' + (f ? ' i stedet for ' + f.name + ' (' + f.code + '), som ligger uden for dit vindue.' : ' — bankens baner for zonen ligger uden for dit vindue.'),
    en: ' Prejump pack at ' + d + ' level' + (f ? ' instead of ' + f.name + ' (' + f.code + '), which is outside your window.' : ' — the bank\'s packs for this zone are outside your window.')
  };
}

function fmtRate(v, en){
  if (!num(v)) return en ? 'n/a' : 'i/t';
  const r = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  const s = String(r);
  return en ? s : s.replace('.', ',');
}

function defReason(prof, zone, pack){
  const z = prof.zones[zone], lbl = zoneLabel(zone), how = zoneHow(zone);
  const src = SOURCE[pack.confidence === 'positions' ? 'positions' : 'tags'];
  const koDa = prof.ko > 0 ? '; ' + prof.n + ' indkasseret i alt, heraf ' + prof.ko + ' kickoff-mål talt for sig' : '';
  const koEn = prof.ko > 0 ? '; ' + prof.n + ' conceded in all, ' + prof.ko + ' of them kickoff goals counted separately' : '';
  const sub = subNote(pack);
  return {
    da: z.n + ' af ' + prof.located + ' stedfæstede indkasseringer ' + windowWord(prof.window, prof.week, false) + ' kom fra ' + lbl.da
        + ' (' + how.da + koDa + ') → ' + pack.name + ' (' + pack.code + '). ' + src.da + sub.da,
    en: z.n + ' of ' + prof.located + ' located goals conceded ' + windowWord(prof.window, prof.week, true) + ' came from ' + lbl.en
        + ' (' + how.en + koEn + ') → ' + pack.name + ' (' + pack.code + '). ' + src.en + sub.en
  };
}

function offReason(off, zone, pack){
  const z = off.zones[zone], lbl = zoneLabel(zone);
  const src = SOURCE[pack.confidence === 'positions' ? 'positions' : 'tags'];
  const sub = subNote(pack);
  return {
    da: z.touches + ' berøringer i ' + lbl.da + ' gav ' + z.goals + ' mål ' + windowWord(off.window, off.week, false)
        + ' (' + fmtRate(z.per100, false) + ' pr. 100) mod ' + fmtRate(off.front.per100, false) + ' pr. 100 foran målet → '
        + pack.name + ' (' + pack.code + '). ' + src.da + sub.da,
    en: z.touches + ' touches in ' + lbl.en + ' gave ' + z.goals + ' goals ' + windowWord(off.window, off.week, true)
        + ' (' + fmtRate(z.per100, true) + ' per 100) against ' + fmtRate(off.front.per100, true) + ' per 100 in front of goal → '
        + pack.name + ' (' + pack.code + '). ' + src.en + sub.en
  };
}

/* Teksten for et valg (pickDefensive/pickOffensive), for en profil hvis gate
 * ikke er bestaaet, eller for en {da,en}-begrundelse (whyNoPick). lang 'da'
 * eller 'en'; udeladt → motorens sprog (metrics.currentLanguage). */
function reason(pick, lang){
  const en = lang ? lang === 'en' : EN();
  const key = en ? 'en' : 'da';
  if (!pick) return '';
  if (pick.reason && typeof pick.reason === 'object' && pick.pack) return pick.reason[key] || '';
  if (pick.gate && pick.gate.reason) return pick.gate.reason[key] || '';
  if (typeof pick[key] === 'string') return pick[key];
  return '';
}

module.exports = { ZONES, ORIENTATION_VERIFIED, THIRD, POST, AIR_Z, CENTER_R, zoneOf,
                   SESSION_GATE, WEEK_GATE, OFFENSE_GATE, LONGRUN_MIN, POS_MIN_SHOTS, COVER_SHARE, COVER_SHARE_SIDE,
                   packZones, poolFor, profile, offenseProfile, pickDefensive, pickOffensive, whyNoPick, reason, lastRadarOf,
                   zoneLabel, catalogIndex, isHoops, isTooHard };
