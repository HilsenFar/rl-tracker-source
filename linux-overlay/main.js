/* main.js — RL Live Tracker overlay-vært for Linux (Electron-prototype, 6/9-2026).
 *
 * Gør det samme som overlay-host\Program.cs gør på Windows, men med Electron:
 *   - to ruder af den SAMME side: ?overlay&glass&slot=focus (øverst venstre)
 *     og ?overlay&glass&slot=bar (nederst, centreret)
 *   - vinduet er gennemsigtigt, rammeløst, altid øverst, uden for taskbar,
 *     og syes til de mål siden melder ("size:B,H" / "empty")
 *   - klik-igennem kan slås til/fra (hotkey + SIGUSR1)
 *   - kortene skjules når Rocket League ikke kører (pgrep -f RocketLeague.exe)
 *   - placering gemmes pr. rude i overlay-glass-<slot>.json ved siden af main.js
 *
 * Miljøvariable:
 *   RL_OVERLAY_URL        basis-URL (default http://localhost:8341/?overlay&glass)
 *   RL_OVERLAY_SLOTS      'bar,focus' (default) — hvilke ruder der åbnes
 *   RL_OVERLAY_CLICKTHROUGH  '1' = start med klik-igennem
 *   RL_OVERLAY_GAMEWATCH  '0' = vis altid (smoke-test uden spil, fx WSL)
 *   RL_OVERLAY_FOCUSABLE  '1' = almindeligt vindue; default '0' (se note ved focusable)
 *   RL_OZONE              'x11' (default) eller 'wayland' — se README
 *   RL_OVERLAY_NOGPU      '1' = app.disableHardwareAcceleration() (ældre Electron-råd for
 *                         gennemsigtighed på visse NVIDIA/X11-opsætninger)
 *   RL_OVERLAY_DEVTOOLS   '1' = åbn devtools (NB: vinduet mister gennemsigtighed imens)
 *   RL_OVERLAY_DEBUG      '1' = log beskederne fra siden (size:/empty/drag), sidens
 *                         console og om shim'en ses fra siden — til smoke-test
 *   RL_OVERLAY_SELFTEST   '1' = kør drag/dragend-kæden én gang pr. rude efter
 *                         indlæsning (flytter kortet til musen!) — kun til smoke-test
 */
'use strict';
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

/* Ozone-platform SKAL vælges før app.ready. x11 (= XWayland under en Wayland-
 * session) er default, fordi Electron-dokumentationen siger at alwaysOnTop
 * ikke virker under Wayland ("Not supported on Wayland (Linux)"). */
const OZONE = (process.env.RL_OZONE || 'x11').toLowerCase();
if (process.platform === 'linux'){
  app.commandLine.appendSwitch('ozone-platform', OZONE);
  app.commandLine.appendSwitch('enable-transparent-visuals');
  if (OZONE === 'wayland') app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}
if (process.env.RL_OVERLAY_NOGPU === '1') app.disableHardwareAcceleration();

const BASE_URL = process.env.RL_OVERLAY_URL || 'http://localhost:8341/?overlay&glass';
const SLOTS = String(process.env.RL_OVERLAY_SLOTS || 'bar,focus').split(',').map(s => s.trim()).filter(s => /^(bar|focus)$/.test(s));
const GAMEWATCH = process.env.RL_OVERLAY_GAMEWATCH !== '0';
const FOCUSABLE = process.env.RL_OVERLAY_FOCUSABLE === '1';
const DEBUG = process.env.RL_OVERLAY_DEBUG === '1';
const SELFTEST = process.env.RL_OVERLAY_SELFTEST === '1';
const dbg = (...a) => { if (DEBUG) console.log('[dbg]', ...a); };
const MARGIN = 24;
let clickThrough = process.env.RL_OVERLAY_CLICKTHROUGH === '1';

/* Én ad gangen (som Program.cs' mutex): en kopi mere ville ligge oveni den første. */
const SINGLE = app.requestSingleInstanceLock();
if (!SINGLE) app.quit();

