# RL Live Tracker på Linux — tracker, Stats API og overlay

Skrevet 6/9-2026 ud fra forskningsrunden R3 + kritikken (crit R3-G1…G5) og en
smoke-test af Electron-værten på Windows. Alt der står som *verificeret* er læst i
kilden eller målt; *udledt* betyder ræsonneret, ikke målt. Det, der kun kan afgøres
på en rigtig Linux-desktop, står samlet i "Ukendt indtil en Linux-tester svarer".

## 1. Rocket League på Linux i 2026

- Psyonix lovede 17/2-2026, at Steam Deck/Linux via Proton stadig understøttes med
  Easy Anti-Cheat tændt, og ved EAC-udrulningen 30/4-2026 lød den officielle tekst
  "Steam Deck and Linux are also supported" (GamingOnLinux, begge artikler læst).
  GamingOnLinux' skribent spillede online-kampe via Heroic på Fedora KDE efter
  opdateringen. *Verificeret.*
- Steam-udgaven blev afnoteret i 2020; nye Linux-spillere bruger **Epic via
  Heroic/Legendary** med GE-Proton (Heroic-wiki: "should work just fine out of the
  box"). ProtonDB: platinum, 863 rapporter. Mods (BakkesMod) kører ikke med EAC —
  `-noeac` giver kun træning/offline/replays.
- Heroic sætter selv `PROTON_EAC_RUNTIME`; intet minimums-Proton er dokumenteret.

## 2. Stats API under Wine/Proton

- Wines socket-lag laver ægte host-sockets (`server/sock.c`: `socket/bind/listen`
  med `AF_INET`). Spillets lytter på `127.0.0.1:49123` inde i prefixet ER Linux'
  loopback, så trackerens `net.connect(49123, '127.0.0.1')` rammer den.
  *Verificeret i Wine-kilden; udledt for pressure-vessel (Steam-udgaven) — bwrap
  deler netværks-namespace som default.*
- Ini'en ligger i **installationsmappen**, ikke i prefixet:
  `<install>/TAGame/Config/DefaultStatsAPI.ini`, sektion
  `[TAGame.MatchStatsExporter_TA]`, `PacketSendRate>0`, `Port=49123`.
- Om RL med EAC under Proton faktisk honorerer ini'en og lytter på 49123 er
  **ikke bekræftet af nogen kilde** (crit R3-G4). På Windows virker feedet med EAC
  (693 kampe i arkivet, nyeste 6/9). Uden Linux-svaret er hele sporet en hypotese.

### Ini-stier pr. launcher (det statsapi-guard.js nu leder efter)

| Launcher | Metadata → installationssti | Ini |
|---|---|---|
| Heroic (Epic) | `~/.config/heroic/legendaryConfig/legendary/installed.json` → `install_path` (typisk `~/Games/Heroic/rocketleague`) | `<install_path>/TAGame/Config/DefaultStatsAPI.ini` |
| Legendary (ren) | `~/.config/legendary/installed.json` | samme |
| Heroic (Flatpak) | `~/.var/app/com.heroicgameslauncher.hgl/config/heroic/legendaryConfig/legendary/installed.json` | samme |
| Steam | `~/.steam/steam/steamapps`, `~/.local/share/Steam/steamapps`, Flatpak-Steam, + hvert `"path"` i `libraryfolders.vdf` | `<steamapps>/common/rocketleague/TAGame/Config/DefaultStatsAPI.ini` |

`STATSAPI_INI=/sti/til/DefaultStatsAPI.ini` går forud for alt (som på Windows).
installed.json-formatet (`app_name` "Sugar", `title`, `install_path`, `version`) er
*udledt* fra Legendarys kode, ikke målt på en Linux-maskine.

## 3. server.js på Linux med ren node

Kernen (http/net/fs/worker_threads, nul dependencies) er platformneutral. Det
Windows-bundne er nu enten platformdelt eller kan overstyres:

| Sted | Før | Nu (6/9) |
|---|---|---|
| Browser-åbning ved start | `spawn('cmd', ['/c','start',…])` — ENOENT kom som asynkront `'error'`-event og **væltede serveren** trods try/catch (crit R3-G1, reproduceret) | `browserOpenCommand()`: win32 `cmd /c start`, darwin `open`, ellers `xdg-open`; child får `.on('error', …)`. `RL_NO_OPEN=1` springer helt over |
| `overlayRunning()` / `/api/overlay` | kun `tasklist` + `RLOverlay.exe`, ellers `available:false` | `findOverlayLauncher()`: linux = `RL_OVERLAY_CMD` eller `linux-overlay/` (i ROOT eller lige over) med `node_modules/electron`; `running` via `pgrep -f` (`RL_OVERLAY_PGREP` overstyrer mønstret); POST starter værten detached. Windows-svarene er uændrede |
| `RS_IMAGES` (rank-emblemer) | `%APPDATA%\bakkesmod\…` → null på Linux → emblemer udebliver | `RS_IMAGES_DIR` går forud (fx `<pfx>/drive_c/users/<u>/AppData/Roaming/bakkesmod/bakkesmod/data/RocketStats/RocketStats_images`) |
| `statsapi-guard.js` | Epic-manifester + `C:\Program Files\…`; `tasklist` | Linux-finder (tabellen ovenfor); `gameRunning()` = `pgrep -f RocketLeague\.exe` (ENOENT = "ved det ikke"). Windows-grenen uændret |
| `psynet.js findInstall()` | Epic-manifester → null på Linux → versionsdetektion springes stille over | `findInstallLinux()` læser samme installed.json → `Binaries/Win64/RocketLeague.exe` + CL; findes intet, stadig stille null. Rank-relæet på collectoren dækker uanset |
| `update-check.js` | `OPDATERING*.zip` (Windows-pakken) blev meldt som download | `pickAsset()`: på Linux kun et asset med "linux" i navnet, ellers version + link uden download-navn |
| `build-portable.mjs`, `.bat`/`.ps1`, SEA-exe | Windows-launchere | Ikke portet — på Linux køres `node server.js` fra et checkout (kilde-spejlet `HilsenFar/rl-tracker-source` eller repoet) |
| `windowsHide:true` | — | harmløst på Linux |

Tests: `director/test/linux-paths.test.js` (rene funktioner + findIni/check() med
`process.platform` stubbet til linux og HOME i en temp-mappe) og recorder-tillægget i
`server-fns.test.js`. Hele suiten: `node scripts/run-tests.js`.

## 4. Overlay-vindue på Linux — muligheder

| # | Vej | Gennemsigtig | Altid øverst | Klik-igennem | Dom |
|---|---|---|---|---|---|
| **A** | **Electron tvunget til X11** (`--ozone-platform=x11` = XWayland under Wayland) | ja (kompositor) | ja (`_NET_WM_STATE_ABOVE`) | ja via X11-input-shape — **regression i Electron 43+** (electron#52456) → pin 42.x | **Primær.** Én kodebase for KDE/GNOME/wlroots + Deck-desktop |
| B | Electron nativ Wayland | ja (sort på COSMIC) | **nej** (protokollen har ingen z-order) | upålidelig på Mutter | uegnet som overlay |
| C | Tauri 2 / WebKitGTK | ja | samme Wayland-grænse | uklar på Linux | ingen gevinst over A |
| D | GTK4 + gtk4-layer-shell | ja | ægte overlay-lag på KDE/wlroots/Smithay | GDK-input-region | senere Wayland-optimering — virker IKKE på GNOME eller X11 |
| E | Steam Deck game mode (gamescope) | — | — | — | **umuligt**: det ene eksterne overlay-slot holdes af mangoapp |
| F | Steam Deck desktop mode | Plasma 6 på X11 som default → vej A | | | lille skærm |
| **G** | **Telefon/tablet/anden skærm** | n/a | n/a | n/a | **Fallback**, nul ny kode: `HOST=0.0.0.0 node server.js` → `http://<pc-ip>:8341/?overlay` eller `?board`. Eneste vej i Deck game mode |

Anbefaling: **A** med Electron pinnet til **42.11.2**, vinduet `transparent + frame:false
+ alwaysOnTop + skipTaskbar + focusable:false` ("On Linux setting focusable: false makes
the window stop interacting with wm, so the window will always stay on top in all
workspaces" — Electron-docs), klik-igennem via hotkey/`SIGUSR1` (`forward:true` er
Windows/macOS-only, så hover-styret klik-igennem findes ikke), spillet i **Borderless**
(samme krav som Windows-overlayet: et fokuseret fullscreen-vindue ligger over
"keep above"). `setAlwaysOnTop(true,'screen-saver')`-niveauet er no-op på Linux —
harmløst. Fallback **G**; og G er den eneste vej i Steam Deck game mode. Loopback-
beslutningen (26/7) fraviges bevidst med `HOST=0.0.0.0`.

## 5. Sådan kører du trackeren på Linux

```bash
# node >= 22.12 (nvm: source ~/.nvm/nvm.sh && nvm use 22)
git clone https://github.com/HilsenFar/rl-tracker-source rl-tracker && cd rl-tracker   # linux-overlay/ + denne fil er med i spejlet fra og med naeste eksport (build-portable kopierer dem nu)
RL_NO_OPEN=1 node server.js                       # http://localhost:8341/  (kun loopback)
# ini ligger utraditionelt?                        STATSAPI_INI=/sti/til/DefaultStatsAPI.ini
# board/overlay på telefon eller anden skærm:      HOST=0.0.0.0 RL_NO_OPEN=1 node server.js
# rank-emblemer fra et BakkesMod-prefix:           RS_IMAGES_DIR=/sti/til/RocketStats_images
```

`RL_NO_OPEN=1` er valgfrit siden 6/9 (xdg-open + error-lytter), men på en maskine
uden `xdg-open` er det stadig den stille vej. Data (profile.json, matches/, reports/)
lander i mappen serveren startes fra (`ROOT`), som på Windows.

## 6. Sådan kører du overlayet

```bash
cd linux-overlay
npm install                                        # Electron 42.11.2, ~110 MB
RL_OVERLAY_URL="http://localhost:8341/?overlay&glass" npx electron .
# uden spil kørende (test):                        RL_OVERLAY_GAMEWATCH=0 npx electron .
# klik-igennem uden hotkey:                        pkill -USR1 -f 'electron \.$'   # kun hovedprocessen (boernene har --type=...)
# native Wayland (kun for at måle):                RL_OZONE=wayland npx electron .
```

Eller knappen "Overlay" på boardet → `POST /api/overlay` starter
`linux-overlay/node_modules/.bin/electron .` når `npm install` er kørt. Hotkeys:
`Ctrl+Alt+O` klik-igennem, `Ctrl+Alt+R` genindlæs, `Ctrl+Alt+Shift+O` stil tilbage.
Detaljer og variabel-liste: `linux-overlay/README.md`.

## 7. Hvad der ER verificeret (Windows-smoke-test 6/9, Electron 42.11.2 win32)

Mod den kørende tracker (v2026.09.04), 5 kørsler, fuld log i forskningsmappens
`SMOKETEST-WINDOWS.md`:

- Start, single-instance-lås, hotkey-registrering, begge ruder indlæser siden.
- Shim'en ses fra SIDENS verden (`typeof window.chrome.webview === "object"`, body har
  `overlay glass slot-bar barmode` / `slot-focus`) — siden tog glass-grenen uændret.
- `empty` skjuler, `size:B,H` syr og viser (bar 1307×81 → 1314×63, focus 337×49),
  `max:N` sendes (focus 1916 → 1892 efter anker, bar 1609), drag/dragend-kæden skriver
  `overlay-glass-<slot>.json`.
- Gennemsigtighed (kun kortene males), placering (focus 24,24; bar centreret nederst).
- Tre fejl fundet og rettet (og med i repoets kopi): `resizable:false` låste vinduets
  minimum (fix: `setResizable(true)` → `setSize` → `setResizable(false)`);
  `did-fail-load` retry'ede på ERR_ABORTED (−3) fra sprog-synk'ens `location.reload()`;
  `console-message` med tre parametre gav Electrons deprecation.
- Rest: vente-pillen `size:193,30` blev 193×39 — Windows-minimum for rammeløse vinduer.

## 8. Ukendt indtil en Linux-tester svarer

- Lytter RL med EAC under Proton på host-loopback 49123 (Heroic OG Steam/pressure-vessel)?
- Bliver et `focusable:false`-vindue liggende OVER et fokuseret borderless spil på KWin
  (X11 + Wayland/XWayland) og Mutter+XWayland?
- Virker klik-igennem (X11-input-shape) gennem KDE/GNOME/XWayland med 42.11.2?
- Matcher `pgrep -f 'RocketLeague\.exe'` spillets proces-kommandolinje under Proton?
- `globalShortcut` under Wayland (portal-dialog på GNOME, stumt på KDE) — eller kun `SIGUSR1`?
- installed.json-format/stier hos Heroic (særligt Flatpak) — udledt, ikke set.
- Hvor længe 42.x får sikkerhedsopdateringer, og hvornår electron#52456 lukkes.
- WSLg beviser INTET af ovenstående (ingen altid-øverst, RDP-remotet alpha).

### Tjekliste til en Linux-tester (5 linjer, i en kamp)

```
1. ss -ltnp | grep 49123            # lytter spillet? (+ PacketSendRate=120 i ini'en først)
2. pgrep -af RocketLeague           # hvordan ser proces-linjen ud under Proton?
3. echo $XDG_SESSION_TYPE; echo $XDG_CURRENT_DESKTOP     # x11/wayland + KDE/GNOME/…
4. Proton-version (Heroic: spillets indstillinger / Steam: Egenskaber → Kompatibilitet)
5. Spillets vinduestilstand: Borderless eller Fullscreen — og ligger overlayet over det?
```

Send de fem svar + `linux-overlay`-loggen (`RL_OVERLAY_DEBUG=1`). Uden 1 er sporet
stadig en hypotese.

## 9. TODO fælles for BEGGE værter (paritet, målt 6/9)

Ankeret låses ved den **første** `size:`-besked. Rammer vente-pillen (193×30) først,
lander bjælkens anker ved x=864, og den fulde bjælke (1100 px) klippes til x=820 i
stedet for at ligge centreret. `overlay-host/Program.cs` gør præcis det samme
(`!_sized && !_hasPos` ved første mål), `linux-overlay/main.js` er skrevet efter det.
Fælles forbedring: centrér bjælken ud fra bredden ved HVERT mål, så længe brugeren ikke
selv har flyttet den (gemt anker = brugerens valg, default-anker = værtens). Rettes i
begge værter i samme omgang, så Windows- og Linux-adfærd bliver ved med at være ens.

## 10. TODO paritet efter 7/9: aldrig fokus + fullscreen-vagt (Windows-værten v1.1.0)

Tester-feedback (Windows, exclusive fullscreen): overlayet sendte spillet ud på
skrivebordet i samme sekund kickoff-nedtællingen var slut. Årsag målt 7/9: et
Topmost-vindue, der *viser sig* over et exclusive-fullscreen-D3D-spil, smider
spillet ud af fullscreen (ét `Show()` minimerede spillet på 1,5 s). `Program.cs`
gør nu følgende — og det samme skal spejles i `linux-overlay/main.js`:

1. **Aldrig `hide()`/`showInactive()` efter første visning.** Vinduet vises én gang
   parkeret uden for skærmen (`-32000,-32000`) og flyttes derefter kun ind/ud med
   `win.setPosition(...)`. `hideNow()`/`showNow()` bliver til `park()`/`unpark()`.
   X11-WM'er kan klippe en off-screen-position — mål det; fallback er
   `win.setOpacity(0)` + `setIgnoreMouseEvents(true)` mens ruden er "parkeret".
2. **Fullscreen-vagt.** Under Wine/Proton findes DXGI's exclusive mode ikke (DXVK
   tegner fullscreen som et `_NET_WM_STATE_FULLSCREEN`-vindue), så sparket findes
   næppe — men et fullscreen-vindue i samme staklag kan *dække* et always-on-top-
   vindue. Genkend: `xprop -id <RL-vindue> _NET_WM_STATE` indeholder
   `_NET_WM_STATE_FULLSCREEN` (find vinduet med `xdotool search --name "Rocket League"`).
   I den tilstand: hold ruderne parkeret og skriv status (pkt. 4).
