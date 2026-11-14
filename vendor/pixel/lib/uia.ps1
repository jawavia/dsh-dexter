# dsh-click-matrix - UI Automation observation script (Windows PowerShell 5.1).
# Reads one base64-encoded JSON request from -InputBase64, writes one JSON line
# to stdout. Read-only: never invokes, never sets focus, never sends input.
#
# Request:
# { "mode": "foreground"|"handle"|"pid", "handle": 123, "pid": 456,
#   "region": {"x":0,"y":0,"w":100,"h":100}, "maxElements": 60 }
# Response:
# { ok:true, dpiAware:true, mode, window:{handle,title,pid,process,className},
#   scanned, truncated, elements:[{type,name,automationId,rect:{x,y,width,height},
#   center:{x,y},patterns:[],isEnabled,processId,className,frameworkId}] }
# or { ok:false, error:"..." }.
# ASCII-only source. All coordinates are physical screen px (Per-Monitor-V2 aware).

param(
  [Parameter(Mandatory = $false)][string]$InputBase64 = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

function Write-JsonResult($obj) {
  try {
    $json = $obj | ConvertTo-Json -Depth 8 -Compress
  } catch {
    $json = '{"ok":false,"error":"json encode failed"}'
  }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Fail($message, $extra) {
  $out = @{ ok = $false; error = [string]$message }
  if ($extra) { foreach ($k in $extra.Keys) { $out[$k] = $extra[$k] } }
  Write-JsonResult $out
  exit 0
}

# ---- DPI awareness (must run before any UIA query) -------------------------
$script:DpiAware = $false
try {
  $dpiType = Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetSystemMetrics(int index);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr OpenProcess(uint access, bool inherit, uint pid);
[System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
public static extern bool OpenProcessToken(System.IntPtr process, uint access, out System.IntPtr token);
[System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
public static extern bool GetTokenInformation(System.IntPtr token, int infoClass, System.IntPtr info, int size, out int returned);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool CloseHandle(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern bool QueryFullProcessImageNameW(System.IntPtr process, int flags, System.Text.StringBuilder name, ref int size);
'@ -Name 'UiaWin32' -Namespace 'ClickMatrix' -PassThru
  # Add-Type -PassThru returns an ARRAY whenever MemberDefinition compiles more
  # than one type (a nested struct used to do exactly that). Selecting the type
  # that owns GetForegroundWindow keeps every $script:Win32 call valid.
  $dpiType = @($dpiType) | Where-Object {
    $_ -is [System.Type] -and $null -ne $_.GetMethod('GetForegroundWindow')
  } | Select-Object -First 1
  if ($null -eq $dpiType) { throw 'UiaWin32 type resolution failed' }
  try {
    if ($dpiType::SetProcessDpiAwarenessContext([System.IntPtr](-4))) { $script:DpiAware = $true }
  } catch { }
  if (-not $script:DpiAware) {
    try { if ($dpiType::SetProcessDPIAware()) { $script:DpiAware = $true } } catch { }
  }
} catch {
  $dpiType = $null
}
$script:Win32 = $dpiType

# ---- virtual screen bounds (off-screen element filter) ---------------------
# Minimized windows expose UIA elements whose BoundingRectangle sits around
# +/-32000 (the classic minimized-window phantom position). Those rects are
# physically unclickable and only pollute the observation output; the element
# loop below drops any rect that lies entirely outside the virtual screen (with
# a 200 px tolerance so partially visible edge elements survive). Queried after
# DPI awareness is set so the bounds are real physical pixels.
$script:VirtualScreen = $null
try {
  $vsX = [int]$script:Win32::GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
  $vsY = [int]$script:Win32::GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
  $vsW = [int]$script:Win32::GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
  $vsH = [int]$script:Win32::GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN
  if ($vsW -gt 0 -and $vsH -gt 0) {
    $script:VirtualScreen = @{ x = $vsX; y = $vsY; w = $vsW; h = $vsH }
  }
} catch {
  $script:VirtualScreen = $null
}

# ---- parse request ---------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($InputBase64)) {
  Fail 'missing -InputBase64 payload'
}
try {
  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($InputBase64))
  $cfg = $json | ConvertFrom-Json
} catch {
  Fail ('bad request json: ' + $_.Exception.Message)
}
if ($cfg -eq $null) { Fail 'empty request' }

$mode = 'foreground'
if ($cfg.mode -and ($cfg.mode -is [string])) { $mode = [string]$cfg.mode }
$handle = 0L
if ($cfg.handle) { try { $handle = [int64]$cfg.handle } catch { $handle = 0 } }
$targetPid = 0
if ($cfg.pid) { try { $targetPid = [int]$cfg.pid } catch { $targetPid = 0 } }
$maxElements = 60
if ($cfg.maxElements) { try { $maxElements = [int]$cfg.maxElements } catch { $maxElements = 60 } }
if ($maxElements -lt 1) { $maxElements = 1 }
if ($maxElements -gt 60) { $maxElements = 60 }
$region = $null
if ($cfg.region) {
  try {
    $region = @{
      x = [int]$cfg.region.x; y = [int]$cfg.region.y
      w = [int]$cfg.region.w;  h = [int]$cfg.region.h
    }
  } catch { $region = $null }
}

# ---- load UIA --------------------------------------------------------------
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Fail ('UIA assemblies unavailable: ' + $_.Exception.Message)
}
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-WindowPath($h) {
  if (-not $h -or $h -eq [System.IntPtr]::Zero) { return '' }
  try {
    [uint32]$pidOut = 0
    [void]$script:Win32::GetWindowThreadProcessId($h, [ref]$pidOut)
    if ($pidOut -eq 0) { return '' }
    $proc = Get-Process -Id $pidOut -ErrorAction SilentlyContinue
    if ($proc) { return [string]$proc.Path }
  } catch { }
  return ''
}

# Resolve the target window (AutomationElement + metadata).
$winEl = $null
$winHandle = [System.IntPtr]::Zero
try {
  if ($mode -eq 'handle' -and $handle -ne 0) {
    $winHandle = [System.IntPtr]$handle
  } elseif ($mode -eq 'pid' -and $targetPid -ne 0) {
    $rootEl = $AE::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]$targetPid)
    $winEl = $rootEl.FindFirst($TS::Children, $cond)
    if ($winEl) { $winHandle = [System.IntPtr]$winEl.Current.NativeWindowHandle }
  } else {
    $fg = $script:Win32::GetForegroundWindow()
    if ($fg -ne [System.IntPtr]::Zero) { $winHandle = $fg }
  }
} catch {
  Fail ('resolve window failed: ' + $_.Exception.Message)
}
if ($winHandle -eq [System.IntPtr]::Zero -and -not $winEl) {
  Fail 'no target window (foreground unavailable or invalid handle/pid)'
}
if (-not $winEl) {
  try { $winEl = $AE::FromHandle($winHandle) } catch { Fail ('AutomationElement.FromHandle failed: ' + $_.Exception.Message) }
}
if (-not $winEl) { Fail 'target window has no AutomationElement' }

