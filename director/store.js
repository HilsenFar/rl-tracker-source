/* RL Director — JSON persistence.
 *
 * profile.json holds every EWMA baseline the coach has ever learned; there is
 * no way to rebuild it except by replaying the whole match archive. A plain
 * fs.writeFileSync truncates the file first, so a crash (or the user closing
 * the exe) mid-write leaves a half-written file and the baselines are gone.
 * Write aside and rename instead — rename is atomic on NTFS, so a reader
 * either sees the old file or the new one, never a torn one.
 */
'use strict';
const fs = require('fs');

function writeJSON(file, obj, pretty){
  writeText(file, JSON.stringify(obj, null, pretty || 0));
}

/* Same guarantee for non-JSON output (the session report's HTML page, which is
 * served over HTTP and can be fetched while it is being written). */
function writeText(file, text){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);                 // replaces the target on Windows too
}

/* Read + shape-check in one step. `shape` is a factory for the default value;
 * any key missing from the stored file is filled in from it, so a file written
 * by an older build (or a partially hand-edited one) can't crash a caller that
 * assumes profile.seen or profile.recentDebriefs exists. Only top-level keys
 * are merged — nested state is owned by whoever wrote it. */
function readJSON(file, shape){
  const base = shape();
  let stored = null;
  try{ stored = JSON.parse(fs.readFileSync(file, 'utf8')); }catch{ return base; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  for (const k of Object.keys(base)){
    const want = base[k], got = stored[k];
    if (got === undefined){ stored[k] = want; continue; }
    if (want === null) continue;                          // default carries no shape to enforce
    if (got === null || typeof got !== typeof want || Array.isArray(got) !== Array.isArray(want))
      stored[k] = want;
  }
  return stored;
}

module.exports = { writeJSON, writeText, readJSON };
