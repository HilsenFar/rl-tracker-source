# RL Live Tracker

Portable live stats tracker for Rocket League. One HTML file plus a
zero-dependency Node server — works fully offline. Data comes from Rocket
League's official local **Stats API**. The server listens on this machine only
by default; `HOST=0.0.0.0` opens it to LAN devices.

**Reality check (verified against the live game, July 2026):** despite the
official docs calling it a WebSocket, the Stats API is a **raw TCP stream** of
back-to-back JSON objects (and `Data` is double-JSON-encoded). Browsers cannot
read raw TCP, so live game data flows through the companion server's TCP→SSE
bridge. The single HTML file alone still gives you demo mode, stored history,
rank tracking and exports.

## Quick start

1. Enable the game's Stats API once:
   - Close Rocket League.
   - Open `<install dir>\TAGame\Config\DefaultStatsAPI.ini`
     - Steam: `...\Steam\steamapps\common\rocketleague\TAGame\Config\`
     - Epic: `...\Epic Games\rocketleague\TAGame\Config\`
   - Set `PacketSendRate` to `120` (0 = disabled; 120 is the game's own cap and
     what the movement metrics are calibrated for). Keep `Port` at `49123`.
   - Start the game.
   - Game updates occasionally reset this file to `PacketSendRate=0`. The
     tracker guards against it: it finds the ini via the Epic launcher's
     manifests, repairs the rate automatically and tells you on the board if
     the game needs a restart. Unusual install locations can point the guard
     with the `STATSAPI_INI` environment variable.

Updates: the tracker checks once a day whether a newer release exists
(github.com/HilsenFar/rl-tracker-releases — a single anonymous GitHub API
call, no player data ever leaves your PC) and shows a quiet card on the
board linking the download page. Disable with `"updateCheck": false` in
`director-ai.json` or the `UPDATE_CHECK=0` environment variable.
2. Run `node server.js` and open `http://localhost:8341/`.
3. The tracker auto-connects while a match is running (online, offline or LAN).
   Click your own row once to track your personal stats across matches.

## Ranks ("own tracking" model)

The Stats API feed carries **no rank/MMR fields** (verified empirically), and
since Easy Anti-Cheat became mandatory for online play, BakkesMod cannot run in
online matches. The rank card therefore uses an honest self-tracking model:

- Anchor your rank/division as the game shows it (Set rank).
- The app auto-counts your W/L per playlist (by team size) and shows net wins
  since the last division change.
- Tap **▲ Div up / ▼ Div down** when the game shows a division change — the app
  builds your personal progression history ("last div up: net +4 over 9 games").
- Emblems come from the locally installed RocketStats plugin images (served as
  PNG via the companion server) with original SVG fallbacks.

**Offline/LAN sessions** (game launched without EAC): the RocketStats
BakkesMod plugin broadcasts live MMR on `ws://localhost:8085`; the tracker
lights up the MMR panel automatically. Never use EAC workarounds online — ban
risk.

## Rank badges on every player

Each player row shows a rank badge (e.g. `D2` = Diamond II; hover for
division + MMR) so you can read the lobby mid-match. Because the local feed
has no rank data, badges use an **online lookup** via the companion server.
Two sources, in order of preference:

### Default: the gitato relay — since 18/8-2026

Out of the box the companion server asks `https://collect.gitato.net/v1/rank`
(`director/rankrelay.js`), which reads ranks straight from Rocket League's own
backend through one shared reader account: exact tier, division and MMR for the
whole lobby in one call, no daily limit, and your own MMR after every match (the
debrief line shows the delta, the weekly curve gets one point per match).
Nothing to set up. What leaves the machine: the lobby's player ids. Turn it off
with `RANK_RELAY=off` or `"rankRelay": false` in `director-ai.json`.

### Optional: your own reader account (game backend)

The same lookup can run from this machine (`director/psynet.js`), independent
of the relay — it then takes precedence. It signs in as a **separate, free Epic
account** — one account allows only one session, so your playing account must
never be used here (it would disconnect the game). The reader account never has
to start the game.

1. Create a free Epic account for the tracker.
2. Setup → **Rank lookup (online)** → open the Epic login link in a *private*
   browser window, sign in as the reader account, copy the `authorizationCode`
   from the small JSON page and paste it into the tracker. Once.
3. The login is kept in `psynet-auth.json` next to the server (never served,
   never zipped) and renews itself for a year while the tracker is in use.

