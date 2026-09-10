/* RL Director — curated training-pack bank (M4).
 *
 * One place for every training pack the coach is allowed to name, so the
 * session report, the weekly report and the focus card cannot drift apart or
 * invent a code. Codes are NEVER generated: each one is either user-approved
 * from an earlier session or lifted verbatim from pack-catalog.json (Lander1984's
 * rated master list, r/RocketLeagueSchool, harvested 2026-07-27) or
 * pack-catalog-prejump.json (Prejump's public database, same harvest) and
 * verified present in that file before being written here. The check is
 * mechanical too: `node scripts/pack-codes-check.js` fails on any code that is
 * not found verbatim in a catalog.
 *
 * `metrics` is the grounded coupling: which measured metric a pack actually
 * answers. `signals` covers the things that are measured but are not metrics
 * with baselines (goals conceded in the first minute, shot conversion). A pack
 * with neither may only ever be offered as a stated GOAL — see `goalOnly`.
 *
 * Baneradaren (6/9-2026, RADAR-DESIGN.md §4b) tilfoejer tre felter:
 *   zones      — hvilke radar-zoner banen daekker ('D1'..'D5' = skudsted for
 *                indkasserede maal, 'O3'..'O5' = hvor ejeren sjaeldent scorer
 *                fra). Tom liste = banen er ikke en radar-bane.
 *   family     — 'def' | 'off' | null; null naar zones er tom.
 *   confidence — 'tags': zonen er laest af katalogets tags/navn, IKKE af
 *                maalte skudpositioner. Niveauet 'positions' (pack-positions.json,
 *                §4a) kommer senere og deklareres for sig; en 'tags'-bane maa
 *                aldrig praesentere sig som stedmaalt.
 * Katalogerne skelner ikke venstre/hoejre, saa D3 og D4 deler pulje, og det
 * samme goer O3 og O4 (zones lister begge sider udtrykkeligt). D6 og O6 driver
 * aldrig en bane (§3) og har ingen poster.
 *
 * Radar-posterne har metrics: [] og signals: [] MED VILJE: forMetric/forSignal
 * maa ikke faa flere kandidater af dem, for saa flyttede aftenens og ugens
 * nuvaerende udvaelgelse sig. Krogen der bruger forZone() kommer i trin C.
 *
 * The honesty rule that shaped this file: we measure no aerial data at all
 * (nothing in the feed reports air time or height), so an aerial pack can never
 * be justified with a number. It is offered because the player said he wants to
 * learn aerials, and it says so in its own reason line. Radaren aendrer ikke
 * det: D2 er BOLDENS hoejde ved skyttens sidste beroering (z > 150), ikke
 * spillerens luft-tid — teksten siger "bolden var i luften", aldrig "aerial-maal".
 *
 * Tier (8/9-2026, director/tier.js): en tester paa Champion 2 fik Bronze-baner.
 * Hver post baerer nu `tiers` — de tier-navne banen er egnet til. Prejumps
 * difficulty hvor koden findes der; ellers sat manuelt med kilden i kommentaren
 * (Lander-kataloget har ingen difficulty). Hvor Prejump og ejerens brug er
 * uenige (Saves er Champion-ratet hos Prejump, "easier version" hos Lander og
 * ejerens D1-bane paa Silver), er spaendet sat manuelt og siger begge dele —
 * ellers ville Silver-ejeren miste de baner han har maalt effekt af.
 * En bane maa kun foreslaas naar den passer i spillerens vindue [tier-1, tier+1]
 * (tier.fitsTiers); ellers erstattes den med en Prejump-bane med SAMME behov
 * (NEEDS nedenfor: behov -> Prejump-tags) i vinduet, sorteret paa likes. Koden
 * kommer ordret fra pack-catalog-prejump.json, saa reglen "aldrig en opfundet
 * kode" holder, og pack-codes-check.js tjekker at tabellens tags findes.
 */
'use strict';

const T = require('./tier');
/* Alle tiers fra..til (begge med), i skalaens orden. */
const span = (from, to) => T.TIERS.slice(T.indexOf(from), T.indexOf(to) + 1);

