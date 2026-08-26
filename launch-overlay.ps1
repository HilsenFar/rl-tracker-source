# Launches the tracker overlay as a small, semi-transparent, always-on-top
# Chrome/Edge app window for single-screen play (game in Borderless/Windowed).
# ToS-clean: a plain OS window layered on top of the game - no injection.
# Windows PowerShell 5.1 compatible (no &&, no ternary, no ??).
#
# Defaults come from overlay-pos.json (written next to this script on success);
# explicit parameters always win. First run defaults to the bottom-right corner
# of the primary screen with a 24 px margin.
param(
  [int]$X,
  [int]$Y,
  [int]$W = 420,
  [int]$H = 640,
  [ValidateRange(0.30, 1.0)]
  [double]$Alpha = 0.88,
  [switch]$ClickThrough,
  # Chrome-app-vinduer tegner deres EGEN titelbjaelke inde i vinduet - den kan
  # hverken fjernes med window-styles eller klippes vaek (maalt 23/8). Vagten
  # MAALER den nu (klienthoejde minus sidens viewport) og regner den med, naar
  # vinduet syes til kasserne, saa X,Y er der hvor kasserne skal staa.
  # ClipTop er kun tilbage som noedbremse: den forskyder aabningsplaceringen.
  [int]$ClipTop = 0,
  # Bliv koerende og sy vinduet til kasserne, som siden melder gennem
  # vinduestitlen (usynlige zero-width-tegn). Vagten starter nu af sig selv
  # fra launcheren og doer, naar vinduet lukkes.
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'
# Titlen er et USYNLIGT zero-width-tegn (U+200B): titelbjaelken viser ingen
# tekst, og vinduet genfindes paa tegnet som praefiks. Bredde-bits haenger bagpaa.
$TITLE   = [string][char]0x200B
$URL     = 'http://localhost:8341/?overlay'
$cfgPath = Join-Path $PSScriptRoot 'overlay-pos.json'

if (-not ('OverlayWin' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OverlayWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  // *Ptr variants exist only in 64-bit user32; in 32-bit they are C macros for
  // the plain versions, so importing them there throws EntryPointNotFound.
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr val);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW", SetLastError=true)] static extern int GetWindowLong32(IntPtr h, int idx);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] static extern int SetWindowLong32(IntPtr h, int idx, int val);
  public static long GetWL(IntPtr h, int idx) {
    if (IntPtr.Size == 4) return (long)GetWindowLong32(h, idx);
    return GetWindowLongPtr(h, idx).ToInt64();
  }
  public static void SetWL(IntPtr h, int idx, long val) {
    if (IntPtr.Size == 4) SetWindowLong32(h, idx, (int)val);
    else SetWindowLongPtr(h, idx, new IntPtr(val));
  }
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int CombineRgn(IntPtr dest, IntPtr a, IntPtr b, int mode);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  static string target = "";
  public static IntPtr found = IntPtr.Zero;
  static bool Check(IntPtr h, IntPtr lp) {
    if (!IsWindowVisible(h)) return true;
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    // Prefix-match: i bjaelke-mode haenger sidens geometri-rapport efter titlen.
    // Ordinal: zero-width-tegn er "ignorable" i den kultur-foelsomme
    // sammenligning, saa StartsWith() ellers kan matche ETHVERT vindue - og
    // vagten ville aldrig opdage at overlayet blev lukket.
    if (sb.ToString().StartsWith(target, StringComparison.Ordinal)) { found = h; return false; }
    return true;
  }
  public static IntPtr FindByTitle(string t) { target = t; found = IntPtr.Zero; EnumWindows(Check, IntPtr.Zero); return found; }
}
'@
}
[void][OverlayWin]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms

# ---- constants (Win32) ----
$HWND_TOPMOST      = New-Object IntPtr(-1)
$GWL_EXSTYLE       = -20
$GWL_STYLE         = -16
$WS_EX_LAYERED     = 0x80000
$WS_EX_TRANSPARENT = 0x20
$WS_CAPTION        = 0xC00000
$WS_THICKFRAME     = 0x40000
$LWA_ALPHA         = 2
$SWP_NOSIZE        = 0x1
$SWP_NOMOVE        = 0x2
$SWP_SHOWWINDOW    = 0x40
$SWP_FRAMECHANGED  = 0x20
$SW_RESTORE        = 9