What leaves the machine: the reader account's login and the lobby's player ids.
`PsyBuildID`/`FeatureSet` change with every game patch; the module reads the
current values out of `RocketLeague.exe` itself, so a patch does not switch
badges off. If neither the relay nor a reader session answers, the RapidAPI
fallback below takes over automatically.

### Fallback: RapidAPI key

1. Create a free account on rapidapi.com
2. Subscribe to "Rocket League API" (`rocket-league10`, free plan)
3. Paste your `X-RapidAPI-Key` under **Setup → Opponent rank lookup**

The provider is keyed by **platform + in-game name** (`/stats/epic/DXXØ`), so that
is what leaves the machine — the five platforms it serves are epic, steam,
playstation, xbox and switch, and Steam alone is looked up by its id64. A player
whose platform the feed reports as `Unknown` is never sent anywhere.

The key stays in your browser. The free plan allows only **10 player lookups per
day** and a 3v3 lobby holds six players, so a successful lookup is cached for
**30 days** per player on both client and server — the server's cache persists to
disk and survives restarts, and opponents are looked up before teammates. A
player the provider has never heard of (404) is remembered as unknown for a week,
so the same six strangers cannot eat a day's quota every evening; a rename
re-opens the question. Failed lookups are retried after ~10 min, and a 429 (or a
403 from a lapsed subscription) pauses lookups for an hour rather than burning
the quota on retries. The daily counter follows the provider's own
`x-ratelimit-requests-remaining`, so it stays right across restarts and after
lookups made from the RapidAPI console. When the day's quota is spent, badges
show `?` until the next day; the same happens without a key (your own badge falls
back to your Rank card anchor). Demo mode uses a built-in mock provider through
the same pipeline.

Click a player row to **track** that player: the tracker records their
goals/assists/saves/shots/demos/points per match, W–L record and match history
(stored locally, exportable as JSON/CSV). Press **▶ Demo** to see the UI with a
simulated match.

## Companion server (live bridge + online extras)

`node server.js` (Node 22+, no dependencies) serves the tracker at
`http://localhost:8341/`. Node 18-21 also runs it, but rank lookups then go
through the relay or RapidAPI only; a reader account of your own (PsyNet)
needs the built-in WebSocket that arrived in Node 22.

Tests: `node scripts/run-tests.js` runs every `director/test/*.test.js` file
(no network, nothing written outside the temp directory).

**This machine only, by default.** The server binds `127.0.0.1`, because it
holds your RapidAPI key and your personal telemetry and `/api/playerranks` has
no authentication — on an open port anyone on the network could spend your
10 lookups/day. The board and the overlay both run locally, so normal use needs
nothing more. To open a board on another device, start it with `HOST=0.0.0.0`
(`set HOST=0.0.0.0` before `Start-RL-Tracker.bat`); replacing the stored key
stays restricted to this machine either way.

**The server is not optional for live play.** A browser cannot read the game's
raw TCP feed, so everything live comes through it:

- **Live match data** — the TCP→SSE bridge (`/api/stream`). One shared upstream
  connection per game endpoint feeds every open page plus the telemetry recorder.
- **Rank badges and emblems** — `/api/playerranks`, `/api/rankimg/<name>.png`
- **The Director** — between-match debrief (`/api/debrief`), after-session report
  (`/api/session`) and today's focus with its live meter (`/api/focus`)

Rank lookups, the optional voice layer and the daily update check are the only
parts that need the internet; everything else runs offline. Opened as a bare
HTML file the tracker still works, just standalone: demo mode, stored history,
self-anchored rank tracking with the built-in SVG emblems, and JSON/CSV export.

Only the page's own assets and the generated reports are served. Everything else
in the folder — the rank cache (which holds your API key), the Director's profile
and the match archive — is refused, so the allow-list still holds if you ever
open the server to the network with `HOST=0.0.0.0`. Adding a new file the page
must fetch means adding it to `PUBLIC_FILES` in `server.js`.

## Overlay (én skærm)

Spiller du på én skærm, kan trackerens kort ligge oven på spillet — start det
med `Start-Overlay.bat` i portable-mappen.

Siden 23/8-2026 er overlayet et **gennemsigtigt vindue** (`RLOverlay.exe`,
kilde i `overlay-host/`): kun kortene tegnes, og hver anden pixel er spillet
bagved — intet bånd, ingen titelbjælke, ingen ramme. Det viser den samme side
som altid (`?overlay&glass`) i en WebView2, så designet vedligeholdes ét sted.

- Kræver at Rocket League kører i **Borderless** eller **Windowed**
  (fullscreen-exclusive tegner over alt andet).
