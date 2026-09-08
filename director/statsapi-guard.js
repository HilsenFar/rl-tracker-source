/* statsapi-guard.js — vagt mod spilopdateringers nulstilling af DefaultStatsAPI.ini
 * (14/8-2026, anledning: to Epic-opdateringer i træk satte PacketSendRate=0 og
 * efterlod trackeren stum, indtil brugeren selv rettede filen).
 *
 * Hvad den gør: finder spillets DefaultStatsAPI.ini, og hvis PacketSendRate er
 * 0 eller mangler, rettes den til desiredRate (default 120 — feedets eget loft,
 * jf. Epics kommentar i filen). En rate der er tændt men lavere end ønsket
 * hæves også, men TAVST: det gamle feed kører jo stadig, så ingen banner —
 * ændringen tager effekt ved næste spilstart.
 *
 * Hvordan den finder ini'en (i prioriteret rækkefølge):
 *   1. STATSAPI_INI (env) — testenes og de utraditionelle installers vej
 *   2. Epic-launcherens manifester (ProgramData\Epic\...\Manifests\*.item,
 *      DisplayName ~ "Rocket League" -> InstallLocation). Brugerens eget spil
 *      ligger på L:\Xbobx\rocketleague — en sti ingen gættet liste ville ramme,
 *      så manifesterne er hovedvejen, ikke en nødløsning.
 *   3. C:\Program Files\Epic Games\rocketleague (klassisk default)
 *   Linux (6/9-2026, docs/LINUX-OVERLAY.md) — 2 og 3 erstattes af:
 *   2L. Legendary/Heroics installed.json (~/.config/heroic/legendaryConfig/
 *       legendary/, ~/.config/legendary/, Flatpak-Heroic under ~/.var/app/)
 *       → install_path/TAGame/Config/DefaultStatsAPI.ini. Ini'en ligger i
 *       INSTALLATIONSMAPPEN, ikke i Wine-prefixet.
 *   3L. Steam: <bibliotek>/steamapps/common/rocketleague/… for ~/.steam/steam,
 *       ~/.local/share/Steam, Flatpak-Steam og hvert "path" i libraryfolders.vdf.
 *   gameRunning() bruger pgrep -f RocketLeague.exe (Wine/Proton beholder
 *   exe-navnet i kommandolinjen — udledt, ikke målt; ENOENT = "ved det ikke").
 * Findes filen ikke, logges det ÉN gang og vagten tier — et board der råber
 * "ini ikke fundet" hver aften spillet er lukket, ville kun træne brugeren i
 * at ignorere den (jf. tekst-habituerings-læren).
 *
 * needsGameRestart sættes kun når et SLUKKET feed blev rettet mens spillet
 * kørte — og ryddes af serveren når feedet forbinder (feedConnected), så et
 * gammelt "genstart"-flag aldrig kan gen-tænde banneret en uge senere.
 *
 * Filen indlæses fra disk via createRequire (samme mønster som reach.js) og
 * virker derfor også under SEA-exe'en uden genbyg ved senere rettelser her.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MANIFEST_DIR = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
const FALLBACK_DIRS = ['C:\\Program Files\\Epic Games\\rocketleague'];
const INI_REL = path.join('TAGame', 'Config', 'DefaultStatsAPI.ini');
const BACKUP_SUFFIX = '.rl-tracker.bak';
const MIN_CHECK_GAP_MS = 30e3;          // feed-drop + poll må ikke stakke tjek

/* ---- Linux-finderen (6/9) — rene funktioner, testet i linux-paths.test.js ----
 * readText(sti) -> tekst eller null; intet andet fra disken røres her. */
const LEGENDARY_INSTALLED = home => [
  path.join(home, '.config', 'heroic', 'legendaryConfig', 'legendary', 'installed.json'),
  path.join(home, '.config', 'legendary', 'installed.json'),
  path.join(home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic', 'legendaryConfig', 'legendary', 'installed.json')
];
const STEAM_ROOTS = home => [
  path.join(home, '.steam', 'steam'),
  path.join(home, '.local', 'share', 'Steam'),
  path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
];
/* installed.json er et objekt app_name -> {app_name, title, install_path, version, ...}.
 * Rocket Leagues Epic-app_name er "Sugar"; titlen bærer ®-tegnet som hos Epic. */
function parseLegendaryInstalled(text){
  let j; try{ j = JSON.parse(text); }catch{ return []; }
  const out = [];
  for (const g of Object.values(j && typeof j === 'object' ? j : {})){
    if (!g || typeof g !== 'object') continue;
    if (!/rocket\s*league/i.test(String(g.title || '')) && String(g.app_name || '') !== 'Sugar') continue;
    if (g.install_path) out.push({ installPath: String(g.install_path), version: g.version ? String(g.version) : null });
  }
  return out;
}
/* libraryfolders.vdf: hver "path" "/mnt/games/SteamLibrary" er et bibliotek til. */
function parseLibraryFolders(text){
  const out = [];
  const rx = /"path"\s+"((?:\\.|[^"\\])*)"/g;
  let m; while ((m = rx.exec(String(text || '')))) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}
