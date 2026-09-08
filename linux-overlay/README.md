# RL Live Tracker overlay host for Linux

An Electron host that shows the tracker's overlay page in transparent, frameless, always-on-top windows. It is the Linux counterpart of the Windows host (RLOverlay.exe, a WebView2 window with DWM glass) and shows the same page: `http://localhost:8341/?overlay&glass`. `preload.js` emulates WebView2's `window.chrome.webview` channel, so `RLLiveTracker.html` runs unchanged. The tracker must be running first.

## What the host does

Two slots, each in its own window: `focus` (the focus card, top left) and `bar` (the bar, bottom centre). Each window loads the page with `&slot=focus` or `&slot=bar` appended.

The page and the host talk over a small message protocol, the same one the Windows host uses. The page sends `size:W,H` and the host resizes the window to those pixels and shows it; `empty` and the host hides the window; `drag` and `dragend` and the host moves the window with the mouse and saves the new anchor. The host sends `max:N`, the width available to the page from its anchor to the screen edge. Positions are saved per slot in `overlay-glass-<slot>.json` next to `main.js`.

The windows are transparent, frameless, without shadow, without a taskbar entry, always on top, visible on all workspaces, placed within the whole display rather than the work area, and not focusable by default. Only one instance runs at a time; a second copy quits. A game watch runs `pgrep -f RocketLeague\.exe` every 3 seconds and hides both windows when it finds nothing.

## Commands

```
cd linux-overlay
npm install                                   # Electron 42.11.2 for Linux, about 110 MB
./node_modules/.bin/electron . --ozone-platform=x11
./node_modules/.bin/electron . --ozone-platform=x11 --no-sandbox   # SUID sandbox error (Ubuntu 24.04)
RL_OVERLAY_GAMEWATCH=0 ./node_modules/.bin/electron . --ozone-platform=x11   # cards without the game
pkill -USR1 -f 'electron \.( |$)'             # toggle click-through without the hotkey
pkill -USR2 -f 'electron \.( |$)'             # reload both windows
```

The `pkill` pattern matches only the main process; the renderer children carry `--type=...` on their command line. `../start-overlay.sh` wraps the install and the first command. The board's Overlay button (`POST /api/overlay` on the tracker) starts `./node_modules/.bin/electron .` in this folder once `npm install` has run; `main.js` selects `--ozone-platform=x11` itself, so the flag on the command line is optional.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `RL_OVERLAY_URL` | `http://localhost:8341/?overlay&glass` | base URL; `&slot=` is appended per window |
| `RL_OVERLAY_SLOTS` | `bar,focus` | which windows to open |
| `RL_OVERLAY_GAMEWATCH` | `1` | `0` shows the cards without the game running |
| `RL_OVERLAY_CLICKTHROUGH` | `0` | `1` starts with click-through on |
| `RL_OVERLAY_FOCUSABLE` | `0` | `1` makes the windows ordinary focusable windows; try it if the cards ignore clicks |
| `RL_OVERLAY_HOTKEY` | `CommandOrControl+Alt+O` | the click-through hotkey |
| `RL_OVERLAY_NOGPU` | unset | `1` disables hardware acceleration; an older workaround for transparency on some NVIDIA/X11 setups |
| `RL_OVERLAY_DEBUG` | unset | `1` logs the page's messages, its console and whether the shim is visible from the page |
| `RL_OVERLAY_DEVTOOLS` | unset | `1` opens devtools; the window loses transparency while they are open |
| `RL_OZONE` | `x11` | `wayland` runs native Wayland, where always-on-top does not exist; for measuring only |

`RL_OVERLAY_SELFTEST=1` runs the drag chain once per window after load and moves the card to the mouse; it exists for the smoke test only.

## Hotkeys and signals

Ctrl+Alt+O toggles click-through. Ctrl+Alt+R reloads both windows. Ctrl+Alt+Shift+O puts the windows back at their default positions. `SIGUSR1` toggles click-through and `SIGUSR2` reloads; they work whether or not the hotkey could be registered.

Click-through is a one-way door without the hotkey or signal: Electron's `forward: true` option, which lets a click-through window still receive hover events, works on Windows and macOS only. On X11 the hotkey is taken from the X server; on Wayland it goes through the GlobalShortcuts portal (GNOME shows a dialog once, KDE binds silently). The start log says whether registration succeeded.

Electron is pinned to 42.11.2 because 43 and later has an open X11 regression where `setIgnoreMouseEvents(true)` no longer gives click-through (electron/electron#52456). Node 22.12 or newer is required by that Electron version.

## Verified on Windows

Five runs against the running tracker with Electron 42.11.2 win32-x64: startup and the single-instance lock, hotkey registration, both slots loading the page, the page seeing the shim (`typeof window.chrome.webview === "object"`) and taking the glass branch, `empty` hiding and `size:` resizing to the exact pixels, `max:` sent before and after the anchor is known, the drag chain writing `overlay-glass-<slot>.json`, transparency, and the default placement (focus at 24,24; bar centred at the bottom with a 24 px margin). Three bugs were found and fixed there: `resizable: false` locked the minimum size, `did-fail-load` retried on ERR_ABORTED, and a deprecated `console-message` signature.

## Not verified on Linux

Nothing below has been run on a Linux desktop. The ozone switches (`--ozone-platform`, `enable-transparent-visuals`) only apply on Linux and were skipped. Whether a `focusable: false` window stays above a focused borderless Proton game on KWin or Mutter, whether X11 input-shape click-through works through KDE, GNOME and XWayland, whether `pgrep -f RocketLeague\.exe` matches the game's command line under Proton, whether `SIGUSR1` and `SIGUSR2` reach the process, whether `globalShortcut` registers under Wayland, and how `hasShadow: false` and `skipTaskbar: true` behave on Linux window managers are all open. So is whether X11 has the 39 px minimum height for frameless windows that Windows showed.

## Licence

MIT, see LICENSE. The tracker it displays is a separate work under PolyForm Noncommercial 1.0.0.
