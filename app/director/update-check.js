/* update-check.js — stille versions-tjek mod det offentlige releases-repo
 * (14/8-2026, fase 1 af opdaterings-kanalen: BESKED, ikke selv-opdatering —
 * en fejlslagen automatisk opdatering hos 2000 testere er værre end en
 * "hent ny version"-knap; exe-swap er bevidst udskudt).
 *
 * Kilden er GitHub Releases API'et direkte (repos/<repo>/releases/latest) —
 * ingen separat manifest-fil at holde ajour: versionen ER release-tagget
 * (v2026.08.14-format), download-linket ER release-sidens. Anonymt kald,
 * 60/time pr. IP er rigeligt til ét i døgnet.
 *
 * Privatliv (del af appens løfte, sig det ALTID i docs): kaldet sender intet
 * om spilleren — det er en almindelig anonym HTTPS-forespørgsel. Slås fra med
 * "updateCheck": false i director-ai.json eller UPDATE_CHECK=0 i miljøet.
 *
 * Version-sammenligning er numerisk pr. segment ('2026.8.14' == '2026.08.14',
 * '2026.08.20' > '2026.08.14') — aldrig leksikalsk.
 */
'use strict';

const https = require('https');

const DEFAULT_REPO = 'HilsenFar/rl-tracker-releases';
const CHECK_DELAY_MS = 15e3;            // boot skal ikke vente på netværk
const CHECK_INTERVAL_MS = 24 * 3600e3;

/* Hvilket release-asset hører til denne platform? OPDATERING*.zip er Windows-
 * pakken (SEA-exe + .bat) — den duer ikke på Linux. Dér vælges kun et asset
 * med "linux" i navnet; findes det ikke, meldes versionen stadig (linket til
 * release-siden + `git pull`/kilde-spejlet er vejen), men uden download-navn.
 * Ren funktion — testet i linux-paths.test.js. */
function pickAsset(assets, platform){
  const list = Array.isArray(assets) ? assets : [];
  const by = rx => list.find(a => rx.test(String((a && a.name) || '')));
  if (platform !== 'win32') return by(/linux.*\.(zip|tar\.gz|tgz|AppImage)$/i) || null;
  /* 9/9-2026: installeren (RL-Tracker-Setup*.exe) er Windows-vejen; zip'erne
   * bliver som fallback for releases fra foer. */
  return by(/Setup.*\.exe$/i) || by(/OPDATERING.*\.zip$/i) || by(/\.zip$/i) || null;
}

function cmpVersions(a, b){
  const pa = String(a || '').replace(/^v/i, '').split(/[.\-]/).map(Number);
  const pb = String(b || '').replace(/^v/i, '').split(/[.\-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++){
    const x = pa[i] || 0, y = pb[i] || 0;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;   // 'beta' o.l. afgør aldrig
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function fetchLatest(repo){
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: '/repos/' + repo + '/releases/latest',
      headers: {
        'User-Agent': 'RL-Live-Tracker',   // GitHub afviser UA-løse kald med 403
        'Accept': 'application/vnd.github+json'
      },
      timeout: 10e3
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try{ resolve(JSON.parse(body)); }catch(e){ reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function init(opts){
  const log = (opts && opts.log) || (() => {});
  const appVersion = (opts && opts.appVersion) || '0';
  const repo = (opts && opts.repo) || DEFAULT_REPO;
  const onChange = (opts && opts.onChange) || (() => {});

  let st = null;
  let timerA = null, timerB = null;

  function publish(s){
    const strip = x => { const { at, ...rest } = x; return JSON.stringify(rest); };
    const changed = !st || strip(st) !== strip(s);
    st = s;
    if (changed) onChange(st);
    return st;
  }

  async function check(){
    const s = { at: new Date().toISOString(), appVersion, repo,
                latest: null, updateAvailable: false, error: null };
    try{
      const rel = await fetchLatest(repo);
      const version = String(rel.tag_name || '').replace(/^v/i, '');
      const asset = pickAsset(rel.assets, process.platform);
      s.latest = {
        version,
        url: rel.html_url || ('https://github.com/' + repo + '/releases/latest'),
        assetName: asset ? asset.name : null,
        assetSizeMB: asset ? Math.round(asset.size / 1048576 * 10) / 10 : null,
        publishedAt: rel.published_at || null
      };
      s.updateAvailable = cmpVersions(appVersion, version) < 0;
      if (s.updateAvailable)
        log('[update] ny version klar: v' + version + ' (denne: v' + appVersion + ') — ' + s.latest.url);
    }catch(e){
      /* Intet release endnu, nede net, rate-limit: alt sammen hverdag — status
       * bærer fejlen til /api/update, men der logges ikke støj hver dag. */
      s.error = String(e.message || e);
    }
    return publish(s);
  }

  return {
    status: () => st,
    check,
    cmpVersions,                          // eksponeret for tests
    start(){
      timerA = setTimeout(() => { check(); }, CHECK_DELAY_MS);
      timerB = setInterval(() => { check(); }, CHECK_INTERVAL_MS);
      if (timerA.unref) timerA.unref();
      if (timerB.unref) timerB.unref();
      return this;
    },
    stop(){ clearTimeout(timerA); clearInterval(timerB); }
  };
}

module.exports = { init, cmpVersions, pickAsset };