3. **Aldrig fokus.** `focusable:false` er allerede default (`RL_OVERLAY_FOCUSABLE=0`).
   Tilføj `webPreferences.disableDialogs: true` (ingen alert/confirm-vinduer) og
   `wc.setWindowOpenHandler(() => ({ action: 'deny' }))` (ingen `window.open`).
4. **Statusfilen.** Skriv `overlay-status.json` i trackerens ROD (ikke ved siden af
   main.js — serveren læser `ROOT/overlay-status.json`): `{version, fullscreen,
   game, shown, at}`, ved hvert skift + puls hvert 10. sekund, slet ved lukning.
   `spawnOverlay()` sætter `RL_OVERLAY_STATUS=<ROOT>/overlay-status.json` i miljøet,
   så værten ved hvor. Serveren dømmer en fil ældre end 30 s som tavshed, og
   chippen ("Overlayet kræver Borderless Window …") er server-/side-siden — den
   virker for Linux i samme øjeblik filen skrives.
5. **Selvtest.** `RL_OVERLAY_SELFTEST=1` bør også sende `size:`/`empty` ind hvert
   4. sekund og logge forgrundsvindue + fullscreen-tilstand + ruder hvert sekund,
   som `RLOverlay.exe --selftest` gør (`overlay-selftest.log`).
