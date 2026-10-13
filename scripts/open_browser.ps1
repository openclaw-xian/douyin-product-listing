param(
  [string]$WorkDir = "",
  [int]$Port = 0,
  [string]$StartUrl = "https://fxg.jinritemai.com",
  [string]$Profile = "",
  [switch]$ForceNewProfile
)

# 路径全部经 resolve_env 解析（config.json > 环境变量 > 自动探测）
# 与 pdd-product-listing 的同名脚本同构，只换前缀与默认站点。
. (Join-Path $PSScriptRoot "resolve_env.ps1")
$e = $script:DyEnv

if ($Port -eq 0) { $Port = [int]$e.default_port }
if (-not $WorkDir) { $WorkDir = $e.workdir }
if (-not $Profile) { $Profile = $e.chrome_profile }

$chrome = $e.chrome
if (-not $chrome) {
  Write-Error "Chrome not found. Set chrome in config.json or env DY_CHROME."
  exit 1
}

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

# profile 优先级：显式/配置 > 复用既有 > 新建
$userDataArgs = @()
if ($Profile -and (Test-Path $Profile)) {
  $userDataArgs = @("--user-data-dir=$Profile")
  Write-Host "PROFILE reuse explicit: $Profile"
} elseif (-not $ForceNewProfile -and $e.reuse_profile) {
  $defaultProfile = Join-Path $WorkDir "chrome-profile"
  if (-not (Test-Path (Join-Path $defaultProfile "Default"))) {
    New-Item -ItemType Directory -Path $defaultProfile -Force | Out-Null
    Write-Host "PROFILE create (first run, will need login): $defaultProfile"
  } else {
    Write-Host "PROFILE reuse existing: $defaultProfile"
  }
  $userDataArgs = @("--user-data-dir=$defaultProfile")
} else {
  $defaultProfile = Join-Path $WorkDir "chrome-profile-fresh"
  New-Item -ItemType Directory -Path $defaultProfile -Force | Out-Null
  $userDataArgs = @("--user-data-dir=$defaultProfile")
  Write-Host "PROFILE fresh (ForceNewProfile): $defaultProfile"
}

# CDP 已在跑就不要另开一个 Chrome
try {
  $existing = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 3
  if ($existing.StatusCode -eq 200) {
    Write-Host "CDP_OK already port=$Port"
    exit 0
  }
} catch {}

$argList = @(
  "--remote-debugging-port=$Port"
) + $userDataArgs + @(
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1400,900",
  $StartUrl
)

Start-Process -FilePath $chrome -ArgumentList $argList
Start-Sleep -Seconds 3

try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 5 | Out-Null
  Write-Host "CDP_OK port=$Port"
} catch {
  Write-Error "CDP not ready on port $Port"
  exit 2
}