function Set-OverlayStyle {
  param([IntPtr]$hwnd, [double]$alphaVal, [bool]$transparent)
  $ex = [OverlayWin]::GetWL($hwnd, $GWL_EXSTYLE)
  $ex = $ex -bor $WS_EX_LAYERED
  if ($transparent) { $ex = $ex -bor $WS_EX_TRANSPARENT }
  else { $ex = $ex -band (-bnot $WS_EX_TRANSPARENT) }   # rerun without -ClickThrough clears it
  [OverlayWin]::SetWL($hwnd, $GWL_EXSTYLE, $ex)
  # Ingen titelbjælke, ingen ramme (brugerkrav 31/7): et overlay skal ligne
  # en del af skærmen, ikke et vindue. Titlen findes stadig usynligt, så
  # single-instance-genfindingen på vinduestitel bliver ved med at virke.
  # Flyt/luk sker via scriptets parametre eller proceslinjens højreklik.
  $st = [OverlayWin]::GetWL($hwnd, $GWL_STYLE)
  $st = $st -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME))
  [OverlayWin]::SetWL($hwnd, $GWL_STYLE, $st)
  $b = [byte][Math]::Min(255, [int][Math]::Round(255 * $alphaVal))
  # Kun alpha. Color-key blev proevet igen 23/8 med skaermkopi som facit, og
  # bed ikke: fladen stod malet i RGB 1,1,1. Chrome praesenterer forbi
  # LWA_COLORKEY, saa gennemsigtighed er ikke en mulighed - i stedet syes
  # VINDUET til kasserne (Update-OverlayFit), saa der ingen flade er udenom.
  [void][OverlayWin]::SetLayeredWindowAttributes($hwnd, 0, $b, $LWA_ALPHA)
}

# Persist where the window ACTUALLY is, so a window the user dragged or
# resized reopens where they left it (not where it was first placed).
function Save-OverlayPos {
  param([IntPtr]$hwnd, [double]$alphaVal, [int]$clip = 0)
  $r = New-Object OverlayWin+RECT
  if ([OverlayWin]::GetWindowRect($hwnd, [ref]$r)) {
    # Gem de LOGISKE (synlige) maal — clip-udvidelsen regnes fra, ellers
    # vokser vinduet med ClipTop px for hver genstart.
    @{ x = $r.Left; y = ($r.Top + $clip); w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top - $clip); alpha = $alphaVal } |
      ConvertTo-Json -Compress | Set-Content -Path $cfgPath -Encoding ASCII
  }
}

