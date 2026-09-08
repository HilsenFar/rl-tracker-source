/* RL Director — skud-projektion for traeningsbaner (RADAR-DESIGN.md §4a, 6/9-2026).
 *
 * Ren geometri, ingen I/O, intet ur. Deles af importeren
 * (scripts/import-pack-positions.mjs), linten (scripts/pack-positions-check.js)
 * og testen (director/test/pack-positions.test.js), saa SAVE/SHOT-dommen kun
 * findes eet sted.
 *
 * Reglen: projicer boldbanen fra dens spawn (location + velocity) frem til
 * ejerens maalplan y = -5120 (banen er blaa spillers i traening: eget maal i
 * minus-enden, deres i plus-enden). Rammer bolden maalmunden (|x| < 893,
 * z < 643) inden for 4 s → 'save', ellers 'shot'. ALDRIG kun fortegnet paa
 * vy: 6EB1-79B2-33B8-681C har 11 drills med vy < 0 der alle er skud — bolden
 * ruller lidt mod skytten men naar hverken planet i tide eller munden.
 *
 * Bevidst simpel fysik (som kontrakten): konstant vy (ingen luftmodstand),
 * tyngde 650 uu/s² paa z, sidevaegge = spejl i x ved |x| = 4096. Gulvet
 * klemmes til 0 — en bold der ville vaere hoppet ligger stadig lavt, og lavt
 * er det eneste dommen bruger z til. Ingen bounce paa bagvaeggen: naar bolden
 * naar y = -5120 uden for munden, er den et skud (den kan ikke ramme maalet
 * uden foerst at have vaeret i planet). */
'use strict';

const G = 650;             // uu/s², spillets tyngde
const HORIZON = 4;         // s — naar bolden ikke planet paa 4 s, truer den ikke
const WALL_X = 4096;       // sidevaeggenes x
const GOAL_Y = -5120;      // ejerens maalplan
const POST = 893;          // maalets halve bredde (RLBot 892,755)
const CROSSBAR = 643;      // overliggerens underkant (RLBot 642,775)
const KINDS = ['save', 'shot'];

/* Spejl x i sidevaeggene: [-4096, 4096] → sig selv, 4096+d → 4096-d, osv.
 * Trekantboelge med periode 4·WALL_X, saa flere bounces ogsaa folder rigtigt. */
function foldX(x){
  const p = 4 * WALL_X;
  let m = ((x + WALL_X) % p + p) % p;      // 0..p, nulpunkt ved -WALL_X
  if (m > p / 2) m = p - m;                // spejl den anden halvdel
  return m - WALL_X;
}

/* Boldens skaering med maalplanet: {t, x, z} eller null naar den aldrig naar
 * planet inden for horisonten (vy >= 0, eller for langsom). */
function project(ball, vel){
  if (!(vel.y < 0)) return null;
  const t = (GOAL_Y - ball.y) / vel.y;
  if (!(t >= 0) || t > HORIZON) return null;
  const x = foldX(ball.x + vel.x * t);
  const z = Math.max(0, ball.z + vel.z * t - 0.5 * G * t * t);
  return { t, x, z };
}

function kindOf(ball, vel){
  const hit = project(ball, vel);
  return hit && Math.abs(hit.x) < POST && hit.z < CROSSBAR ? 'save' : 'shot';
}

/* Skyttens position: foerste spiller med role 'shooter', ellers foerste
 * spiller (aeldre uploads uden roller). null uden spillere. */
function shooterOf(players){
  if (!Array.isArray(players) || !players.length) return null;
  const s = players.find(p => p && p.role === 'shooter') || players[0];
  return s && s.location ? s.location : null;
}

const xyz = o => ({ x: o.x, y: o.y, z: o.z });

/* Eet skud af en drill fra daftpenguin/trainingpacks-formatet. Ingen zone —
 * den regnes ved indlaesning af radar.js (zoneOf), saa en aendret zonegraense
 * aldrig kraever en ny import. */
function shotFromDrill(drill){
  const ball = xyz(drill.ball.location), vel = xyz(drill.ball.velocity);
  const car = shooterOf(drill.players);
  return { ball, vel, car: car ? xyz(car) : null, kind: kindOf(ball, vel) };
}

module.exports = { G, HORIZON, WALL_X, GOAL_Y, POST, CROSSBAR, KINDS, foldX, project, kindOf, shooterOf, shotFromDrill };
