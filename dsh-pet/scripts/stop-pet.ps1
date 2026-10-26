<#
.SYNOPSIS
  dsh-pet 桌宠 · Windows 停止器
.DESCRIPTION
  优先走 HTTP `POST /shutdown`（带 runtime 里的能力令牌）：这是插件自己的优雅退出路径，
  会一并收掉 Electron 桌面窗和 runtime 文件；
  服务无响应时才退化为按 pid 强杀，最后再兜底按命令行匹配。
  与 start-pet.ps1 一样，路径全部按脚本位置推导。
.PARAMETER Notify
  用弹窗报告结果（stop-pet.vbs 用隐藏窗口调起本脚本时会传）
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-pet.ps1
#>
param([switch]$Notify)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$pkg  = Split-Path -Parent $here
$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$runtimePath = Join-Path $dshHome 'dsh-pet\standalone-runtime.json'

function Say([string]$msg) { Write-Host "[dsh-pet] $msg" }

function Show-Result([string]$msg, [int]$icon) {
  Say $msg
  if ($Notify) {
    (New-Object -ComObject WScript.Shell).Popup($msg, 2, 'dsh-pet', $icon) | Out-Null
  }
}

$rt = $null
if (Test-Path $runtimePath) {
  try { $rt = Get-Content $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $rt = $null }
}

$pidTarget = 0
$port = 0
$token = ''
if ($rt) {
  if ($rt.pid)  { $pidTarget = [int]$rt.pid }
  if ($rt.port) { $port = [int]$rt.port }
  if ($rt.token) { $token = [string]$rt.token }
}

$proc = $null
if ($pidTarget -gt 0) { $proc = Get-Process -Id $pidTarget -ErrorAction SilentlyContinue }

if (-not $proc) {
  # pid 已死 / runtime 丢失：双路兜底找残留进程
  #   路 1 命令行匹配 —— 受限权限下 CommandLine 可能是空串，所以不能只靠这条
  #   路 2 端口 3080-3092 的监听者里挑 node（端口顺延范围）
  $targets = @()
  try {
    $targets = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains('standalone.js') } |
      Select-Object -ExpandProperty ProcessId)
  } catch { }

  if ($targets.Count -eq 0) {
    try {
      $owners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -ge 3080 -and $_.LocalPort -le 3092 } |
        Select-Object -ExpandProperty OwningProcess -Unique)
      foreach ($owner in $owners) {
        $ownerProc = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($ownerProc -and $ownerProc.ProcessName -eq 'node') { $targets += $owner }
      }
    } catch { }
  }

  if ($targets.Count -eq 0) {
    Show-Result '没有在运行的桌宠进程。' 64
    exit 0
  }
  foreach ($targetPid in $targets) {
    try { Stop-Process -Id $targetPid -Force -ErrorAction Stop } catch { }
  }
  Show-Result "已结束 $($targets.Count) 个桌宠进程（runtime 缺失，按命令行/端口匹配）。" 64
  exit 0
}

# ---- 1. 优雅退出：POST /shutdown + 能力令牌 ----
$graceful = $false
if ($port -gt 0 -and $token) {
  try {
    $headers = @{ 'X-DSH-Pet-Token' = $token }
    $null = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/shutdown" -f $port) -Method Post `
      -Headers $headers -UseBasicParsing -TimeoutSec 4
    $graceful = $true
    Say "已请求停机：http://127.0.0.1:$port/shutdown"
  } catch {
    Say "HTTP 停机失败（$($_.Exception.Message)），改用进程信号。"
  }
}

# ---- 2. 等进程退干净（最多 6 秒），否则强杀 ----
$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline) {
  if ($pidTarget -le 0) { break }
  if (-not (Get-Process -Id $pidTarget -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 250
}

$stillAlive = $false
if ($pidTarget -gt 0) { $stillAlive = [bool](Get-Process -Id $pidTarget -ErrorAction SilentlyContinue) }
if ($stillAlive) {
  try {
    Stop-Process -Id $pidTarget -Force -ErrorAction Stop
    $graceful = $false
    Say "已强制结束 pid $pidTarget。"
  } catch {
    Show-Result "结束进程失败：$($_.Exception.Message)" 16
    exit 1
  }
}

$how = '优雅停机'
if (-not $graceful) { $how = '强制结束' }
Show-Result "桌宠已停止（$how）。" 64