# Sy vinduet til kassernes klynge: er der ingen flade udenom kasserne, er der
# heller intet baand at se. Det er den ENESTE vej med Chrome som motor.
#
# MAALT 23/8, skaermkopi som facit (alle tre genveje faldt):
#   color-key .......... bider ikke; fladen stod malet i RGB 1,1,1
#   SetWindowRgn ....... klipper kun Chromes egen TEGNING (ogsaa dens
#                        titelbjaelke), men vinduets flade males stadig
#                        ugennemsigtig udenfor regionen - intet vundet
#   fullscreen-vindue .. har ingen titelbjaelke, men Chrome naegter at lade
#                        sig krympe bagefter (samme svar som kiosk 31/7)
# Tilbage staar: vinduet SKAL vaere klyngens stoerrelse. Chromes egen
# titelbjaelke bliver derfor den eneste rest - og den kan kun skjules helt
# ved at lade vinduets top ligge OVER skaermkanten (bjaelken i toppen).
#
# Siden melder sit viewport og klyngens rektangel i usynlige zero-width-tegn
# i titlen (U+200B = 0, U+200C = 1): 1 markoerbit + 6 x 12 bit = indre
# bredde, indre hoejde, klyngens x, y, bredde, hoejde. Bjaelkehoejden regnes
# ud som klienthoejde minus indre hoejde - saa den behoever ikke gaettes.
# Klyngen bliver liggende PRAECIS hvor den er; kun vinduet omkring den flytter.
# Returnerer titlen, saa vagten kan se om den aendrede sig.
function Update-OverlayFit {
  param([IntPtr]$hwnd)
  $sb = New-Object System.Text.StringBuilder 512
  [void][OverlayWin]::GetWindowText($hwnd, $sb, 512)
  $t = $sb.ToString()
  $bits = ''
  foreach ($ch in $t.ToCharArray()) {
    if ([int]$ch -eq 0x200B) { $bits += '0' }
    elseif ([int]$ch -eq 0x200C) { $bits += '1' }
  }
  if ($bits.Length -ne 73) { return $t }        # panel-mode eller halv melding
  $b = $bits.Substring(1)                       # markoertegnet er ikke data
  $innerW = [Convert]::ToInt32($b.Substring(0, 12), 2)
  $innerH = [Convert]::ToInt32($b.Substring(12, 12), 2)
  $clX    = [Convert]::ToInt32($b.Substring(24, 12), 2)
  $clY    = [Convert]::ToInt32($b.Substring(36, 12), 2)
  $clW    = [Convert]::ToInt32($b.Substring(48, 12), 2)
  $clH    = [Convert]::ToInt32($b.Substring(60, 12), 2)
  if ($innerW -lt 100 -or $innerH -lt 10 -or $clW -lt 40 -or $clH -lt 10) { return $t }
  $r = New-Object OverlayWin+RECT
  if (-not [OverlayWin]::GetWindowRect($hwnd, [ref]$r)) { return $t }
  $c = New-Object OverlayWin+RECT
  if (-not [OverlayWin]::GetClientRect($hwnd, [ref]$c)) { return $t }
  $p = New-Object OverlayWin+POINT
  if (-not [OverlayWin]::ClientToScreen($hwnd, [ref]$p)) { return $t }
  # Chromes egen bjaelke ligger INDE i klientfladen; hoejden er forskellen
  # mellem klientfladen og sidens viewport. Sidekanterne plejer at vaere 0.
  $barH  = $c.Bottom - $innerH
  $sideW = [int][Math]::Floor(($c.Right - $innerW) / 2)
  if ($barH -lt 0 -or $barH -gt 300 -or $sideW -lt 0 -or $sideW -gt 200) { return $t }
  $frameLeft   = $p.X - $r.Left
  $frameTop    = $p.Y - $r.Top
  $frameRight  = $r.Right - ($p.X + $c.Right)
  $frameBottom = $r.Bottom - ($p.Y + $c.Bottom)
  # klyngens nuvaerende plads paa skaermen - den skal IKKE flytte sig
  $clusterX = $p.X + $sideW + $clX
  $clusterY = $p.Y + $barH + $clY
  $newW = $frameLeft + $sideW + $clW + $sideW + $frameRight
  $newH = $frameTop + $barH + $clH + $frameBottom
  $newX = $clusterX - $frameLeft - $sideW
  $newY = $clusterY - $frameTop - $barH
  $curW = $r.Right - $r.Left; $curH = $r.Bottom - $r.Top
  $off = [Math]::Abs($newX - $r.Left) + [Math]::Abs($newY - $r.Top) +
         [Math]::Abs($newW - $curW) + [Math]::Abs($newH - $curH)
  if ($off -le 2) { $script:ovFitTried = $null; return $t }     # sidder som den skal
  $target = "$newX,$newY,$newW,$newH"
  if ($script:ovFitTried -eq $target) { return $t }   # proevet - Chrome ville ikke laengere ned
  $script:ovFitTried = $target
  [void][OverlayWin]::SetWindowPos($hwnd, $HWND_TOPMOST, $newX, $newY, $newW, $newH, $SWP_SHOWWINDOW)
  return $t
}

# Vagt-loekken: klip efter titlen til vinduet forsvinder. Idempotent — samme
# titel giver samme region, saa den anvendes kun ved aendring.
function Watch-OverlayRegion {
  param([IntPtr]$hwnd, [int]$clip)
  # Kun EEN vagt ad gangen: bat-filen starter en, og launcheren starter selv
  # en, hvis ingen koerer. Muteksen goer de overskydende til stille no-ops.
  $mtx = New-Object System.Threading.Mutex($false, 'Local\RL-Overlay-Watch')
  $got = $false
  try { $got = $mtx.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $got = $true }   # forrige vagt doede - pladsen er ledig
  catch { $got = $false }
  if (-not $got) { return }
  $last = $null
  while ($true) {
    $probe = [OverlayWin]::FindByTitle([string][char]0x200B)
    if ($probe -eq [IntPtr]::Zero) { break }        # vinduet lukket — vagten doer med det
    if ($probe -ne $hwnd) { $hwnd = $probe; $last = $null }   # nyt vindue efter genstart — foelg det
    $sb = New-Object System.Text.StringBuilder 1024
    [void][OverlayWin]::GetWindowText($hwnd, $sb, 1024)
    if ($sb.ToString() -ne $last) { $last = Update-OverlayFit -hwnd $hwnd }
    Start-Sleep -Milliseconds 600
  }
}