function linuxIniCandidates(home, readText){
  const out = [];
  for (const f of LEGENDARY_INSTALLED(home)){
    const t = readText(f);
    if (t) for (const g of parseLegendaryInstalled(t)) out.push(path.join(g.installPath, INI_REL));
  }
  const libs = [];
  for (const root of STEAM_ROOTS(home)){
    const apps = path.join(root, 'steamapps');
    libs.push(apps);
    const vdf = readText(path.join(apps, 'libraryfolders.vdf'));
    if (vdf) for (const p of parseLibraryFolders(vdf)) libs.push(path.join(p, 'steamapps'));
  }
  for (const apps of libs){
    const p = path.join(apps, 'common', 'rocketleague', INI_REL);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
const readTextOrNull = p => { try{ return fs.readFileSync(p, 'utf8'); }catch{ return null; } };

function init(opts){
  const log = (opts && opts.log) || (() => {});
  const desiredRate = Math.min(120, Math.max(1, Number(opts && opts.desiredRate) || 120));
  const expectPort = Number(opts && opts.expectPort) || 49123;
  const iniOverride = (opts && opts.iniOverride) || null;
  const onChange = (opts && opts.onChange) || (() => {});

  let cachedIni = null;
  let st = null;                        // seneste status (deles via status())
  let lastCheckAt = 0;
  let timer = null;
  let warnedNotFound = false;

  function findIni(){
    if (iniOverride) return iniOverride;         // også når den mangler: fejlen skal ses, ikke omgås
    if (cachedIni && fs.existsSync(cachedIni)) return cachedIni;
    cachedIni = null;
    if (process.platform !== 'win32'){
      /* Linux/macOS: Epic-manifesterne og C:\-stierne findes ikke — Windows-
       * grenen nedenfor røres ikke, den springes blot over. */
      const home = process.env.HOME || require('os').homedir();
      for (const p of linuxIniCandidates(home, readTextOrNull)){
        if (fs.existsSync(p)){ cachedIni = p; return p; }
      }
      return null;
    }
    try{
      for (const f of fs.readdirSync(MANIFEST_DIR)){
        if (!f.endsWith('.item')) continue;
        try{
          const m = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8'));
          // DisplayName bærer et ®-tegn hos Epic ("Rocket League®") — match løst
          if (!/rocket\s*league/i.test(String(m.DisplayName || ''))) continue;
          const p = path.join(String(m.InstallLocation || '').replace(/\//g, '\\'), INI_REL);
          if (fs.existsSync(p)){ cachedIni = p; return p; }
        }catch{}
      }
    }catch{}
    for (const d of FALLBACK_DIRS){
      const p = path.join(d, INI_REL);
      if (fs.existsSync(p)){ cachedIni = p; return p; }
    }
    return null;
  }

  function gameRunning(){
    return new Promise(resolve => {
      if (process.platform !== 'win32'){
        /* pgrep: exit 0 = fundet, 1 = intet match, ENOENT = intet pgrep -> ukendt */
        try{
          execFile('pgrep', ['-f', 'RocketLeague\\.exe'], { timeout: 10e3 },
            (err, stdout) => resolve(err ? (err.code === 1 ? false : null) : String(stdout).trim().length > 0));
        }catch{ resolve(null); }
        return;
      }
      try{
        execFile('tasklist', ['/FI', 'IMAGENAME eq RocketLeague.exe', '/NH', '/FO', 'CSV'],
          { windowsHide: true, timeout: 10e3 },
          (err, stdout) => resolve(err ? null : /RocketLeague\.exe/i.test(String(stdout))));
      }catch{ resolve(null); }                   // ukendt er et gyldigt svar — aldrig kast her
    });
  }

  function readRate(text){
    const m = text.match(/^\s*PacketSendRate\s*=\s*(-?\d+)/m);
    return m ? Number(m[1]) : null;
  }
  function readPort(text){
    const m = text.match(/^\s*Port\s*=\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  }

  function rewriteRate(ini, text){
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let next;
    if (/^\s*PacketSendRate\s*=/m.test(text)){
      next = text.replace(/^(\s*)PacketSendRate\s*=.*$/m, '$1PacketSendRate=' + desiredRate);
    } else if (/^\s*\[TAGame\.MatchStatsExporter_TA\]/m.test(text)){
      next = text.replace(/^(\s*\[TAGame\.MatchStatsExporter_TA\][^\r\n]*)/m,
        '$1' + eol + 'PacketSendRate=' + desiredRate);
    } else {
      next = text + eol + '[TAGame.MatchStatsExporter_TA]' + eol + 'PacketSendRate=' + desiredRate + eol;
    }
    const bak = ini + BACKUP_SUFFIX;
    try{ if (!fs.existsSync(bak)) fs.writeFileSync(bak, text); }catch{}   // backup er flinkhed, aldrig blokerende
    fs.writeFileSync(ini, next);                 // kaster ved fx manglende skriverettigheder — fanges i check()
  }

  /* To statusser er "samme nyhed" når alt undtagen tidsstempler matcher —
   * ellers ville hvert 5-minutters-tjek pinge alle boards via SSE. */
  function publish(s){
    const strip = x => { const { at, reason, ...rest } = x; return JSON.stringify(rest); };
    const changed = !st || strip(st) !== strip(s);
    st = s;
    if (changed) onChange(st);
    return st;
  }

  async function check(reason, force){
    const now = Date.now();
    if (!force && now - lastCheckAt < MIN_CHECK_GAP_MS) return st;
    lastCheckAt = now;

    const s = {
      at: new Date().toISOString(), reason: reason || 'poll',
      iniPath: null, found: false, rate: null, port: null,
      desiredRate, fixed: false,
      fixedAt: (st && st.fixedAt) || null,
      needsGameRestart: (st && st.needsGameRestart) || false,
      ok: null, error: null
    };

    const ini = findIni();
    if (!ini){
      s.error = 'ini-ikke-fundet';
      if (!warnedNotFound){
        warnedNotFound = true;
        log('[statsapi] DefaultStatsAPI.ini ikke fundet (' + (process.platform === 'win32'
          ? 'Epic-manifester + kendte stier' : 'Legendary/Heroic installed.json + Steam-biblioteker')
          + ') — sæt STATSAPI_INI hvis spillet ligger utraditionelt');
      }
      return publish(s);
    }
    s.iniPath = ini; s.found = true;

    let text;
    try{ text = fs.readFileSync(ini, 'utf8'); }
    catch(e){ s.error = 'kan-ikke-laese: ' + String(e.message || e); return publish(s); }

    s.rate = readRate(text);
    s.port = readPort(text);
    const dead = !s.rate || s.rate <= 0;         // 0, negativ eller manglende = feedet er slukket
    const low  = !dead && s.rate < desiredRate;

    if (dead || low){
      try{
        rewriteRate(ini, text);
        const old = s.rate;
        s.rate = desiredRate; s.fixed = true; s.fixedAt = s.at;
        if (dead){
          const running = await gameRunning();
          s.needsGameRestart = running !== false; // ukendt behandles som kørende: banneret rydder sig selv når feedet forbinder
          log('[statsapi] PacketSendRate var ' + (old === null ? 'væk' : old) + ' — rettet til ' + desiredRate +
              (s.needsGameRestart ? ' (genstart Rocket League for at tænde feedet)' : ' (klar til næste spilstart)'));
        } else {
          log('[statsapi] PacketSendRate hævet ' + old + ' → ' + desiredRate + ' (gælder fra næste spilstart)');
        }
      }catch(e){
        s.error = 'kan-ikke-skrive: ' + String(e.message || e);
        log('[statsapi] feedet er slukket i ' + ini + ' men rettelsen fejlede (' + s.error + ') — ret PacketSendRate=' + desiredRate + ' manuelt');
        return publish(s);
      }
    }

    s.ok = s.rate >= 1 && (s.port === null || s.port === expectPort);
    if (s.port !== null && s.port !== expectPort)
      log('[statsapi] NB: ini-Port=' + s.port + ' men trackeren lytter mod ' + expectPort);
    return publish(s);
  }

  return {
    status: () => st,
    check: (reason) => check(reason, true),
    /* Feedet faldt: spillet lukkede — eller en opdatering er i gang og har
     * måske allerede nulstillet ini'en. Et tjek her retter filen FØR spillet
     * starter igen, så næste launch virker fra første sekund. */
    feedDropped: () => { check('feed-drop', false); },
    feedConnected: () => {
      if (st && st.needsGameRestart){ st = { ...st, needsGameRestart: false }; onChange(st); }
    },
    start(intervalMs){
      check('start', true);
      timer = setInterval(() => check('poll', false), Math.max(60e3, intervalMs || 5 * 60e3));
      if (timer.unref) timer.unref();
      return this;
    },
    stop(){ clearTimeout(timer); clearInterval(timer); }
  };
}

module.exports = { init,
  /* Linux-finderens rene dele — til linux-paths.test.js, ikke til serveren */
  linuxIniCandidates, parseLegendaryInstalled, parseLibraryFolders, LEGENDARY_INSTALLED, STEAM_ROOTS, INI_REL };
