# RL Live Tracker source mirror

RL Live Tracker is a free coach for Rocket League on PC. It reads the game's
official Stats API on your machine while you play, measures your habits against
your own baseline, and coaches you one focus at a time.

This repo mirrors, byte for byte, the readable source that ships inside the
official zip. It exists so you can read the code before you download. The only
files missing here are the binaries (`RLTrackerServer.exe`, `RLOverlay.exe` and
the WebView2 DLLs); everything else in the zip is in this repo, unchanged. The
exe is just `server.js` packed with the Node runtime.

Only official builds are distributed, and only from
<https://gitato.net/rl-tracker/>.

## What's in here

- `server.js`: the local server the exe runs.
- `director/`: the coaching engine. Metrics, rules, session and weekly logic, rank lookups, the quote bank.
- `RLLiveTracker.html`: the whole UI in one file.
- `docs/` and `README.txt`: the guides that ship with the zip.
- `Start-RL-Tracker.bat`, `launch-overlay.ps1`, `vaerktoejer/`: launch and helper scripts.

## Updates

The mirror is refreshed from the shipped zip at every release. The app itself
checks [rl-tracker-releases](https://github.com/HilsenFar/rl-tracker-releases)
once a day and shows a quiet card on the board when a newer version exists.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). You can read the code, run it, and
change it for your own use. Commercial use and resale are off the table.