# Window metadata (handle/title/pid/process/className).
$winInfo = @{ handle = [int64]$winHandle; title = ''; pid = 0; process = ''; className = '' }
try {
  $winInfo.title = [string]$winEl.Current.Name
  $winInfo.pid = [int]$winEl.Current.ProcessId
  $winInfo.className = [string]$winEl.Current.ClassName
  $winInfo.process = Get-WindowPath $winHandle
} catch { }
# Fallback to Win32 title when UIA name is empty.
if ([string]::IsNullOrEmpty($winInfo.title) -and $winHandle -ne [System.IntPtr]::Zero) {
  try {
    $sb = New-Object System.Text.StringBuilder 512
    [void]$script:Win32::GetWindowTextW($winHandle, $sb, $sb.Capacity)
    $winInfo.title = $sb.ToString()
  } catch { }
}

# ---- enumerate -------------------------------------------------------------
$started = [DateTime]::UtcNow
$interactiveTypes = @(
  'ControlType.Button', 'ControlType.CheckBox', 'ControlType.ComboBox',
  'ControlType.DataItem', 'ControlType.Document', 'ControlType.Edit',
  'ControlType.Hyperlink', 'ControlType.ListItem', 'ControlType.Menu',
  'ControlType.MenuItem', 'ControlType.RadioButton', 'ControlType.ScrollBar',
  'ControlType.Slider', 'ControlType.Spinner', 'ControlType.SplitButton',
  'ControlType.Tab', 'ControlType.TabItem', 'ControlType.Text',
  'ControlType.TreeItem', 'ControlType.Custom', 'ControlType.Pane'
)
$patternNames = @('Invoke', 'Toggle', 'SelectionItem', 'ExpandCollapse', 'Value', 'ScrollItem', 'RangeValue', 'Text')
$patternIds = @{
  Invoke = 10000; Toggle = 10015; SelectionItem = 10010; ExpandCollapse = 10005;
  Value = 10002; ScrollItem = 10017; RangeValue = 10003; Text = 10014
}
$elements = New-Object System.Collections.ArrayList
$scanned = 0
$truncated = $false
$seen = @{}
$total = 0
try {
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all = $winEl.FindAll($TS::Descendants, $cond)
  $total = $all.Count
  for ($i = 0; $i -lt $total; $i++) {
    $el = $all.Item($i)
    if (-not $el) { continue }
    $scanned++
    if ($elements.Count -ge $maxElements) { $truncated = $true; break }
    # Per-element tolerance: WinUI/XAML windows (e.g. Calculator) expose elements
    # whose BoundingRectangle is Infinity/NaN or whose property reads throw. One
    # bad element must never abort the whole observation, so the entire
    # attribute extraction lives in a try/catch and continues with the next one.
    try {
      $cur = $el.Current
      if ($cur -eq $null) { continue }
      if ($cur.IsOffscreen) { continue }
      $typeName = ''
      try { $typeName = [string]$cur.ControlType.ProgrammaticName } catch { continue }
      if (-not ($interactiveTypes -contains $typeName)) { continue }
      $rectObj = $null
      try { $rectObj = $cur.BoundingRectangle } catch { $rectObj = $null }
      if (-not $rectObj) { continue }
      # Guard the Int32 conversion: an infinite/NaN rect would throw
      # OverflowException and used to kill the whole enumeration.
      $rawX = 0.0
      $rawY = 0.0
      $rawW = 0.0
      $rawH = 0.0
      try {
        $rawX = [double]$rectObj.X
        $rawY = [double]$rectObj.Y
        $rawW = [double]$rectObj.Width
        $rawH = [double]$rectObj.Height
      } catch { continue }
      if ([double]::IsNaN($rawX) -or [double]::IsNaN($rawY) -or [double]::IsNaN($rawW) -or [double]::IsNaN($rawH)) { continue }
      if ([double]::IsInfinity($rawX) -or [double]::IsInfinity($rawY) -or [double]::IsInfinity($rawW) -or [double]::IsInfinity($rawH)) { continue }
      if ($rawW -lt 2 -or $rawH -lt 2) { continue }
      # Skip absurd-but-finite rects before rounding to Int32.
      if ($rawX -lt -2000000 -or $rawX -gt 2000000 -or $rawY -lt -2000000 -or $rawY -gt 2000000) { continue }
      if ($rawW -gt 100000 -or $rawH -gt 100000) { continue }
      $rx = [int][Math]::Round($rawX)
      $ry = [int][Math]::Round($rawY)
      $rw = [int][Math]::Round($rawW)
      $rh = [int][Math]::Round($rawH)
      if ($rw -lt 2 -or $rh -lt 2) { continue }
      # Drop elements whose whole rect sits outside the virtual screen. A
      # minimized window reports phantom rects around +/-32000; they are not
      # clickable and used to leak into screen_text output. The 200 px tolerance
      # keeps legitimately positioned windows (maximized, negative-coordinate
      # secondary monitor, partially visible edges) untouched.
      if ($script:VirtualScreen) {
        $vs = $script:VirtualScreen
        $tolerance = 200
        if (($rx + $rw) -lt ($vs.x - $tolerance)) { continue }
        if ($rx -gt ($vs.x + $vs.w + $tolerance)) { continue }
        if (($ry + $rh) -lt ($vs.y - $tolerance)) { continue }
        if ($ry -gt ($vs.y + $vs.h + $tolerance)) { continue }
      }
      if ($region) {
        if ($rx + $rw -le $region.x -or $ry + $rh -le $region.y) { continue }
        if ($rx -ge $region.x + $region.w -or $ry -ge $region.y + $region.h) { continue }
      }
      # Skip the whole-screen container panes to keep the list meaningful.
      if (($typeName -eq 'ControlType.Pane' -or $typeName -eq 'ControlType.Custom') -and ($rw * $rh) -gt 400000) { continue }
      $name = ''
      try { $name = [string]$cur.Name } catch { }
      $autoId = ''
      try { $autoId = [string]$cur.AutomationId } catch { }
      $cls = ''
      try { $cls = [string]$cur.ClassName } catch { }
      $typeShort = $typeName -replace '^ControlType\.', ''
      if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($autoId) -and $typeShort -eq 'Text') { continue }
      $key = '{0}|{1}|{2}|{3}' -f $typeShort, $name, $rx, $ry
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $patterns = New-Object System.Collections.ArrayList
      foreach ($p in $patternNames) {
        try {
          $patternObj = $null
          $ok = $el.TryGetCurrentPattern([System.Windows.Automation.AutomationPattern]::LookupById($patternIds[$p]), [ref]$patternObj)
          if ($ok) { [void]$patterns.Add($p) }
        } catch { }
      }
      $enabled = $true
      try { $enabled = [bool]$cur.IsEnabled } catch { }
      $item = @{
        type = $typeShort
        name = $name
        automationId = $autoId
        className = $cls
        rect = @{ x = $rx; y = $ry; width = $rw; height = $rh }
        center = @{ x = [int][Math]::Floor($rx + $rw / 2); y = [int][Math]::Floor($ry + $rh / 2) }
        patterns = @($patterns)
        isEnabled = $enabled
        processId = 0
      }
      try { $item.processId = [int]$cur.ProcessId } catch { }
      [void]$elements.Add($item)
    } catch {
      # Skip only this element; keep enumerating the remaining subtree.
      continue
    }
  }
} catch {
  Fail ('UIA enumeration failed: ' + $_.Exception.Message) @{ window = $winInfo }
}

# Stable reading order: top-to-bottom, then left-to-right.
$sorted = @($elements | Sort-Object @{ Expression = { $_.rect.y } }, @{ Expression = { $_.rect.x } })
$elapsed = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
Write-JsonResult @{
  ok = $true
  dpiAware = $script:DpiAware
  mode = $mode
  window = $winInfo
  scanned = $scanned
  totalElements = $total
  truncated = $truncated
  elapsedMs = $elapsed
  elements = @($sorted)
}
exit 0
