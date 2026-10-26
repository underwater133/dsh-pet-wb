<#
.SYNOPSIS
  dsh-pet 桌宠 · Windows 启动器（独立模式，不需要打开 DSH）
.DESCRIPTION
  做三件事：
    1. 补桌面快捷方式（幂等，排在「已经在跑」判断之前 —— 图标被删、仓库搬家后，
       跑一次就回来，宠物正在运行的情况也算）
    2. 体检：node / lib\standalone.js / Electron 缓存 / 当前配置里的宠物条目
    3. 隐藏控制台启动 node lib\standalone.js，stdout+stderr 追加到 dsh-pet\standalone.log
  所有路径都按本文件所在位置推导，脚本里没有任何绝对路径 —— 仓库克隆到任何目录、
  任何机器上，双击 start-pet.vbs 就能用；换机器只需带上仓库 + node。
.PARAMETER Check
  只体检并打印结果：不建快捷方式、不启动进程
.PARAMETER NoLaunch
  体检 + 建快捷方式，但不启动进程
.PARAMETER ShortcutOnly
  只补桌面快捷方式：不体检、不启动、不管是否已在运行
.PARAMETER NoShortcut
  跳过桌面快捷方式创建
.PARAMETER HostKind
  接入的宿主：workbuddy（默认，工作状态来自 WorkBuddy hooks）| dsh（不接任何会话事件）
.PARAMETER Notify
  错误与提示用弹窗显示（start-pet.vbs 用隐藏窗口调起本脚本，靠它把失败告诉用户）
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-pet.ps1 -Check
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-pet.ps1 -ShortcutOnly
#>
param(
  [switch]$Check,
  [switch]$NoLaunch,
  [switch]$ShortcutOnly,
  [switch]$NoShortcut,
  [switch]$Notify,
  [ValidateSet('workbuddy', 'dsh')]
  [string]$HostKind = 'workbuddy'
)

$ErrorActionPreference = 'Stop'

# ---- 路径：全部相对本脚本推导，不写死 ----
$here    = $PSScriptRoot
$pkg     = Split-Path -Parent $here          # 包根（dsh-pet/）
$entry   = Join-Path $pkg  'lib\standalone.js'
$logFile = Join-Path $pkg  'standalone.log'
$iconPath = Join-Path $here '.pet-icon.ico'
$vbsPath  = Join-Path $here 'start-pet.vbs'
$logoPath = Join-Path $pkg  'assets\logo.png'

$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$runtimePath = Join-Path $dshHome 'dsh-pet\standalone-runtime.json'
$configPath  = Join-Path $dshHome 'dsh-pet\main-config.jsonc'

function Say([string]$msg) { Write-Host "[dsh-pet] $msg" }

function Show-Fail([string]$msg) {
  Say "失败：$msg"
  if ($Notify) {
    (New-Object -ComObject WScript.Shell).Popup($msg, 0, 'dsh-pet', 16) | Out-Null
  }
  exit 1
}