const BANK = [
  {
    id: 'ultimate_warmup',
    name: 'The Ultimate Warmup',
    code: 'FA24-B2B7-2E8E-193B',
    // Deliberately coupled to NO metric: it is a mixed everything-pack, so
    // offering it as the targeted answer to one weak number would be a worse
    // recommendation than the drill that actually trains that number. It has a
    // standing slot of its own instead — warming up before queueing is the one
    // habit the player has measured the effect of himself.
    metrics: [],
    signals: [],
    zones: [], family: null, confidence: 'tags',
    tiers: span('Silver', 'Diamond'),   // Prejump: Diamond (Variety/Warmup); Lander 50/50 'everything'; ejeren (Silver) maalte effekten selv 27/7 → sat manuelt Silver..Diamond
    what: 'grundskud, aerials og redirects i én bane — 10-15 min før kø',
    whatEn: 'ground shots, aerials and redirects in one pack — 10-15 min before queueing',
    // Not a claim from an article: the player measured it himself on 27/7-2026 —
    // one hour of warm-up packs, then rank-ups in both 2v2 and 1v1 the same
    // evening. It is his own evidence, and it is cited as his own.
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · rating 50/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'bronze_silver',
    name: 'Bronze/Silver Training',
    code: '2D89-9321-42D2-48BA',
    metrics: ['kickoff_self_ft', 'kickoff_team_ft', 'kickoff_self_speed'],
    // conceding in the first minute is answered by Saves, not by shooting drills
    signals: [],
    zones: [], family: null, confidence: 'tags',
    tiers: ['Bronze'],   // Prejump: Bronze
    what: 'første touch og grundskud',
    whatEn: 'first touch and ground shots',
    source: { title: 'Dignitas: Essential Tips To Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' }
  },
  {
    id: 'first_touch_boot_camp',
    name: 'First Touch Boot Camp',
    code: 'F43A-8231-0B8F-B9FA',
    metrics: ['kickoff_self_ft', 'kickoff_team_ft'],
    signals: [],
    zones: [], family: null, confidence: 'tags',
    tiers: span('Bronze', 'Gold'),   // ikke i Prejump; Lander: 'Easy' → sat manuelt Bronze..Gold
    what: 'ren første-touch-kontrol, let niveau',
    whatEn: 'pure first-touch control, easy level',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool)', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'powershots',
    name: 'Powershots',
    code: '7028-5E10-88EF-E83E',
    metrics: ['hit_power_avg', 'hit_power_max', 'kickoff_self_speed'],
    signals: [],
    zones: [], family: null, confidence: 'tags',
    tiers: span('Silver', 'Platinum'),   // Prejump: Platinum; Dignitas-guiden og ejerens brug siden M1 → sat manuelt Silver..Platinum
    what: 'slagkraft — boost ind i bolden, flip sent',
    whatEn: 'hitting power — boost into the ball, flip late',
    source: { title: 'Dignitas: A Guide to Power Shots (ApparentlyJack)', url: 'https://dignitas.gg/articles/a-guide-to-power-shots-in-rocket-league-with-apparentlyjack' }
  },
  {
    id: 'ground_shots',
    name: 'Ground Shots',
    code: '6EB1-79B2-33B8-681C',
    metrics: ['hit_power_avg'],
    signals: ['conversion'],
    zones: [], family: null, confidence: 'tags',
    tiers: ['Gold'],   // Prejump: Gold
    what: 'placering frem for kraft (gennemført 1×; spillet viser ingen pack-score — trackeren måler runden)',
    whatEn: 'placement over power (completed 1×; the game shows no pack score — the tracker measures the run)',
    source: { title: 'Dignitas: Essential Tips To Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' }
  },
  {
    id: 'shots_you_shouldnt_miss',
    name: "Shots You Shouldn't Miss",
    code: '42BF-686D-E047-574B',
    metrics: [],
    signals: ['conversion'],
    zones: [], family: null, confidence: 'tags',
    tiers: span('Silver', 'Diamond'),   // Prejump: Diamond; Dignitas anbefaler den i 'Get Out Of Silver' → sat manuelt Silver..Diamond
    what: 'afslutning — chancer der SKAL i mål',
    whatEn: 'finishing — chances that MUST go in',
    source: { title: 'Dignitas: Essential Tips To Get Out Of Silver', url: 'https://dignitas.gg/articles/blogs/Unknown/13626/essential-tips-to-get-out-of-silver-a-rocket-league-guide' }
  },
  {
    id: 'saves',
    name: 'Saves',
    code: '2E23-ABD5-20C6-DBD4',
    metrics: [],
    signals: ['earlyConceded', 'conceded'],
    // pack-catalog.json: {"name":"Saves","rating":46,"note":"Easier version of
    // \"Uncomfortable Saves\"","creator":"Poquuto","code":"2E23-ABD5-20C6-DBD4",
    // "category":"DEFENCE"} — redninger foran eget maal paa jorden = D1.
    zones: ['D1'], family: 'def', confidence: 'tags',
    tiers: span('Silver', 'Champion'),   // Prejump: Champion (uden tags); Lander: 'Easier version of Uncomfortable Saves', rating 46; ejerens D1-bane → sat manuelt Silver..Champion
    what: 'redninger — den lette udgave af "Uncomfortable Saves"',
    whatEn: 'saves — the easy version of "Uncomfortable Saves"',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · DEFENCE, rating 46/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'catch_control',
    name: 'Catch & Control Dribble',
    code: '78E7-FDBF-61FB-4EF3',
    metrics: ['off_touch_share', 'touches_per_min'],
    signals: [],
    zones: [], family: null, confidence: 'tags',
    tiers: span('Silver', 'Platinum'),   // Prejump: Platinum; Lander: 'Beginner-friendly' → sat manuelt Silver..Platinum
    what: 'tage bolden ned og beholde den fremme i stedet for at klaske den væk',
    whatEn: 'take the ball down and keep it forward instead of smacking it away',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · begynder-venlig', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'aerial_shots_pass',
    name: 'Aerial Shots - Pass',
    code: 'C7E0-9E0B-B739-A899',
    metrics: [],
    signals: [],
    zones: [], family: null, confidence: 'tags',
    tiers: span('Silver', 'Diamond'),   // Prejump: Diamond; trin 1 i ejerens egen aerial-progression (goalOnly) → sat manuelt Silver..Diamond
    // Trin 1 af den 4-trins aerial-progression brugeren selv har sat som mål.
    goalOnly: 'aerials',
    what: 'trin 1 i aerial-progressionen (derefter Redirects → Backboard Therapy)',
    whatEn: 'step 1 of the aerial progression (then Redirects → Backboard Therapy)',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · AERIALS, rating 48/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },

  /* ---------------- radar-baner, tag-niveau (RADAR-DESIGN.md §4b, 6/9-2026) ----------------
   * Koderne er kopieret ORDRET fra katalogposten der citeres over hver post
   * (pack-catalog-prejump.json medmindre andet staar). difficulty/likes/rating
   * er katalogets egne tal og staar i source.title som kildenote — de er ikke
   * vores maaling. 5CCE-FB29-7B05-A0B1 er udeladt: to navne i katalogerne
   * ("Backward Save Pack" hos Lander1984, "[Why You Suck] Shadow Defense" hos
   * Prejump), og en bane vi ikke kan navngive entydigt maa ikke staa i banken. */

  // --- D1: foran eget maal, jord ---
  {
    id: 'basic_goalie',
    name: 'Basic Goalie',
    code: '8AB4-EEDA-CEAB-4BC4',
    // prejump: {"name":"Basic Goalie","creator":"Wayprotein","code":"8AB4-EEDA-CEAB-4BC4",
    // "difficulty":"Silver","tags":["Saves","Defensive"],"likes":16,"plays":55,"shotCount":16}
    metrics: [],
    signals: [],
    zones: ['D1'], family: 'def', confidence: 'tags',
    tiers: ['Silver'],   // Prejump: Silver
    what: 'grundredninger foran eget mål — 16 skud, let niveau',
    whatEn: 'basic saves in front of your own goal — 16 shots, easy level',
    source: { title: 'Prejump: Basic Goalie (Wayprotein) · Silver, tags Saves/Defensive, 16 likes', url: 'https://prejump.com/training-packs' }
  },
  {
    id: 'novice_defender',
    name: 'Novice Defender',
    code: '87E7-773A-CBE5-B2C3',
    // prejump: {"name":"Novice Defender","creator":"Wayprotein","code":"87E7-773A-CBE5-B2C3",
    // "difficulty":"Bronze","tags":["Good for beginners","Saves","Defensive"],"likes":24,"plays":44,"shotCount":16}
    metrics: [],
    signals: [],
    zones: ['D1'], family: 'def', confidence: 'tags',
    tiers: ['Bronze'],   // Prejump: Bronze
    what: 'redninger fra skæve udgangspositioner foran målet — 16 skud, begynderniveau',
    whatEn: 'saves from awkward starting positions in front of goal — 16 shots, beginner level',
    source: { title: 'Prejump: Novice Defender (Wayprotein) · Bronze, tags Saves/Defensive, 24 likes', url: 'https://prejump.com/training-packs' }
  },

  // --- D2: foran eget maal, bolden i luften (z > 150 ved skyttens sidste beroering) ---
  {
    id: 'aerial_saves',
    name: 'Aerial Saves',
    code: '83A9-D9B8-124C-9F2E',
    // pack-catalog.json: {"name":"Aerial Saves","rating":15,"note":"Easy aerial saves",
    // "creator":"Gwebi","code":"83A9-D9B8-124C-9F2E","category":"DEFENCE"}
    metrics: [],
    signals: [],
    zones: ['D2'], family: 'def', confidence: 'tags',
    tiers: span('Silver', 'Platinum'),   // ikke i Prejump; Lander: 'Easy aerial saves', rating 15 → sat manuelt Silver..Platinum
    what: 'redninger af bolde i luften foran målet — den lette udgave',
    whatEn: 'saves on balls in the air in front of goal — the easy version',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · DEFENCE, rating 15/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'backboard_defense',
    name: 'Backboard Defense',
    code: '607B-45E2-351C-4AD9',
    // pack-catalog.json: {"name":"Backboard Defense","rating":9,"note":"","creator":"Shock",
    // "code":"607B-45E2-351C-4AD9","category":"DEFENCE"}
    metrics: [],
    signals: [],
    zones: ['D2'], family: 'def', confidence: 'tags',
    tiers: span('Gold', 'Diamond'),   // ikke i Prejump; Lander uden difficulty (rating 9); bagvaegs-laesning er brugbar fra Gold → sat manuelt Gold..Diamond
    what: 'bolde der kommer af bagvæggen over dit mål',
    whatEn: 'balls coming off the backboard above your goal',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · DEFENCE, rating 9/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },
  {
    id: 'defensive_backboard_reads',
    name: 'Defensive Backboard Reads',
    code: 'DABC-E5BB-F347-A7BC',
    // pack-catalog.json: {"name":"Defensive Backboard Reads","rating":12,"note":"","creator":"Nathan",
    // "code":"DABC-E5BB-F347-A7BC","category":"DEFENCE"}
    metrics: [],
    signals: [],
    zones: ['D2'], family: 'def', confidence: 'tags',
    tiers: span('Gold', 'Diamond'),   // ikke i Prejump; Lander uden difficulty (rating 12) → sat manuelt Gold..Diamond som Backboard Defense
    what: 'læse bolden af bagvæggen før den lander foran målet',
    whatEn: 'read the ball off the backboard before it drops in front of goal',
    source: { title: 'Lander1984s ratede masterliste (r/RocketLeagueSchool) · DEFENCE, rating 12/50', url: 'https://www.reddit.com/r/RocketLeagueSchool/' }
  },

  // --- D3/D4: egen tredjedel, siden (katalogerne skelner ikke siderne — een pulje) ---
  {
    id: 'back_wall_clears',
    name: 'Back Wall Clears',
    code: '23C2-024C-9C08-CF31',
    // prejump: {"name":"Back Wall Clears","creator":"tRose888","code":"23C2-024C-9C08-CF31",
    // "difficulty":"Gold","tags":["Good for beginners","Defensive","Clears"],"likes":36,"plays":84,"shotCount":10}
    metrics: [],
    signals: [],
    zones: ['D3', 'D4'], family: 'def', confidence: 'tags',
    tiers: ['Gold'],   // Prejump: Gold
    what: 'klaringer fra bagvæggen — starter langsomt, bliver kampagtigt (10 skud)',
    whatEn: 'clears off the back wall — starts slow, gets game-like (10 shots)',
    source: { title: 'Prejump: Back Wall Clears (tRose888) · Gold, tags Defensive/Clears, 36 likes', url: 'https://prejump.com/training-packs' }
  },
  {
    id: 'back_corner_defense',
    name: 'Back Corner Defense',
    code: '58AA-F432-EF05-B964',
    // prejump: {"name":"Back Corner Defense","creator":"SY-25","code":"58AA-F432-EF05-B964",
    // "difficulty":"Gold","tags":["Defensive","Clears"],"likes":8,"plays":8,"shotCount":12}
    metrics: [],
    signals: [],
    zones: ['D3', 'D4'], family: 'def', confidence: 'tags',
    tiers: ['Gold'],   // Prejump: Gold
    what: 'bolde i eget hjørne og på væggen ved siden af målet (12 skud)',
    whatEn: 'balls in your own corner and on the wall beside the goal (12 shots)',
    source: { title: 'Prejump: Back Corner Defense (SY-25) · Gold, tags Defensive/Clears, 8 likes', url: 'https://prejump.com/training-packs' }
  },
  {
    id: 'awkward_corner_clears_rookie',
    name: 'Awkward Corner Clears - Rookie',
    code: 'FD53-3971-1663-A743',
    // prejump: {"name":"Awkward Corner Clears - Rookie","creator":"PopThosePringles","code":"FD53-3971-1663-A743",
    // "difficulty":"Bronze","tags":["recovery","solo play","backboard","defense","clear"],"likes":6,"plays":9,"shotCount":10}
    metrics: [],
    signals: [],
    zones: ['D3', 'D4'], family: 'def', confidence: 'tags',
    tiers: ['Bronze'],   // Prejump: Bronze
    what: 'skæve klaringer fra eget hjørne, begynderniveau (10 skud)',
    whatEn: 'awkward clears from your own corner, beginner level (10 shots)',
    source: { title: 'Prejump: Awkward Corner Clears - Rookie (PopThosePringles) · Bronze, tags defense/clear/backboard, 6 likes', url: 'https://prejump.com/training-packs' }
  },

  // --- D5: midterzonen (langskud, dobbelt-touch; kickoff-maal rapporteres for sig) ---
  {
    id: 'reaction_saves_1',
    name: 'Reaction Saves 1',
    code: '8B58-8583-69F7-7409',
    // prejump: {"name":"Reaction Saves 1","creator":"CINGULATE","code":"8B58-8583-69F7-7409",
    // "difficulty":"Gold","tags":["Saves","Defensive"],"likes":13,"plays":30,"shotCount":50}
    metrics: [],
    signals: [],
    zones: ['D5'], family: 'def', confidence: 'tags',
    tiers: ['Gold'],   // Prejump: Gold
    what: 'reaktionsredninger på skud fra afstand — 50 skud',
    whatEn: 'reaction saves on shots from range — 50 shots',
    source: { title: 'Prejump: Reaction Saves 1 (CINGULATE) · Gold, tags Saves/Defensive, 13 likes', url: 'https://prejump.com/training-packs' }
  },

  // --- O3/O4: siden af deres tredjedel (een pulje, samme grund som D3/D4) ---
  {
    id: 'sidewalls_corner',
    name: 'Sidewalls+Corner',
    code: 'A2A3-7B0E-5EBA-0A8C',
    // prejump: {"name":"Sidewalls+Corner","creator":"Revive Panther <:","code":"A2A3-7B0E-5EBA-0A8C",
    // "difficulty":"Bronze","tags":["Ground Shots","Good for beginners","Offensive"],"likes":6,"plays":18,"shotCount":10}
    metrics: [],
    signals: [],
    zones: ['O3', 'O4'], family: 'off', confidence: 'tags',
    tiers: ['Bronze'],   // Prejump: Bronze
    what: 'afslutninger fra sidevæggen og hjørnet, jordskud (10 skud)',
    whatEn: 'finishes from the side wall and the corner, ground shots (10 shots)',
    source: { title: 'Prejump: Sidewalls+Corner (Revive Panther <:) · Bronze, tags Ground Shots/Offensive, 6 likes', url: 'https://prejump.com/training-packs' }
  },
  {
    id: 'side_walls',
    name: 'side walls',
    code: 'CE38-1171-9B59-2CEE',
    // prejump: {"name":"side walls","creator":"@stx.","code":"CE38-1171-9B59-2CEE",
    // "difficulty":"Bronze","tags":["Good for beginners","Offensive"],"likes":6,"plays":4,"shotCount":8}
    metrics: [],
    signals: [],
    zones: ['O3', 'O4'], family: 'off', confidence: 'tags',
    tiers: ['Bronze'],   // Prejump: Bronze
    what: 'skud fra sidevæggen mod mål, begynderniveau (8 skud)',
    whatEn: 'shots from the side wall towards goal, beginner level (8 shots)',
    source: { title: 'Prejump: side walls (@stx.) · Bronze, tags Offensive, 6 likes', url: 'https://prejump.com/training-packs' }
  },
  {
    id: 'angles_and_speed',
    name: 'Angles and Speed',
    code: 'BA6A-E820-2755-7D18',
    // prejump: {"name":"Angles and Speed","creator":"s l y z :>","code":"BA6A-E820-2755-7D18",
    // "difficulty":"Bronze","tags":["Ground Shots","Offensive"],"likes":5,"plays":6,"shotCount":10}
    metrics: [],
    signals: [],
    zones: ['O3', 'O4'], family: 'off', confidence: 'tags',
    tiers: ['Bronze'],   // Prejump: Bronze
    what: 'jordskud fra skæve vinkler i fart (10 skud)',
    whatEn: 'ground shots from sharp angles at speed (10 shots)',
    source: { title: 'Prejump: Angles and Speed (s l y z :>) · Bronze, tags Ground Shots/Offensive, 5 likes', url: 'https://prejump.com/training-packs' }
  },
  {
    id: 'challenger_training_pack',
    name: 'Challenger Training Pack',
    code: '7757-0B3B-E4BB-8CA8',
    // prejump: {"name":"Challenger Training Pack","creator":"VincenzoTheGooch","code":"7757-0B3B-E4BB-8CA8",
    // "difficulty":"Silver","tags":["Offensive","Long shots","Tight angles"],"likes":5,"plays":2,"shotCount":16}
    // Tagget "Tight angles" saetter den i siden (kontraktens O3/O4); tagget
    // "Long shots" er det samme der saetter Ground and Pound i O5, saa den
    // staar ogsaa der — ellers havde O5 kun een bane og ingen rotation.
    metrics: [],
    signals: [],
    zones: ['O3', 'O4', 'O5'], family: 'off', confidence: 'tags',
    tiers: ['Silver'],   // Prejump: Silver
    what: 'langskud og skud fra snævre vinkler (16 skud)',
    whatEn: 'long shots and shots from tight angles (16 shots)',
    source: { title: 'Prejump: Challenger Training Pack (VincenzoTheGooch) · Silver, tags Offensive/Long shots/Tight angles, 5 likes', url: 'https://prejump.com/training-packs' }
  },

  // --- O5: midterzonen set fra angrebet (langskud) ---
  {
    id: 'ground_and_pound',
    name: 'Ground and Pound',
    code: 'BE6A-1460-F594-93A9',
    // prejump: {"name":"Ground and Pound","creator":"COACH FRESCO","code":"BE6A-1460-F594-93A9",
    // "difficulty":"Gold","tags":["Offensive","Long shots","Tight angles"],"likes":4,"plays":8,"shotCount":7}
    metrics: [],
    signals: [],
    zones: ['O5'], family: 'off', confidence: 'tags',
    tiers: ['Gold'],   // Prejump: Gold
    what: 'langskud fra midterzonen langs jorden (7 skud)',
    whatEn: 'long ground shots from the middle third (7 shots)',
    source: { title: 'Prejump: Ground and Pound (COACH FRESCO) · Gold, tags Offensive/Long shots/Tight angles, 4 likes', url: 'https://prejump.com/training-packs' }
  }
];

