'use strict';
/* ══════════════════════════════════════════════════════════════════════════
 * FULD GAS (27/8-2026) — de fire temaer for RAPPORTERNE.
 *
 * Ugerapporten (weekly.js) og sessionsrapporten (session.js) bygger hver sin
 * HTML som en streng. De delte allerede plade, typografi og farver med
 * trackeren; her faar de ogsaa dens fire temaer.
 *
 * HVORDAN TEMAET VAELGES: der er ingen vaelger i rapporten. Rapporterne
 * serveres fra `/reports/` paa SAMME origin som appen (localhost:8341), saa
 * de kan laese appens eget valg i `localStorage['rlls.theme.v1']`. EEN
 * beslutning, alle flader. Aabnes filen alene fra disken (`file://`), er der
 * ingen localStorage — og saa staar standarden, cockpit, som den skal.
 *
 * HVAD DER IKKE MAA GAA I STYKKER:
 *  · Rapporten er en SELVSTAENDIG fil brugeren kan flytte og dele. Ingen
 *    billed-afhaengighed — hver plade er ren CSS. Fonten er progressiv
 *    (findes et niveau op, naar rapporten laeses fra /reports/).
 *  · Farve er aldrig eneste kanal. Sejr/nederlag baerer W/L som bogstav,
 *    verdict-mærkaterne baerer ord. Temaerne roerer kun kuloeren.
 *  · Temaerne aendrer LAYOUT, ikke kun farve — ellers er det bare en anden
 *    palet: cockpit runder og aander ud, arkaden bliver flad og raaber,
 *    radaren bliver taet og maaleagtig.
 * ═══════════════════════════════════════════════════════════════════════ */

const KEYS = ['broadcast', 'cockpit', 'arcade', 'radar'];
const DEFAULT = 'cockpit';

/* Sættes FOER foerste maling. Staar den nede i body, naar rapporten at blive
 * malet i standarden foerst og blinker om. */
const BOOT = '<script>try{var t=localStorage.getItem("rlls.theme.v1");'
  + 'if(["' + KEYS.join('","') + '"].indexOf(t)>=0)document.documentElement.dataset.theme=t;}catch(e){}</script>';

/* Aabnings-taggen. Standarden staar i attributten, saa en rapport uden
 * localStorage (delt fil, anden maskine) stadig har et tema. */
function htmlOpen(lang){
  return '<!doctype html>\n<html lang="' + lang + '" data-theme="' + DEFAULT + '">';
}