function Read-Runtime {
  if (-not (Test-Path $runtimePath)) { return $null }
  try { return (Get-Content $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# 只判「进程还在不在」，不读命令行：受限权限下 Win32_Process.CommandLine 会是空串，
# 据此判「没在跑」会导致重复起进程（抢端口、互踩 Electron 缓存），代价远大于
# pid 被复用的那点概率（pid 只有强杀残留 runtime 后才可能被复用，且提示里带 pid 可自查）。
function Test-PetProc([int]$procId) {
  if ($procId -le 0) { return $false }
  return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

# assets\logo.png → PNG-in-ICO（Vista+ 支持，保留 alpha；.lnk 只认 ico/exe/dll，png 不能直接当图标）
function Ensure-Icon {
  if (-not (Test-Path $logoPath)) { return $null }
  if ((Test-Path $iconPath) -and ((Get-Item $iconPath).LastWriteTime -ge (Get-Item $logoPath).LastWriteTime)) {
    return $iconPath
  }
  Add-Type -AssemblyName System.Drawing
  $src = [System.Drawing.Image]::FromFile($logoPath)
  $dim = 256
  $scale = [Math]::Min($dim / $src.Width, $dim / $src.Height)
  $w = [int][Math]::Round($src.Width * $scale)
  $h = [int][Math]::Round($src.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap($dim, $dim)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, [int](($dim - $w) / 2), [int](($dim - $h) / 2), $w, $h)
  $g.Dispose()
  $src.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $png = $ms.ToArray()
  $ms.Dispose()

  $fs = [System.IO.File]::Create($iconPath)
  $bw = New-Object System.IO.BinaryWriter($fs)
  try {
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)   # ICONDIR: reserved/type(icon)/count
    $bw.Write([Byte]0);   $bw.Write([Byte]0)                          # width=256(0), height=256(0)
    $bw.Write([Byte]0);   $bw.Write([Byte]0)                          # colorCount, reserved
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)                       # planes, bitCount
    $bw.Write([UInt32]$png.Length); $bw.Write([UInt32]22)             # bytesInRes, imageOffset
    $bw.Write($png)
  } finally {
    $bw.Flush(); $bw.Dispose(); $fs.Dispose()
  }
  return $iconPath
}

# WorkBuddy hooks 是否已装：只读 settings.json 文本里认领标记的出现次数（7 个事件各一条）。
# 装没装决定「工作状态动画会不会动」——这是 --host workbuddy 唯一的输入源。
function Get-HookStatus {
  $wbHome = $env:WORKBUDDY_HOME
  if (-not $wbHome) { $wbHome = Join-Path $env:USERPROFILE '.workbuddy' }
  $file = Join-Path $wbHome 'settings.json'
  if (-not (Test-Path $file)) { return @{ Installed = $false; Count = 0; Path = $file } }
  try {
    $txt = Get-Content $file -Raw -Encoding UTF8
    $count = ([regex]::Matches($txt, 'workbuddy-hook\.mjs')).Count
    return @{ Installed = ($count -gt 0); Count = $count; Path = $file }
  } catch {
    return @{ Installed = $false; Count = 0; Path = $file }
  }
}

# ---- 1. 桌面快捷方式（幂等；必须排在「已经在跑」判断之前，否则删了图标就补不回来） ----
if (-not $NoShortcut -and -not $Check) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnkPath = Join-Path $desktop '桌宠.lnk'
  $wsh = New-Object -ComObject WScript.Shell
  $needBuild = $true
  if (Test-Path $lnkPath) {
    try {
      $cur = $wsh.CreateShortcut($lnkPath)
      if ($cur.Arguments -and $cur.Arguments.Contains($vbsPath)) { $needBuild = $false }
    } catch { }
  }
  if ($needBuild) {
    if (-not (Test-Path $vbsPath)) {
      Say "跳过快捷方式：同级目录没有 start-pet.vbs"
    } else {
      $icon = $null
      try { $icon = Ensure-Icon } catch { Say "图标生成失败（仍会建快捷方式）：$($_.Exception.Message)" }
      $lnk = $wsh.CreateShortcut($lnkPath)
      $lnk.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe')
      $lnk.Arguments = '"' + $vbsPath + '"'
      $lnk.WorkingDirectory = $pkg
      $lnk.Description = '启动 dsh-pet 桌宠（独立模式）'
      $lnk.WindowStyle = 1
      if ($icon) { $lnk.IconLocation = $icon + ',0' }
      $lnk.Save()
      Say "已创建桌面快捷方式：$lnkPath"
    }
  } else {
    Say "桌面快捷方式已存在且指向正确：$lnkPath"
  }
}

if ($ShortcutOnly) {
  Say '只补快捷方式：完成（不体检、不启动）。'
  exit 0
}

# ---- 2. 体检 ----
if (-not (Test-Path $entry)) {
  Show-Fail "找不到 $entry`n先构建一次：`n  cd `"$pkg`"`n  npm install`n  npm run build"
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Show-Fail "PATH 里找不到 node。请先安装 Node.js（>= 18），装完重开一次资源管理器再试。"
}
$nodePath = $nodeCmd.Source
if (-not $nodePath) { $nodePath = $nodeCmd.Path }

$nodeVersion = (& $nodePath -v) 2>$null

# Electron：与插件同一条探测顺序（显式路径 > DSH_HOME 缓存）
$electronPath = $env:DSH_PET_ELECTRON_PATH
if (-not $electronPath -or -not (Test-Path $electronPath)) {
  $cached = Join-Path $dshHome 'electron\electron.exe'
  if (Test-Path $cached) { $electronPath = $cached } else { $electronPath = $null }
}

# 配置快照（只为打印，不修改）
$petSummary = '（配置文件不存在，将使用包内默认配置）'
if (Test-Path $configPath) {
  try {
    $raw = Get-Content $configPath -Raw -Encoding UTF8
    # jsonc：去掉行注释再解析（够用即可，这里只读 pets[].id/size/display）
    $json = [regex]::Replace($raw, '(?m)^\s*//.*$', '')
    $cfg = $json | ConvertFrom-Json
    if ($cfg.pets) {
      $parts = @()
      foreach ($p in $cfg.pets) {
        $parts += ('{0}(size={1}, display={2})' -f $p.id, $p.size, $p.display)
      }
      $petSummary = ($parts -join '｜')
    }
  } catch {
    $petSummary = '（配置解析失败，启动时会回落默认值）'
  }
}

Say "包目录      $pkg"
Say "Node        $nodeVersion  $nodePath"
Say "Electron    $(if ($electronPath) { $electronPath } else { '未缓存（首次启动会自动下载，需联网；失败只影响桌面窗）' })"
Say "DSH_HOME    $dshHome"
Say "宠物配置    $petSummary"
Say "日志        $logFile"
if ($HostKind -eq 'workbuddy') {
  Say "宿主模式    workbuddy（工作状态来自 WorkBuddy hooks）"
  $hookInfo = Get-HookStatus
  if ($hookInfo.Installed) {
    Say "WB hooks    已安装：$($hookInfo.Count) 条  $($hookInfo.Path)"
  } else {
    Say "WB hooks    未安装 → 工作状态动画不会动。先跑："
    Say "              node scripts\install-workbuddy-hooks.mjs"
    Say "              装完完全退出 WorkBuddy 再启动（关窗口不算退出）"
  }
} else {
  Say "宿主模式    dsh（不接任何会话事件，工作状态动画不会动）"
}

# ---- 3. 已经在跑？ ----
$rt = Read-Runtime
$oldPid = 0
$alive = $null
if ($rt -and $rt.pid) {
  $oldPid = [int]$rt.pid
  if (Test-PetProc $oldPid) { $alive = $rt }
}

if ($alive) {
  Say "已经在运行：pid $($alive.pid)，端口 $($alive.port) → http://127.0.0.1:$($alive.port)/"
  if ($Notify) {
    (New-Object -ComObject WScript.Shell).Popup("桌宠已经在跑了（端口 $($alive.port)）", 2, 'dsh-pet', 64) | Out-Null
  }
  # 不重复启动：多开会互相踩 Electron 缓存
  exit 0
}

if ($Check) {
  Say '结论：环境就绪，可以启动。'
  exit 0
}

if ($NoLaunch) {
  Say '已就绪（未启动进程）：双击桌面「桌宠」或运行 start-pet.vbs 即可。'
  exit 0
}

# ---- 4. 启动（隐藏窗口，日志追加；--host 决定工作状态来源，漏了就只有待机动画） ----
$cmdLine = 'cmd /c cd /d "' + $pkg + '" && "' + $nodePath + '" lib\standalone.js --host ' + $HostKind + ' >> "' + $logFile + '" 2>&1'
(New-Object -ComObject WScript.Shell).Run($cmdLine, 0, $false) | Out-Null
Say "已拉起进程，等待 standalone-runtime.json …"

$deadline = (Get-Date).AddSeconds(25)
$newRt = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $cand = Read-Runtime
  if ($cand -and $cand.pid -and ([int]$cand.pid -ne $oldPid)) {
    if (Test-PetProc ([int]$cand.pid)) { $newRt = $cand; break }
  }
}

if (-not $newRt) {
  $tail = ''
  if (Test-Path $logFile) {
    $tail = (Get-Content $logFile -Tail 12 -Encoding UTF8) -join "`n"
  }
  Show-Fail "启动超时，进程没写出 runtime。日志末尾：`n$tail"
}

Say "已启动：pid $($newRt.pid)，端口 $($newRt.port) → http://127.0.0.1:$($newRt.port)/"
Say "面板（AI 设置）：$($newRt.settingsUrl)"
Say '退出：双击「停止桌宠.vbs」，或 Ctrl+C 结束终端里的进程。'