const BY_ID = new Map(BANK.map(p => [p.id, p]));

function byId(id){
  const p = BY_ID.get(id);
  if (!p) throw new Error('ukendt træningsbane-id: ' + id);   // fail loud: a wrong code is worse than a crash
  return p;
}

/* Packs whose grounded coupling includes this metric, best first.
 * Order in BANK is the tie-break, so the same weakness always suggests the
 * same primary pack until rotation moves it. */
function forMetric(id){ return BANK.filter(p => p.metrics.includes(id)); }
function forSignal(sig){ return BANK.filter(p => (p.signals || []).includes(sig)); }

/* ---------------- radar-zoner (RADAR-DESIGN.md §4b) ---------------- */

/* Zonerne der KAN drive en bane. D6/O6 og O1/O2 staar her med vilje ikke:
 * de driver aldrig en bane (§3), og forZone() paa dem giver en tom pulje —
 * aldrig en fejl, for krogen skal kunne spoerge om en vilkaarlig maalt zone. */
const RADAR_ZONES = ['D1', 'D2', 'D3', 'D4', 'D5', 'O3', 'O4', 'O5'];
/* Siderne deler pulje (ingen katalogpost skelner venstre/hoejre). Posterne
 * lister begge sider udtrykkeligt; parret her er kontrakten testen holder
 * dem op imod. */