/* ---------- én rude ---------- */
class Pane {
  constructor(slot){
    this.slot = slot;                       // 'bar' | 'focus'
    this.url = BASE_URL + '&slot=' + slot;
    this.cfg = path.join(__dirname, 'overlay-glass-' + slot + '.json');
    this.anchor = this.readAnchor();        // {x,y} eller null = hjørne-default
    this.sized = false;
    this.wantShown = true;                  // siden har noget at vise
    this.gameOn = true;                     // spillet kører (eller vi kan ikke se efter)
    this.shown = false;
    this.lastAvail = -1;
    this.drag = null;
    this.win = null;
  }

  create(){
    const w = this.slot === 'focus' ? 420 : 900, h = 120;
    this.win = new BrowserWindow({
      width: w, height: h,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      /* focusable:false — Electron-dokumentationen (BaseWindowConstructorOptions):
       * "On Linux setting focusable: false makes the window stop interacting
       * with wm, so the window will always stay on top in all workspaces."
       * Det er den nærmeste pendant til Program.cs' WS_EX_NOACTIVATE — og er
       * samtidig det bedste kort mod et fokuseret fullscreen-spil, der ellers
       * ligger i en højere stak-lag end "keep above". Skal MÅLES; slå fra
       * med RL_OVERLAY_FOCUSABLE=1 hvis knapperne ikke tager imod klik. */
      focusable: FOCUSABLE,
      backgroundColor: '#00000000',
      title: 'RL Live Tracker overlay',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: false,     // shim'en skal ligge på sidens eget window.chrome
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false, // en skjult rude skal stadig måle og melde
        spellcheck: false
      }
    });
    this.win.setMenuBarVisibility(false);
    try{ this.win.setAlwaysOnTop(true, 'screen-saver'); }catch{ this.win.setAlwaysOnTop(true); }
    try{ this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); }catch{}
    this.applyClickThrough();
    this.placeAtStart();

    const wc = this.win.webContents, slot = this.slot;
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      dbg(slot, 'did-fail-load', code, desc, url, 'main=' + isMainFrame);
      /* Kun hovedrammen, og ALDRIG ERR_ABORTED (-3): den kommer når siden selv
       * afbryder sin egen indlæsning — målt 6/9 på Windows: sprog-synk'en i
       * RLLiveTracker.html kalder location.reload() ved første besøg i en frisk
       * profil, og uden dette filter lagde værten en EKSTRA loadURL ovenpå, så
       * hver rude blev indlæst to gange. WebView2's NavigationCompleted
       * (Program.cs) ser aldrig den slags, derfor har Windows-værten intet filter. */
      if (isMainFrame === false || code === -3) return;
      console.log('[' + this.slot + '] load fejlede (' + code + ' ' + desc + ') — prøver igen om 2 s');
      setTimeout(() => { if (!this.win.isDestroyed()) this.win.loadURL(this.url); }, 2000);
    });
    wc.on('did-finish-load', () => {
      dbg(slot, 'did-finish-load', wc.getURL());
      this.lastAvail = -1; this.sendAvail();
      if (SELFTEST && !this.selfTested){
        /* Selvtest af flytte-vejen uden mus: siden sender 'drag' (som ved alt-træk),
         * preload'et sender 'dragend' ved pointerup — her sendes begge fra sidens
         * side gennem shim'en, så hele kæden shim -> ipc -> startDrag/endDrag ->
         * anker -> gemt fil kører. Vinduet lander hvor musen tilfældigvis står. */
        this.selfTested = true;
        setTimeout(() => {
          const before = this.win.getPosition();
          wc.executeJavaScript('window.chrome.webview.postMessage("drag")').catch(() => {});
          setTimeout(() => {
            wc.executeJavaScript('window.chrome.webview.postMessage("dragend")').catch(() => {});
            setTimeout(() => {
              let saved = null; try{ saved = fs.readFileSync(this.cfg, 'utf8'); }catch{}
              dbg(slot, 'selftest drag: før', before.join(','), 'efter', this.win.getPosition().join(','),
                  'anker', JSON.stringify(this.anchor), 'fil', saved);
            }, 200);
          }, 600);
        }, 2500);
      }
      if (DEBUG){
        /* Smoke-test: ser SIDEN shim'en? Spørg i sidens egen verden, ikke preload'ets. */
        wc.executeJavaScript('({ webview: typeof (window.chrome && window.chrome.webview), glass: document.body.classList.contains("glass"), slot: document.body.className, title: JSON.stringify(document.title) })')
          .then(r => dbg(this.slot, 'side indlæst:', JSON.stringify(r)))
          .catch(e => dbg(this.slot, 'executeJavaScript fejlede:', e.message));
      }
    });
    if (DEBUG) wc.on('console-message', (ev) => {
      // Electron ≥ 32 (og 42): ét event-objekt {level, message, lineNumber, sourceId}.
      // Flere parametre her udløser Electrons deprecation-advarsel (målt 6/9).
      dbg(slot, 'console[' + ev.level + ']', String(ev.message).split(String.fromCharCode(10))[0]);
    });
    wc.on('render-process-gone', () => setTimeout(() => this.win.loadURL(this.url), 2000));
    if (process.env.RL_OVERLAY_DEVTOOLS === '1') wc.openDevTools({ mode: 'detach' });

    this.win.loadURL(this.url);
    /* Vises med det samme (som Program.cs): siden styrer derefter selv via
     * 'size:'/'empty', og spil-vagten via setGameRunning. */
    this.showNow();
  }

  /* ---- synlighed ---- */
  showNow(){ if (this.win && !this.win.isDestroyed()){ this.win.showInactive(); this.shown = true; this.applyClickThrough(); } }
  hideNow(){ if (this.win && !this.win.isDestroyed()){ this.win.hide(); this.shown = false; } }
  updateVisibility(){
    const want = this.gameOn && this.wantShown;
    if (want === this.shown) return;
    if (want) this.showNow(); else this.hideNow();
  }
  setGameRunning(on){ if (this.gameOn === on) return; this.gameOn = on; this.updateVisibility(); }
  setWantShown(w){ if (this.wantShown === w) return; this.wantShown = w; this.updateVisibility(); }

  /* ---- klik-igennem ---- */
  applyClickThrough(){
    if (!this.win || this.win.isDestroyed()) return;
    /* forward:true virker kun på Windows/macOS ifølge dokumentationen; på Linux
     * ignoreres det. Uden forward får siden ingen hover-events mens klik går
     * igennem — derfor er hotkey/SIGUSR1 den eneste vej tilbage. */
    this.win.setIgnoreMouseEvents(clickThrough, { forward: true });
  }

  /* ---- geometri ---- */
  display(){
    const b = this.win.getBounds();
    return screen.getDisplayNearestPoint({ x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) });
  }
  /* HELE skærmen, ikke workArea: overlayet ligger oven på et spil i fuld skærm,
   * hvor panelet er dækket (samme begrundelse som Program.cs WorkArea()). */
  area(){ return this.display().bounds; }

  defaultAnchor(wa, w, h){
    if (this.slot === 'focus') return { x: wa.x + MARGIN, y: wa.y + MARGIN };
    return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + wa.height - h - MARGIN };
  }
  placeAtStart(){
    const wa = screen.getPrimaryDisplay().bounds;
    const [w, h] = this.win.getSize();
    const a = this.anchor || this.defaultAnchor(wa, w, h);
    this.win.setPosition(Math.round(a.x), Math.round(a.y));
  }
  /* Sæt vinduet på ankeret, men hold det inde på skærmen (klipning er
   * midlertidig — ankeret røres ikke). */
  reposition(){
    if (!this.anchor) return;
    const wa = this.area();
    const [w, h] = this.win.getSize();
    const x = Math.max(wa.x, Math.min(this.anchor.x, wa.x + wa.width - w));
    const y = Math.max(wa.y, Math.min(this.anchor.y, wa.y + wa.height - h));
    this.win.setPosition(Math.round(x), Math.round(y));
  }
  sendAvail(){
    if (!this.win || this.win.isDestroyed()) return;
    const wa = this.area();
    const ax = this.anchor ? this.anchor.x : wa.x;
    const avail = Math.max(320, Math.floor(wa.x + wa.width - ax - 4));
    if (avail === this.lastAvail) return;
    this.lastAvail = avail;
    dbg(this.slot, '->', 'max:' + avail);
    try{ this.win.webContents.send('ov:host', 'max:' + avail); }catch{}
  }

  onSize(w, h){
    if (!(w >= 40 && h >= 10 && w <= 8000 && h <= 2000)) return;
    const wa = this.area();
    w = Math.min(w, wa.width); h = Math.min(h, wa.height);
    const [cw, ch] = this.win.getSize();
    if (Math.abs(cw - w) > 0.5 || Math.abs(ch - h) > 0.5){
      /* resizable:false låser Electrons MINIMUM til vinduets nuværende mål
       * (målt 6/9 på Windows: bredden voksede 900 -> 1307, men hverken højden
       * 120 -> 81 eller fokus-kortets 420 -> 337 blev mindre). Åbn kortvarigt
       * for at sy, luk igen så ingen WM/kant kan trække i ruden. */
      this.win.setResizable(true);
      this.win.setSize(Math.round(w), Math.round(h), false);
      this.win.setResizable(false);
    }
    /* TODO (paritet med Program.cs, maalt 6/9): ankeret laases ved det FOERSTE
     * maal. Kommer vente-pillen (193x30) foer bjaelken, lander ankeret ved
     * x=864 og den fulde bjaelke (1100 px) klippes til x=820 i stedet for at
     * ligge centreret. Begge vaerter boer centrere bjaelken ud fra bredden ved
     * HVERT maal, saa laenge brugeren ikke selv har flyttet den. */
    if (!this.sized && !this.anchor) this.anchor = this.defaultAnchor(wa, w, h);
    this.sized = true;
    this.sendAvail();
    this.reposition();
    this.setWantShown(true);
    dbg(this.slot, 'onSize', w + 'x' + h, 'bounds', JSON.stringify(this.win.getBounds()), 'area', JSON.stringify(wa), 'anker', JSON.stringify(this.anchor));
  }

  /* ---- flyt: siden sender 'drag' ved alt-træk/midterklik, 'dragend' ved pointerup ---- */
  startDrag(){
    if (this.drag) return;
    const cur = screen.getCursorScreenPoint();
    const [x, y] = this.win.getPosition();
    this.drag = { dx: cur.x - x, dy: cur.y - y, timer: setInterval(() => {
      const p = screen.getCursorScreenPoint();
      this.win.setPosition(Math.round(p.x - this.drag.dx), Math.round(p.y - this.drag.dy));
    }, 16) };
  }
  endDrag(){
    if (!this.drag) return;
    clearInterval(this.drag.timer); this.drag = null;
    const [x, y] = this.win.getPosition();
    this.anchor = { x, y };
    this.sendAvail();
    this.save();
  }
  resetPlacement(){ this.anchor = null; this.sized = false; this.placeAtStart(); this.save(); }

  /* ---- gemt placering ---- */
  readAnchor(){
    try{
      const j = JSON.parse(fs.readFileSync(this.cfg, 'utf8'));
      if (Number.isFinite(j.x) && Number.isFinite(j.y)) return { x: j.x, y: j.y };
    }catch{}
    return null;
  }
  save(){
    try{
      const a = this.anchor || (this.win ? { x: this.win.getPosition()[0], y: this.win.getPosition()[1] } : { x: 0, y: 0 });
      fs.writeFileSync(this.cfg, JSON.stringify({ x: Math.round(a.x), y: Math.round(a.y), clickThrough }));
    }catch{}
  }
  reload(){ try{ this.win.webContents.reload(); }catch{} }
}

