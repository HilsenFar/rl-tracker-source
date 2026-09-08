# Smoke-test af Linux-overlayet — kørt PÅ WINDOWS (6/9-2026, kl. 23:15-23:22)

Formål: bevise at Electron-værten + `preload.js`-shim'en taler rigtigt med den KØRENDE
tracker (`http://localhost:8341`, v2026.09.04), før den flyttes til en Linux-desktop.
Alt Linux-specifikt (ozone, `pgrep`, signaler, `focusable:false`-effekten mod en WM) er
IKKE bevist her — se "Linux-only" nederst.

Opsætning: Windows-node v24.16.0, npm 11.13.0, Electron **42.11.2** (win32-x64, hentet af
`npm install` i denne mappe; `postinstall` sprang første gang binaren over — `node
node_modules/electron/install.js` hentede den, ~104 MB i `%LOCALAPPDATA%\electron\Cache`).
Kørt med `RL_OVERLAY_URL=http://localhost:8341/?overlay&glass RL_OVERLAY_GAMEWATCH=0
RL_OVERLAY_DEBUG=1`, ~10-20 s pr. kørsel, dræbt bagefter (0 electron.exe tilbage).
Skærm 1920×1080, skalering 100 %.

## Verificeret (5 kørsler, logs: `smoke-log-run1-before-fixes.txt`, `smoke-log-run5-after-fixes.txt`)

| Punkt | Resultat |
|---|---|
| Starter, single-instance-lås, hotkey `Ctrl+Alt+O` registreres | OK (`[overlay] hotkey ... registreret`, `pid=`) |
| Begge ruder indlæser siden (`did-finish-load` for `&slot=focus` og `&slot=bar`) | OK |
| Shim'en ses fra SIDEN (spurgt med `executeJavaScript` i sidens verden) | `typeof window.chrome.webview === "object"`, `body.classList` = `overlay glass slot-bar barmode` / `slot-focus` — dvs. siden tog GLASS-grenen og bruger `ovHost` |
| `empty` → ruden skjules; `size:B,H` → ruden vises og syes | OK. Sekvens pr. rude: `empty` (tom side) → `size:1307,81` → `size:1314,63` (bar), `size:337,49` → `size:331,49` (focus) |
| `max:N` sendes til siden efter indlæsning og efter anker | OK: focus `max:1916` (anker ukendt → skærmkant) derefter `max:1892` (anker 24 → 1920−24−4); bar `max:1609` |
| Gennemsigtighed (`transparent:true`, `backgroundColor #00000000`) | OK — se `smoke-screen.png` (før fix) og `smoke-screen-final.png` (efter): kun kortene males, skrivebordet bagved er synligt |
| Placering: focus (24,24), bar centreret nederst med 24 px margin | OK (samme regler som Program.cs) |
| drag/dragend-kæden (side → shim → ipc → `startDrag`/`endDrag` → anker → `overlay-glass-<slot>.json`) | OK via `RL_OVERLAY_SELFTEST=1`: filerne blev skrevet `{"x":24,"y":24,"clickThrough":false}` / `{"x":307,"y":960,...}` (musen stod stille, så positionen ændrede sig ikke — kæden gjorde). Filerne er slettet igen |
| Ingen ubehandlede undtagelser i main-processen; stderr tom efter fix | OK. Eneste renderer-advarsel: Electrons CSP-advarsel (kun i upakket app, forventet) + trackerens egen `[flow] skift til idle tog 120 ms` |

## Fejl fundet og rettet i `main.js`

1. **`resizable:false` låste vinduets MINIMUM til startmålet** (Electron/Windows): bredden
   voksede (900 → 1307) men højden (120 → 81/63) og fokus-kortets bredde (420 → 337) blev
   ALDRIG mindre — målt med `getBounds()` i kørsel 4. Rettet i `onSize`: `setResizable(true)`
   → `setSize` → `setResizable(false)`. Kørsel 5: `bounds` = præcis det meldte mål
   (1100×107, 337×49, 331×49). Undtagelse: `size:193,30` (vente-pillen) blev 193×39 — et
   Windows-minimum for rammeløse vinduer (ukendt om Linux/X11 har samme gulv).