const SHARED_SIDES = [['D3', 'D4'], ['O3', 'O4']];

/* Puljen for een zone, i BANK-orden (rotationens tie-break, som forMetric). */
function forZone(zoneId){ return BANK.filter(p => (p.zones || []).includes(zoneId)); }

/* Alle puljer paa een gang, {zoneId: [code...]} — til tests og replay-udskrift. */
function zonePools(){
  const out = {};
  for (const z of RADAR_ZONES) out[z] = forZone(z).map(p => p.code);
  return out;
}

/* ---------------- tier (8/9-2026): behov -> Prejump-tags, erstatning ----------------
 *
 * Bankens poster passer ejeren (Silver). En spiller paa et andet niveau faar
 * samme BEHOV besvaret med en bane paa sit eget niveau: en Prejump-bane hvis
 * tags matcher behovet og hvis difficulty ligger i spillerens vindue
 * (tier.js). Koden er katalogets egen — aldrig opfundet — og begrundelsen
 * siger baade behovet, banens eget niveau og at den erstatter bankens bane.
 * En Prejump-bane maa kun staa som svar paa et MAALT tal naar dens tags
 * matcher behovet (tabellen her); alt andet er afveksling og siger det selv. */

const fs = require('fs');
const path = require('path');

/* Behov -> Prejump-tags. Noeglerne er de behov krogene kender: metrik-id'er
 * (metrics.js DEFS), signaler (earlyConceded/conceded/conversion), radar-zoner
 * (D1..O5) og de faste roller (warmup; aerials = ejerens ERKLAEREDE maal, ingen
 * maaling, samme aerlighedsregel som goalOnly; variety = ren afveksling).
 *   groups — hver gruppe skal ramme mindst eet af banens tags (OG mellem
 *            grupper, ELLER inden i en gruppe); tags staves som Prejump
 *            staver dem (store/smaa bogstaver er ligegyldige) — scripts/
 *            pack-codes-check.js fejler paa et tag kataloget ikke kender
 *   name   — alternativ til tags: navnet alene raekker (Prejump har intet
 *            Kickoff-tag, men 15 baner hedder "...Kickoff...")
 *   prefer — navne der sorteres foerst, foer likes (kun med mindst PREFER_MIN_LIKES
 *            likes: et praecist navn med 0 likes maa ikke slaa en bane 100 spillere synes om)
 *   what/whatEn — behovets ord i begrundelsen; banens niveau og likes
 *            foelger efter, saa erstatningen aldrig ligner bankens bane */