- ToS-rent: et separat vindue oven på spillet — ingen injection, og der
  ændres intet i spillets filer.
- **Flyt det:** hold `Alt` nede og træk, eller træk med midterste museknap.
  Positionen huskes i `overlay-glass.json`.
- **Luk det:** højreklik på bakke-ikonet → *Luk overlay* (eller
  `Stop-Overlay.bat`). Samme menu har *Klik gaar igennem*, hvis musen skal
  kunne ramme spillet gennem kortene.
- Start et bestemt sted: `Start-Overlay.bat -X 380 -Y 960`.

Mangler WebView2-runtimen (den følger med Edge og er der på enhver opdateret
Windows), falder `Start-Overlay.bat` tilbage til det gamle Chrome-vindue. Det
kan **ikke** være gennemsigtigt — målt 23/8-2026 med skærmkopi som facit:
color-key bider ikke (fladen stod malet, RGB 1,1,1), `SetWindowRgn` klipper
kun Chromes egen tegning mens vinduets flade stadig males, og et
fullscreen-startet app-vindue (som er uden titelbjælke) nægter at krympe
bagefter. Chrome-udgaven syr derfor vinduet stramt om kortene i stedet, og
Chromes egen 30 px titelbjælke bliver stående. Den tager fortsat `-Alpha`,
`-ClickThrough` og `-X -Y -W -H` (`overlay-pos.json`).

## Coachen (RL Director) — virker uden AI, taler pænere med

Coachen er indbygget og kører **helt uden AI-nøgler**: efter hver kamp får du en
3-linjers debrief målt mod dine egne baselines, efter hver session en rapport
med trends/missioner/træningsbaner, og hver uge en fremgangsrapport med
bevis-sektion. Alt dette er deterministisk og lokalt.

**Valgfrit AI-lag (naturligt sprog):** serveren opretter `director-ai.json` ved
første start. Åbn den og sæt `provider` — tre gratis-venlige muligheder:

```json
{ "provider": "ollama",
  "providers": { "ollama": { "key": "", "model": "gemma3:12b" } } }
```

- **Ollama (lokal, gratis, ingen nøgle):** installér Ollama, `ollama pull gemma3:12b`,
  sæt `"provider": "ollama"`. OBS (målt): Ollamas /v1-endpoint afkorter lange
  systemprompter *stille* på små GPU'er — kommer debriefs på engelsk, lav en
  afledt model med `PARAMETER num_ctx 8192` i en Modelfile.
- **NVIDIA NIM (gratis dev-konto):** nøgle fra build.nvidia.com i
  `providers.nvidia.key`, `"provider": "nvidia"`. Kørt i drift med
  `openai/gpt-oss-20b` + `"extraBody": {"reasoning_effort": "low"}`.
- **Anthropic:** nøgle i `providers.anthropic.key`, `"provider": "anthropic"`.

AI'en må kun **omformulere** — hvert tal valideres mod kampens data før det
vises, og fejler kaldet, står skabelon-debriefen der allerede. Nøglefilen
serveres aldrig over HTTP og pakkes aldrig i zips.

## Testversion: feedback

Denne udgave er en test-build, og dine kamp-data hjælper med at kalibrere
coachen. To måder — begge fuldt gennemsigtige:

- **Automatisk (hvis `feedback.json` ligger i mappen):** kamp-digests og
  rapporter deles i baggrunden til en **privat** GitHub-repo hos udvikleren.
  Sendes ALDRIG: API-nøgler (rank/AI) — og dine personlige kamp-mærker kun
  hvis `includeLabels` er sat til true af dig selv. Serverloggen siger tydeligt
  ved opstart at deling er aktiv. Vil du ikke dele: **slet `feedback.json`**,
  så er den slået fra. Fjernes helt før et offentligt launch.
- **Manuelt:** `Export-Feedback.bat` pakker samme data til én zip på
  skrivebordet, som du selv sender.

## Coach-rapporter med din egen AI

`COACH.md` er en komplet opskrift til din AI-assistent (fx Claude Code) i at
lave dybe efterkamp-rapporter af dine egne data — sig bare *"Læs COACH.md og
lav min rapport"*. Pack-katalogerne følger med i `director\`-mappen.

## Notes

- Offline matches have no `MatchGuid`; they are still recorded.
- Fields like boost/speed are only broadcast for your own team or when
  spectating (per the Stats API docs) — the table shows `–` when absent.
- Unofficial tool; not affiliated with Psyonix or Epic Games.
