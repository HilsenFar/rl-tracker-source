#!/usr/bin/env bash
# Smoke-test-hjælper til WSL2 Ubuntu-24.04 + WSLg. Kør fra WSL:
#   bash run-wsl.sh            # åbner overlayet mod Windows-trackerens server
#   RL_OVERLAY_URL=... bash run-wsl.sh
#
# Forudsætninger (se README.md): NATIV Linux-node >= 22.12 (nvm), `npm install`
# kørt i denne mappe under den native node, og Electrons runtime-biblioteker
# installeret (libnss3 libasound2t64 libxss1 var IKKE installeret 6/9-2026).
set -euo pipefail
cd "$(dirname "$0")"

# WSL2 i NAT-tilstand: 'localhost' er WSL's egen loopback, ikke Windows'.
# Windows-værten nås på default-gateway-adressen — MEN trackeren lytter kun på
# 127.0.0.1 (server.js HOST-default), så den skal startes med HOST=0.0.0.0 på
# Windows-siden for at kunne nås herfra (målt 6/9: 172.22.240.1:8341 = NOT-REACHABLE).
HOST_IP=$(ip route show default | awk '{print $3}')
: "${RL_OVERLAY_URL:=http://${HOST_IP}:8341/?overlay&glass}"
export RL_OVERLAY_URL
export RL_OVERLAY_GAMEWATCH="${RL_OVERLAY_GAMEWATCH:-0}"   # intet spil i WSL: vis altid
export RL_OZONE="${RL_OZONE:-x11}"                          # WSLg: XWayland-vejen først

echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} DISPLAY=${DISPLAY:-}"
echo "node=$(command -v node || echo MANGLER) ($(node --version 2>/dev/null || true))"
echo "url=$RL_OVERLAY_URL ozone=$RL_OZONE gamewatch=$RL_OVERLAY_GAMEWATCH"

if ! command -v node >/dev/null || [[ "$(command -v node)" == /mnt/c/* ]]; then
  echo "FEJL: ingen NATIV Linux-node (npm på PATH er Windows' via interop: $(command -v npm || true))" >&2
  echo "Installer fx: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22" >&2
  exit 1
fi
[[ -x node_modules/.bin/electron ]] || { echo "kør først: npm install" >&2; exit 1; }

# Electron under WSLg: ingen SUID-sandbox i containeren -> --no-sandbox.
exec node_modules/.bin/electron . --no-sandbox --ozone-platform="$RL_OZONE" "$@"