# Uden vagt bliver vinduet staaende i den stoerrelse det blev aabnet i:
# kasserne skifter stoerrelse hele sessionen (debrief kommer og gaar, score
# vokser, kampen starter). Launcheren starter derfor selv en skjult vagt -
# muteksen i loekken sikrer, at bat-filens ekstra vagt bare doer stille.
function Start-OverlayWatcher {
  if ($Watch) { return }
  try {
    Start-Process -FilePath 'powershell' -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', ('"' + $PSCommandPath + '"'), '-Watch') -ErrorAction Stop | Out-Null   # stien har mellemrum
  } catch { }
}

function Test-TrackerPort {
  $hit = netstat -an | Select-String -Pattern ':8341\s' | Select-String -Pattern 'LISTENING' | Select-Object -First 1
  return ($null -ne $hit)
}

# ---- defaults: saved config (explicit params win), else bottom-right corner ----
$cfg = $null
if (Test-Path $cfgPath) {
  try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $cfg = $null }
}
if (-not $PSBoundParameters.ContainsKey('W') -and $null -ne $cfg -and $null -ne $cfg.w) { $W = [int]$cfg.w }
if (-not $PSBoundParameters.ContainsKey('H') -and $null -ne $cfg -and $null -ne $cfg.h) { $H = [int]$cfg.h }
if (-not $PSBoundParameters.ContainsKey('Alpha') -and $null -ne $cfg -and $null -ne $cfg.alpha) {
  $Alpha = [double]$cfg.alpha
  if ($Alpha -lt 0.30) { $Alpha = 0.30 }
  if ($Alpha -gt 1.0)  { $Alpha = 1.0 }
}
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if (-not $PSBoundParameters.ContainsKey('X')) {
  if ($null -ne $cfg -and $null -ne $cfg.x) { $X = [int]$cfg.x } else { $X = $wa.Right - $W - 24 }
}
if (-not $PSBoundParameters.ContainsKey('Y')) {
  if ($null -ne $cfg -and $null -ne $cfg.y) { $Y = [int]$cfg.y } else { $Y = $wa.Bottom - $H - 24 }
}

# ---- single instance: reuse an existing overlay window instead of a new one ----
$existing = [OverlayWin]::FindByTitle($TITLE)
if ($existing -ne [IntPtr]::Zero) {
  [void][OverlayWin]::ShowWindow($existing, $SW_RESTORE)
  Set-OverlayStyle -hwnd $existing -alphaVal $Alpha -transparent $ClickThrough.IsPresent
  [void][OverlayWin]::SetWindowPos($existing, $HWND_TOPMOST, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW -bor $SWP_FRAMECHANGED))
  [void](Update-OverlayFit -hwnd $existing)
  [void][OverlayWin]::SetForegroundWindow($existing)
  Save-OverlayPos -hwnd $existing -alphaVal $Alpha -clip $ClipTop
  Write-Output "OVERLAY: existing window brought to front (alpha=$Alpha reapplied)"
  Start-OverlayWatcher
  if ($Watch) { Watch-OverlayRegion -hwnd $existing -clip $ClipTop }
  exit 0
}