const SAVES = ['Saves', 'save', 'Defensive', 'defense'];
const KICKOFF = { groups: [['First touch']], name: /kickoff/i, prefer: /kickoff/i, what: 'første touch på kickoffs', whatEn: 'first touch on kickoffs' };
const POWER = { groups: [['Focus on power', 'Focus on speed']], name: /power ?shots?/i, prefer: /power/i, what: 'slagkraft', whatEn: 'hitting power' };
const CONTROL = { groups: [['Dribbling', 'Focus on control', 'Flicks']], prefer: /catch|control|dribbl/i, what: 'boldkontrol fremad', whatEn: 'ball control going forward' };
const SAVING = { groups: [SAVES], prefer: /save/i, what: 'redninger', whatEn: 'saves' };
const SIDE_CLEARS = { groups: [['Clears', 'clear']], prefer: /corner|back ?wall|side/i, what: 'klaringer fra siden af eget forsvar', whatEn: 'clears from the side of your own defence' };
const SIDE_SHOTS = { groups: [['Ground Shots', 'Wall Shots', 'Off the wall', 'wall', 'Tight angles'], ['Offensive']], prefer: /corner|side ?wall|angle/i, what: 'afslutninger fra siden', whatEn: 'finishes from the side' };
const NEEDS = {
  kickoff_self_ft: KICKOFF,
  kickoff_team_ft: KICKOFF,
  kickoff_self_speed: Object.assign({}, POWER, { prefer: /kickoff|power/i }),
  hit_power_avg: POWER,
  hit_power_max: POWER,
  off_touch_share: CONTROL,
  touches_per_min: CONTROL,
  conversion: { groups: [['Ground Shots', 'Focus on placement', '1 Touch']], prefer: /placement|accura|finish/i, what: 'afslutning', whatEn: 'finishing' },
  earlyConceded: SAVING,
  conceded: SAVING,
  warmup: { groups: [['Warmup']], prefer: /warm/i, what: 'opvarmning', whatEn: 'warm-up' },
  aerials: { groups: [['Aerials', 'aerial']], prefer: /aerial/i, what: 'aerials (dit eget mål, ingen måling)', whatEn: 'aerials (your own goal, no measurement)' },
  variety: { groups: [['Variety']], what: 'blandet træning', whatEn: 'mixed training' },
  D1: { groups: [SAVES], prefer: /goalie|save/i, what: 'redninger foran eget mål', whatEn: 'saves in front of your own goal' },
  D2: { groups: [SAVES, ['Aerials', 'aerial', 'Aerial control', 'Backboards', 'backboard', 'back wall']], prefer: /aerial|backboard/i, what: 'redninger på bolde i luften', whatEn: 'saves on balls in the air' },
  D3: SIDE_CLEARS,
  D4: SIDE_CLEARS,
  D5: { groups: [SAVES], prefer: /reaction|long/i, what: 'reaktionsredninger på skud fra afstand', whatEn: 'reaction saves on shots from range' },
  O3: SIDE_SHOTS,
  O4: SIDE_SHOTS,
  O5: { groups: [['Long shots'], ['Offensive']], prefer: /long/i, what: 'langskud fra midterzonen', whatEn: 'long shots from the middle third' }
};