const panes = new Map();

/* ---------- beskeder fra siden (via preload-shim) ---------- */
ipcMain.on('ov:msg', (e, raw) => {
  const msg = String(raw || '');
  const pane = [...panes.values()].find(p => p.win && !p.win.isDestroyed() && p.win.webContents === e.sender);
  if (!pane) return;
  dbg(pane.slot, '<-', msg);
  if (msg === 'drag') return pane.startDrag();
  if (msg === 'dragend') return pane.endDrag();
  if (msg === 'empty') return pane.setWantShown(false);
  if (msg.startsWith('size:')){
    const p = msg.slice(5).split(',');
    if (p.length !== 2) return;
    const w = parseFloat(p[0]), h = parseFloat(p[1]);
    if (Number.isFinite(w) && Number.isFinite(h)) pane.onSize(Math.ceil(w), Math.ceil(h));
  }
});

/* ---------- spil-vagt: kortene hører til spillet, ikke skrivebordet ---------- */
function gameRunning(){
  return new Promise(resolve => {
    if (!GAMEWATCH) return resolve(true);
    try{
      // Wine/Proton-processer beholder exe-navnet i kommandolinjen; -f matcher hele linjen.
      execFile('pgrep', ['-f', 'RocketLeague\\.exe'], { timeout: 3000 }, (err, out) => {
        if (err && err.code === 'ENOENT') return resolve(true);   // ingen pgrep: skjul intet
        resolve(!err && String(out).trim().length > 0);
      });
    }catch{ resolve(true); }
  });
}
function startGameWatch(){
  const tick = async () => { const on = await gameRunning(); for (const p of panes.values()) p.setGameRunning(on); };
  tick();
  setInterval(tick, 3000);
}