/* Laegges SIDST i <style>, saa den vinder over grundreglerne uden !important. */
const CSS = [
/* ── BROADCAST er grundtilstanden ovenfor. Kun det fraesede hjoerne og den
 *    teal streg gentages her, saa temaet kan vinde tilbage efter et andet. */
':root[data-theme=broadcast]{--cut:13px}',
'[data-theme=broadcast] h2::before{background:linear-gradient(180deg,var(--teal),#0E6C60)}',

/* ── COCKPIT (standard): grafit og boerstet metal, buer i stedet for
 *    firkanter, varm accent. Kortene aander mere ud end i broadcast. */
':root[data-theme=cockpit]{--bg:#0B0E13;--panel:#242A33;--panel2:#171C24;'
  + '--line:rgba(198,210,228,.14);--text:#EEF2F8;--muted:#9AA5B6;'
  + '--accent:#FF8A4C;--teal:#FF5B26;--warn:#FFC94A;--cut:3px}',
'[data-theme=cockpit] body{background:radial-gradient(120% 60% at 50% -10%,rgba(255,138,76,.10),transparent 62%),'
  + 'linear-gradient(180deg,#151A21 0%,#0B0E13 48%,#07090D 100%),var(--bg)}',
'[data-theme=cockpit] .card{background:linear-gradient(168deg,#242A33 0%,#171C24 46%,#0F1319 100%);'
  + 'border-radius:16px;padding:16px 18px;margin-bottom:12px;'
  + 'box-shadow:inset 0 1px 0 rgba(255,255,255,.11),inset 0 -1px 0 rgba(0,0,0,.55),var(--e2)}',
'@supports (corner-shape:bevel){[data-theme=cockpit] .card{corner-shape:round}}',
'[data-theme=cockpit] .chip,[data-theme=cockpit] .code,[data-theme=cockpit] .tag,'
  + '[data-theme=cockpit] .verdict,[data-theme=cockpit] .seq{border-radius:9px}',
'[data-theme=cockpit] h2::before{background:linear-gradient(180deg,#FFC94A,var(--teal))}',
/* redline: baren har en roed bane i den sidste tredjedel, som en omdrejningstaeller */
'[data-theme=cockpit] .barcell{background:linear-gradient(90deg,transparent 0 66%,rgba(255,45,20,.14) 66% 100%)}',
'[data-theme=cockpit] .bar{border-radius:5px;background:linear-gradient(90deg,#7FE3FF,#FFD34A 68%,#FF5B26)}',

/* ── ARKADE-PLAKAT: flad, haard og hoejt maettet. Ingen afrunding, ingen
 *    skygge — dybden kommer fra kanten. Overskrifterne raaber. */
':root[data-theme=arcade]{--bg:#07030F;--panel:#221039;--panel2:#160A26;'
  + '--line:rgba(255,45,149,.24);--text:#FFFFFF;--muted:#B08FD0;'
  + '--accent:#16E0FF;--teal:#FF2D95;--good:#3BFFA6;--bad:#FF4D6D;--cut:0px}',
'[data-theme=arcade] body{background:linear-gradient(150deg,#221039 0%,#10061F 58%,#070312 100%),var(--bg)}',
'[data-theme=arcade] .card{background:linear-gradient(150deg,#221039 0%,#12071F 100%);'
  + 'border:0;border-left:4px solid var(--teal);border-radius:0;box-shadow:none;'
  + 'outline:1px solid rgba(255,45,149,.20);outline-offset:-1px}',
'[data-theme=arcade] h1{font-stretch:64%;font-weight:900;font-size:34px;letter-spacing:.02em;'
  + 'text-shadow:3px 3px 0 var(--teal)}',
'[data-theme=arcade] h2{font-stretch:62%;font-weight:900;font-size:14px;letter-spacing:.26em;color:var(--text)}',
'[data-theme=arcade] h2::before{width:5px;height:15px;background:var(--teal)}',
'[data-theme=arcade] h2::after{background:linear-gradient(90deg,rgba(255,45,149,.45),transparent 70%)}',
'[data-theme=arcade] .chip{background:#160A26;border-color:rgba(22,224,255,.30);border-radius:0}',
'[data-theme=arcade] .quote{border-left-color:var(--accent)}',
'[data-theme=arcade] .bar{border-radius:0;background:linear-gradient(90deg,var(--accent),var(--teal))}',

/* ── TEKNISK RADAR: maaleudstyr. Haarfine kasser, scanlinjer, taette
 *    raekker og tabulaere tal — dokumentet bliver et instrument. */
':root[data-theme=radar]{--bg:#020705;--panel:#06120C;--panel2:#040B08;'
  + '--line:rgba(59,255,166,.22);--text:#D6FFE9;--muted:#5FA986;'
  + '--accent:#3BFFA6;--teal:#3BFFA6;--warn:#FFB300;--good:#3BFFA6;--bad:#FF6B6B;--cut:0px}',
'[data-theme=radar] body{background:var(--bg);font-size:14px;line-height:1.5}',
'[data-theme=radar] .card{background:var(--panel);'
  + 'background-image:repeating-linear-gradient(0deg,rgba(59,255,166,.045) 0 1px,transparent 1px 5px);'
  + 'border:1px solid var(--line);border-radius:0;box-shadow:none;padding:11px 13px;margin-bottom:8px}',
'[data-theme=radar] h1{font-stretch:74%;font-weight:800;letter-spacing:.06em;color:var(--accent)}',
'[data-theme=radar] h2{color:var(--accent);letter-spacing:.3em}',
'[data-theme=radar] h2::before{background:var(--accent)}',
'[data-theme=radar] h2::after{background:repeating-linear-gradient(90deg,rgba(59,255,166,.4) 0 3px,transparent 3px 7px)}',
'[data-theme=radar] th,[data-theme=radar] td{padding:3px 7px}',      /* taettere: et instrument, ikke en brochure */
'[data-theme=radar] .chip,[data-theme=radar] .code,[data-theme=radar] .tag,'
  + '[data-theme=radar] .verdict,[data-theme=radar] .seq{border-radius:0;background:var(--panel2);border:1px solid var(--line)}',
'[data-theme=radar] .bar{border-radius:0;background:linear-gradient(90deg,#0B7A50,var(--accent))}',
'[data-theme=radar] .quote{border-left-color:var(--accent)}',

/* ── Hoejkontrast og udskrift gaelder alle fire ── */
'@media (forced-colors: active){.card{border:1px solid CanvasText;background:none;box-shadow:none}'
  + 'h2::before,h2::after{background:CanvasText}.bar{background:Highlight}}',
'@media print{body{background:#fff;color:#111}.card{background:#fff;border:1px solid #bbb;box-shadow:none}'
  + 'h1,h2{color:#111}.muted,th{color:#555}}'
].join('\n') + '\n';

module.exports = { KEYS, DEFAULT, BOOT, CSS, htmlOpen };