# ---- (a) make sure the tracker server listens on :8341 ----
if (-not (Test-TrackerPort)) {
  $exeLocal = Join-Path $PSScriptRoot 'RLTrackerServer.exe'                              # portable layout (script next to exe)
  $exeDist  = Join-Path $PSScriptRoot '..\dist\RL-Tracker-Portable\RLTrackerServer.exe'  # repo layout (script in scripts\)
  if (Test-Path $exeLocal) {
    Start-Process -FilePath $exeLocal -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
  } elseif (Test-Path $exeDist) {
    $exeFull = (Resolve-Path $exeDist).Path
    Start-Process -FilePath $exeFull -WorkingDirectory (Split-Path -Parent $exeFull) -WindowStyle Minimized
  } else {
    $workDir = $null
    if (Test-Path (Join-Path $PSScriptRoot 'server.js')) { $workDir = $PSScriptRoot }
    elseif (Test-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'server.js')) { $workDir = Split-Path -Parent $PSScriptRoot }
    if ($null -eq $workDir) { Write-Output 'OVERLAY: no RLTrackerServer.exe and no server.js found - cannot start the server'; exit 1 }
    try { Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $workDir -WindowStyle Minimized -ErrorAction Stop }
    catch { Write-Output 'OVERLAY: Node.js not found and no RLTrackerServer.exe - cannot start the server'; exit 1 }
  }
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-TrackerPort) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-TrackerPort)) { Write-Output 'OVERLAY: server did not listen on port 8341 within 15 s'; exit 1 }
}

# ---- (b) open the overlay page as an app window (Chrome, fallback Edge) ----
# EGEN proces + software-rendering er selve nøglen til gennemsigtigheden:
# i brugerens almindelige Chrome-proces komposittes vinduet på GPU'en, og dér
# ignoreres BÅDE LWA_COLORKEY og SetWindowRgn (målt 31/7 — begge bed ikke).
# Med --user-data-dir får overlayet sin egen browser-proces, og uden
# GPU-kompositering virker color-key'en klassisk: baggrundsfarven #010101
# bliver pixel-perfekt usynlig, inkl. afrundede hjørner.
$profileDir = Join-Path $PSScriptRoot 'overlay-profile'
# --app er den stabile bane. Kiosk blev forsoegt 31/7 for at slippe for
# titelbjaelken, men kiosk-vinduer nagter resize: de minimerer sig ved
# fokustab og genopstaar i FULDSKAERM. Titelbjaelken bestaar derfor (viser
# kun "RL Overlay" — geometrisignalet er kodet i usynlige tegn); at fjerne
# den helt kraever en native renderer (v2).
$appArgs = @("--app=$URL", "--window-size=$W,$H", "--window-position=$X,$Y",
             "--user-data-dir=$profileDir", "--disable-gpu-compositing",
             "--no-first-run", "--no-default-browser-check",
             "--lang=da", "--disable-features=Translate,TranslateUI")
try { Start-Process -FilePath 'chrome' -ArgumentList $appArgs -ErrorAction Stop }
catch {
  try { Start-Process -FilePath 'msedge' -ArgumentList $appArgs -ErrorAction Stop }
  catch { Write-Output 'OVERLAY: neither Chrome nor Edge could be started'; exit 1 }
}

# ---- (c) wait for the window (page sets the exact title when loaded) ----
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  $hwnd = [OverlayWin]::FindByTitle($TITLE)
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 400
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "OVERLAY WINDOW: NOT FOUND (no window titled '$TITLE' within 15 s)"; exit 1 }

# ---- (d) layered transparency (+ optional click-through), (e) always on top ----
Set-OverlayStyle -hwnd $hwnd -alphaVal $Alpha -transparent $ClickThrough.IsPresent
# Med beskæring: vinduet gøres ClipTop px højere og skubbes ClipTop px op, så
# det SYNLIGE udsnit (regionen fra ClipTop og ned) lander præcis på X,Y,W,H.
$winY = $Y; $winH = $H
if ($ClipTop -gt 0) { $winY = $Y - $ClipTop; $winH = $H + $ClipTop }
[void][OverlayWin]::SetWindowPos($hwnd, $HWND_TOPMOST, $X, $winY, $W, $winH, ($SWP_SHOWWINDOW -bor $SWP_FRAMECHANGED))
[void](Update-OverlayFit -hwnd $hwnd)

# ---- (f) remember placement for next launch (actual window rect) ----
Save-OverlayPos -hwnd $hwnd -alphaVal $Alpha -clip $ClipTop
$mode = 'normal'
if ($ClickThrough) { $mode = 'click-through' }
Write-Output "OVERLAY: placed at $X,$Y (${W}x${H}), alpha=$Alpha, topmost, $mode (handle $hwnd)"
Start-OverlayWatcher
if ($Watch) { Watch-OverlayRegion -hwnd $hwnd -clip $ClipTop }