const PREFER_MIN_LIKES = 5;
const norm = s => String(s || '').trim().toLowerCase();
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const tagsOf = p => Array.isArray(p && p.tags) ? p.tags.map(norm) : [];
const hasTag = (p, group) => { const t = tagsOf(p); return group.some(g => t.includes(norm(g))); };
/* Hoops = anden maalgeometri (ringe), Non-standard Map = ikke banen — aldrig. */
const isHoops = p => /hoops/i.test((p && p.name) || '') || tagsOf(p).includes('hoops');
const isNonStandard = p => tagsOf(p).includes('non-standard map');

/* Matcher en katalogpost behovet? Alle grupper skal rammes, ELLER navnet
 * alene naar behovet har et name-moenster. Ukendt behov -> aldrig. */
function matchesNeed(p, need){
  const n = NEEDS[need];
  if (!n || !p) return false;
  if (n.groups.every(g => hasTag(p, g))) return true;
  return !!(n.name && n.name.test(String(p.name || '')));
}

/* pack-catalog-prejump.json laest een gang pr. proces; mangler filen, er der
 * ingen erstatninger (aldrig et crash — saa staar behovet uden bane). */
let PREJUMP = null;
function loadPrejump(){
  if (PREJUMP) return PREJUMP;
  try{
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'pack-catalog-prejump.json'), 'utf8'));
    PREJUMP = Array.isArray(j && j.packs) ? j.packs : [];
  }catch{ PREJUMP = []; }
  return PREJUMP;
}