/* ---------- klik-igennem: hotkey + signal ---------- */
function toggleClickThrough(){
  clickThrough = !clickThrough;
  for (const p of panes.values()){ p.applyClickThrough(); p.save(); }
  console.log('[overlay] klik gaar ' + (clickThrough ? 'IGENNEM' : 'til kortene'));
}

if (SINGLE) app.whenReady().then(() => {
  for (const slot of SLOTS){ const p = new Pane(slot); panes.set(slot, p); p.create(); }
  startGameWatch();

  /* X11: hotkey'en gribes fra X-serveren. Wayland: går via
   * org.freedesktop.portal.GlobalShortcuts (GNOME viser en dialog første gang,
   * KDE binder stumt) — se Electron-dokumentationen for globalShortcut. */
  const acc = process.env.RL_OVERLAY_HOTKEY || 'CommandOrControl+Alt+O';
  try{
    const ok = globalShortcut.register(acc, toggleClickThrough);
    console.log('[overlay] hotkey ' + acc + (ok ? ' registreret' : ' KUNNE IKKE registreres (Wayland uden portal?) — brug: kill -USR1 ' + process.pid));
  }catch(e){ console.log('[overlay] hotkey fejlede: ' + e.message); }
  try{ globalShortcut.register('CommandOrControl+Alt+R', () => { for (const p of panes.values()) p.reload(); }); }catch{}
  try{ globalShortcut.register('CommandOrControl+Alt+Shift+O', () => { for (const p of panes.values()) p.resetPlacement(); }); }catch{}

  console.log('[overlay] ozone=' + OZONE + ' url=' + BASE_URL + ' slots=' + SLOTS.join(',') +
              ' clickThrough=' + clickThrough + ' gamewatch=' + GAMEWATCH + ' pid=' + process.pid);
});

/* SIGUSR1 = skift klik-igennem, SIGUSR2 = genindlæs. Virker uanset X11/Wayland. */
try{ process.on('SIGUSR1', toggleClickThrough); }catch{}
try{ process.on('SIGUSR2', () => { for (const p of panes.values()) p.reload(); }); }catch{}

app.on('will-quit', () => { try{ globalShortcut.unregisterAll(); }catch{} });
app.on('window-all-closed', () => app.quit());