2. **`did-fail-load` fyrede for ERR_ABORTED (−3) og lagde en ekstra `loadURL` oveni**: ved
   første besøg i en frisk profil kalder trackerens sprog-synk (`RLLiveTracker.html`
   ~linje 3357) `location.reload()`, hvilket afbryder den igangværende indlæsning. Kørsel 1
   viste hver rude indlæst to gange. Rettet: ignorér `isMainFrame === false` og kode −3
   (Program.cs' `NavigationCompleted` ser aldrig det tilfælde, derfor har Windows-værten intet filter).
3. `console-message`-handleren med 3 parametre udløste Electron-deprecation (`'console-message'
   arguments are deprecated`) — nu ét event-objekt (Electron ≥ 32).

Tilføjet (kun diagnostik, slået fra som default): `RL_OVERLAY_DEBUG=1` (beskeder `<-`/`->`,
`onSize` med bounds/area/anker, sidens console, shim-tjek fra sidens side) og
`RL_OVERLAY_SELFTEST=1` (drag/dragend én gang pr. rude — flytter kortet til musen).
`package.json`: `engines.node >= 22.12`, Electron pinnet `42.11.2` (var allerede).

## Observationer der IKKE er fejl i prototypen (paritet med Program.cs)

- Ankeret sættes ved den FØRSTE `size:`-besked. Rammer vente-pillen (193×30) først, lander
  bjælkens anker ved x=864 og den fulde bjælke (1100 px) klippes til x=820 i stedet for at
  ligge centreret (kørsel 5, `smoke-screen-final.png`). Program.cs gør præcis det samme
  (`!_sized && !_hasPos` ved første mål); en fælles forbedring ville være at centrere
  bjælken ud fra bredden ved HVERT mål, så længe brugeren ikke selv har flyttet den.
- `empty` → `size:` inden for ~100 ms ved opstart giver ét hide/show — samme som på Windows.
- Første `max:` til focus sendes før ankeret kendes (1916, så 1892) — som `SendAvailWidth`
  i Program.cs (`_anchorX` NaN → `wa.Left`).
- `preload.js` kører med `contextIsolation:false` (dokumenteret afvigelse) — ingen fejl set.
- Sandbox: `sandbox:false` + `nodeIntegration:false`; siden fik ikke `require` (ikke testet
  eksplicit, men `nodeIntegration:false` holder det ude af sidens verden).

## Linux-only — stadig ubevist

- `app.commandLine.appendSwitch('ozone-platform', …)` / `enable-transparent-visuals`:
  grenen kører kun på `process.platform === 'linux'` og blev sprunget over her.
- `focusable:false` som WS_EX_NOACTIVATE-pendant: på Windows tog vinduerne ikke fokus
  (Claude-vinduet bag forblev aktivt), men den LINUX-adfærd ("stop interacting with wm",
  altid øverst i alle workspaces) og om knapperne så stadig tager imod klik — umålt.
- Altid-øverst OVER et fullscreen/borderless Proton-spil (X11 stacking, Wayland uden
  alwaysOnTop) — kan kun måles på en rigtig Linux-desktop med Rocket League kørende.
- Klik-igennem: `setIgnoreMouseEvents(true, {forward:true})` — `forward` ignoreres på Linux;
  om X11-input-shape virker gennem KDE/GNOME/XWayland — umålt (43.x-regressionen er grunden
  til pinningen til 42.11.2).
- Spil-vagten `pgrep -f 'RocketLeague\.exe'` mod en Proton-proces — umålt (GAMEWATCH=0 her).
- `SIGUSR1`/`SIGUSR2` — `process.on` på Windows kaster ikke, men signalerne findes ikke; umålt.
- `globalShortcut` under Wayland (portal-dialog) — umålt.
- `hasShadow:false` + `skipTaskbar:true` på Linux-WM'er — umålt.
- Minimums-højden 39 px (vente-pillen) — Windows-specifik eller også Linux? umålt.
- WSLg-vejen (`run-wsl.sh`) er ikke kørt: kræver nativ Linux-node + apt-libs (README trin 0)
  og en server der kan nås fra WSL (trackeren lytter kun på 127.0.0.1).

## Sådan gentages testen (Windows)

```powershell
$d='...\scratchpad\linux-overlay'
$env:RL_OVERLAY_URL='http://localhost:8341/?overlay&glass'; $env:RL_OVERLAY_GAMEWATCH='0'; $env:RL_OVERLAY_DEBUG='1'
Start-Process "$d\node_modules\electron\dist\electron.exe" -ArgumentList '.' -WorkingDirectory $d -RedirectStandardOutput "$d\out.txt" -RedirectStandardError "$d\err.txt"
# ... vent, kig, og luk:
Get-Process electron | Stop-Process -Force
```
