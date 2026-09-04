/* RL Director — replay harness (M1).
 * Runs stored digests through the exact production pipeline, in order:
 * builds/extends profile.json baselines and prints every debrief.
 * Idempotent: already-folded files (profile.seen) are skipped.
 *
 *   node director/replay.js <root-dir>          # root holds matches/ + profile.json
 *   node director/replay.js <root-dir> --fresh  # delete profile first (full rebuild)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const matchDir = path.join(root, 'matches');
if (!fs.existsSync(matchDir)){ console.error('no matches/ under ' + root); process.exit(1); }
if (process.argv.includes('--fresh')){ try{ fs.unlinkSync(path.join(root, 'profile.json')); }catch{} }

const M = require('./metrics');
const director = require('./director').init({ root, log: m => console.log(m) });

const files = fs.readdirSync(matchDir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();
let n = 0, skipped = 0;
for (const f of files){
  let digest;
  try{ digest = JSON.parse(fs.readFileSync(path.join(matchDir, f), 'utf8')); }
  catch(e){ console.log('  ! ulæselig: ' + f); continue; }
  const d = director.onDigest(digest, f);
  if (!d){ skipped++; continue; }
  n++;
  console.log('\n── ' + f + ' ─ ' + d.match.playlist + ' ' + d.match.score.join('-')
    + (d.match.result ? ' (' + d.match.result + ')' : '') + (d.collecting ? ' · baseline ' + d.baselineN + '/' + M.MIN_BASELINE : ''));
  console.log('  ✔ ' + d.ros.text);
  console.log('  ⚠ ' + d.problem.text);
  // advice er null når gentagelsen blev undertrykt (tavshed som standard, 30/7-2026)
  console.log(d.advice
    ? '  → ' + d.advice.text + (d.advice.source ? '   [' + d.advice.source.title + ']' : '')
      + (d.advice.quote && d.advice.quote.text ? '\n    “' + d.advice.quote.text + '”' + (d.advice.quote.by ? ' — ' + d.advice.quote.by : '') : '')
    : '  → (tavs — rådet er uændret)');
}
console.log('\n' + n + ' debriefs, ' + skipped + ' digests sprunget over (offline/artefakter/allerede foldet).');
const prof = JSON.parse(fs.readFileSync(path.join(root, 'profile.json'), 'utf8'));
for (const [pl, p] of Object.entries(prof.playlists)){
  console.log('baseline ' + pl + ' (n=' + p.n + '):');
  for (const [id, m] of Object.entries(p.metrics))
    console.log('  ' + id.padEnd(20) + ' mean=' + (Math.round(m.mean * 1000) / 1000) + ' n=' + m.n);
}