/* Passer bank-posten i spillerens vindue (tier.fitsTiers paa `tiers`)? */
function fits(pack, info){ return T.fitsTiers(info, pack && pack.tiers, pack && pack.name); }

/* Kandidater fra Prejump for et behov i spillerens vindue: kendt difficulty i
 * vinduet (ukendt niveau er ikke "i vinduet" — en erstatning skal KUNNE
 * siges at vaere paa niveau), ikke Hoops/Non-standard Map, matcher behovet.
 * Orden: prefer-navne foerst, saa likes, plays, navn, kode — deterministisk,
 * saa et replay giver samme bane. `exclude` = koder der allerede er i brug. */
function candidates(need, info, opts){
  const o = opts || {};
  const cat = Array.isArray(o.catalog) ? o.catalog : loadPrejump();
  const win = (info && Array.isArray(info.window) && info.window.length ? info : T.DEFAULT_INFO).window;
  const n = NEEDS[need];
  if (!n) return [];
  const ex = new Set(o.exclude ? Array.from(o.exclude) : []);
  const out = [];
  for (const p of cat){
    if (!p || !p.code || ex.has(p.code)) continue;
    const t = T.tierOf(p.difficulty);
    if (!t || !win.includes(t)) continue;
    if (isHoops(p) || isNonStandard(p)) continue;
    if (!matchesNeed(p, need)) continue;
    out.push(p);
  }
  const pref = n.prefer || null;
  const pr = p => pref && (p.likes | 0) >= PREFER_MIN_LIKES && pref.test(String(p.name || '')) ? 1 : 0;
  out.sort((a, b) => (pr(b) - pr(a)) || ((b.likes | 0) - (a.likes | 0)) || ((b.plays | 0) - (a.plays | 0)) || cmp(norm(a.name), norm(b.name)) || cmp(a.code, b.code));
  return out;
}

/* En Prejump-post som bank-lignende post. `substitute` siger hvad den erstatter,
 * saa begrundelsen og HTML'en kan sige det; `difficulty` er katalogets ord. */
function entryOf(p, need, forPack){
  const n = NEEDS[need];
  const d = T.tierOf(p.difficulty);
  const tags = (Array.isArray(p.tags) ? p.tags : []).slice(0, 4).join('/');
  const likes = p.likes | 0;
  return {
    id: 'prejump:' + p.code, name: p.name, code: p.code, difficulty: d, tiers: [d], tags: (Array.isArray(p.tags) ? p.tags : []).slice(), likes,
    metrics: [], signals: [], zones: [], family: null, confidence: 'tags',
    substitute: { need, for: forPack ? { id: forPack.id, name: forPack.name, code: forPack.code, tiers: (forPack.tiers || []).slice() } : null },
    what: n.what + ' — Prejump-bane på ' + d + '-niveau' + (tags ? ' (tags ' + tags + ', ' : ' (') + likes + ' likes)',
    whatEn: n.whatEn + ' — Prejump pack at ' + d + ' level' + (tags ? ' (tags ' + tags + ', ' : ' (') + likes + ' likes)',
    source: { title: 'Prejump: ' + p.name + (p.creator ? ' (' + p.creator + ')' : '') + ' · ' + d + (tags ? ', tags ' + tags : '') + ', ' + likes + ' likes', url: 'https://prejump.com/training-packs' }
  };
}

/* De `count` bedste erstatninger for behovet i vinduet (tom liste = ingen). */
function substitute(need, info, opts){
  const o = opts || {};
  const count = Math.max(1, o.count | 0);
  return candidates(need, info, o).slice(0, count).map(p => entryOf(p, need, o.for || null));
}

/* Bank-posten selv naar den passer spillerens vindue, ellers den bedste
 * erstatning for `need` — eller null naar Prejump intet har i vinduet. */
function fitOrSubstitute(pack, need, info, opts){
  if (fits(pack, info)) return pack;
  const s = substitute(need, info, Object.assign({}, opts || {}, { for: pack }));
  return s.length ? s[0] : null;
}

/* Radar-puljens erstatninger for een zone, formet som bankens zone-poster
 * (zones med sidemakkeren, family fra zonen), saa radar.poolFor kan tage dem. */
function substitutesForZone(zone, info, opts){
  const pair = SHARED_SIDES.find(s => s.includes(zone));
  const zones = pair ? pair.slice() : [zone];
  return substitute(zone, info, opts).map(e => Object.assign(e, { zones, family: zone[0] === 'D' ? 'def' : 'off' }));
}

module.exports = { BANK, byId, forMetric, forSignal, forZone, zonePools, RADAR_ZONES, SHARED_SIDES,
                   NEEDS, span, fits, matchesNeed, candidates, substitute, fitOrSubstitute, substitutesForZone, loadPrejump };
