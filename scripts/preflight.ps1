# 环境自检（开工前先跑）：一口气报出「能不能跑」，而不是跑到一半才炸。
#
# 用法：
#   & "<skillRoot>\scripts\preflight.ps1" -Category 墙贴              # 检查所有已登记的店
#   & "<skillRoot>\scripts\preflight.ps1" -Category 墙贴 -Shop 示例店铺
#   & "<skillRoot>\scripts\preflight.ps1" -Port 9228                  # 只测某个端口
#
# 检查项：
#   1) Node / Python 可执行文件能不能解析到
#   2) Python 依赖：openpyxl（解析素材包）、Pillow（图片适配）
#   3) playwright-core 能不能解析到（DY_PLAYWRIGHT → 技能自带 tools/npm → 机器级）
#   4) **按店**的 CDP 端口可达 + 里面有没有抖店页（= 已登录过）；不传 -Shop 就把登记的店逐家查
#   5) 目标类目的官方素材包有没有登记 & 文件是否还在（模板决定 cateId/属性集/选项表；可按店覆盖）
#
# 退出码：0 = 全过（可开工）；1 = 有阻断项（先修）；2 = 只有警告（可开工，但要知道风险）
param(
  [string]$Category = "",
  [int]$Port = 0,
  [string]$Shop = "",
  [switch]$Quiet
)

. (Join-Path $PSScriptRoot 'resolve_env.ps1')
$e = $script:DyEnv
$skillRoot = $script:DySkillRoot
# ⚠️ 必须记住「用户到底有没有显式传 -Port」：下面给 $Port 兜默认值之后，
#   再判断 `$Port -gt 0` 就永远为真 → 「按店逐家检查」的分支永不触发（实测踩过）。
$portGiven = $Port -gt 0
if ($Port -eq 0) { $Port = [int]$e.default_port }

$blockers = @()
$warns = @()

function Ok($msg)   { if (-not $Quiet) { Write-Host ("  [ OK ] " + $msg) -ForegroundColor Green } }
function Bad($msg)  { Write-Host ("  [FAIL] " + $msg) -ForegroundColor Red; $script:blockers += $msg }
function Warn($msg) { Write-Host ("  [warn] " + $msg) -ForegroundColor Yellow; $script:warns += $msg }
function Head($msg) { Write-Host ""; Write-Host ("== " + $msg) -ForegroundColor Cyan }

Head "1) 运行时"
if ($e.node -and (Test-Path $e.node)) { Ok "node = $($e.node)" } else { Bad "找不到 node（改 config.json.node 或设 DY_NODE）" }
if ($e.python -and (Test-Path $e.python)) { Ok "python = $($e.python)" } else { Bad "找不到 python（改 config.json.python 或设 DY_PYTHON）" }

Head "2) Python 依赖"
if ($e.python -and (Test-Path $e.python)) {
  $dep = & $e.python -c "import openpyxl, PIL; print('openpyxl', openpyxl.__version__, '| Pillow', PIL.__version__)" 2>&1
  if ($LASTEXITCODE -eq 0) { Ok "$dep" } else { Bad "缺依赖：$dep（该解释器要装 openpyxl + Pillow）" }
}

Head "3) playwright-core"
if ($e.node -and (Test-Path $e.node)) {
  # 用技能自己的解析器（scripts\pwresolver.js 的 CLI 壳）判依赖 —— 不能再用
  # `require.resolve('playwright-core')`：那条只认机器级 node_modules，
  # **只有技能自带副本的机器会被误判 FAIL**（自带份在 tools\npm\node_modules）。
  $whichPw = Join-Path $skillRoot "scripts\which_pw.js"
  if (-not (Test-Path $whichPw)) {
    Bad "缺 scripts\which_pw.js（自检/依赖判定要用它）"
  } else {
    $pwj = & $e.node $whichPw 2>&1 | Out-String
    if ($pwj -match '"ok":\s*true') {
      $how  = ([regex]::Match($pwj, '"how":\s*"([^"]+)"')).Groups[1].Value
      $spec = ([regex]::Match($pwj, '"spec":\s*"([^"]+)"')).Groups[1].Value
      $specSafe = $spec -replace '\\\\', '\'
      if ($specSafe -match 'tools\\npm') { Ok ("技能自带：$specSafe（换机器也能跑）") }
      elseif ($how -match 'DY_PLAYWRIGHT') { Ok ("DY_PLAYWRIGHT 指定：$specSafe") }
      else { Warn ("仅机器级解析：$specSafe —— 只在这台机器成立；技能自带那份应在 tools\npm\node_modules\playwright-core") }
    } else {
      Bad "playwright-core 找不到 —— 确认技能目录下有 tools\npm\node_modules\playwright-core，或在 config.json 的 playwright_core 写绝对路径"
    }
  }
}

Head "4) 抖店 CDP 端口（按店）"
# ★ 多店铺：**不写死店铺** —— 以 config.json 的 shops 为准（与 pdd 同构：一店 = 一 Chrome 实例 + 一端口）。
#   不传 -Shop 时把已登记的店**每家都查一遍**（多店场景下「只查一家就报全绿」是最容易骗过自己的假绿）。
$targets = @()
if ($portGiven) {
  $targets += @{ name = "(命令行 -Port)"; port = $Port }
} elseif ($e.shops) {
  $names = @($e.shops.PSObject.Properties.Name)
  if ($Shop) {
    if ($names -contains $Shop) { $targets += @{ name = $Shop; port = [int]$e.shops.$Shop.port } }
    else { Bad "config.shops 里没有店「$Shop」；已登记：$($names -join ' / ')" }
  } else {
    foreach ($n in $names) { $targets += @{ name = $n; port = [int]$e.shops.$n.port } }
    if ($names.Count -gt 1) { Write-Host ("  已登记 $($names.Count) 家店，逐家检查：" + ($names -join ' / ')) -ForegroundColor DarkGray }
  }
} else {
  $targets += @{ name = "(未登记店铺)"; port = [int]$e.default_port }
}
foreach ($t in $targets) {
  $tp = $t.port
  try {
    $ver = Invoke-WebRequest -Uri "http://127.0.0.1:$tp/json/version" -UseBasicParsing -TimeoutSec 4
    Ok ("[$($t.name)] 端口 $tp 可达：" + (($ver.Content | ConvertFrom-Json).Browser))
    $list = Invoke-WebRequest -Uri "http://127.0.0.1:$tp/json/list" -UseBasicParsing -TimeoutSec 6
    $pages = @(($list.Content | ConvertFrom-Json) | Where-Object { $_.type -eq 'page' })
    $dy = @($pages | Where-Object { $_.url -match 'jinritemai\.com' })
    if ($dy.Count -gt 0) { Ok "[$($t.name)] 抖店页 $($dy.Count) 个（说明已登录过）" }
    else { Bad "[$($t.name)] 端口 $tp 里没有 jinritemai.com 的页面 —— 先打开 https://fxg.jinritemai.com 并登录（本技能不代登录）" }
    if ($pages.Count -gt 8) { Warn "[$($t.name)] 页面数 $($pages.Count) 偏多；连店时 closeHungTabs 会探活并关掉卡死页" }
  } catch {
    Bad "[$($t.name)] 端口 $tp 不可达 —— 该店 Chrome 没开、或没带 --remote-debugging-port=$tp（可用 scripts/open_browser.ps1 -Port $tp）"
  }
}

Head "5) 类目模板"
# 用 resolve_env 解析好的合并表（全局 templates + 该店的 shops.<店>.templates 覆盖）——
# 类目选项集/品牌是**店级**的，所以允许按店换模板。读 UTF-8 必须显式 -Encoding（PS 5.1 默认按 GBK → JSON 抛异常）。
$tpl = $e.templates
if (-not $tpl -or @($tpl.Keys).Count -eq 0) {
  Warn "config.json 里没有 templates 登记表（无法检查模板）"
} elseif (-not $Category) {
  $names = @($tpl.Keys)
  Ok ("已登记类目：" + ($names -join ' / ') + "   （用 -Category 指定本单类目来检查）")
} else {
  $hit = $tpl[$Category]
  if (-not $hit) {
    Bad "类目「$Category」没登记素材包 —— 请让用户给一份**含抖店上架信息的素材包**：抖店后台按该类目导出的那份 Excel（里面有「抖音」sheet：类目+cateId、属性字段、允许值、SKU 列）+ 配套素材目录。不要拿别的类目的顶替（类目会填错）。"
  } elseif (-not (Test-Path $hit.path)) {
    Bad "类目「$Category」登记了模板但文件不在：$($hit.path)（可能被移动/改名）"
  } else {
    $who = if ($Shop -and $e.shop -eq $Shop) { "（按店 $($e.shop)）" } elseif ($e.shop) { "（按店 $($e.shop)）" } else { "" }
    Ok "类目「$Category」：cateId=$($hit.cate_id)，模板在 $($hit.path) $who"
    if ($hit.note) { Write-Host "        备注：$($hit.note)" -ForegroundColor DarkGray }
  }
}

Write-Host ""
if ($blockers.Count -gt 0) {
  Write-Host ("★ 有 $($blockers.Count) 项阻断，先修再开工：") -ForegroundColor Red
  $blockers | ForEach-Object { Write-Host ("   - " + $_) -ForegroundColor Red }
  exit 1
}
if ($warns.Count -gt 0) {
  Write-Host ("✓ 可开工（$($warns.Count) 项警告）") -ForegroundColor Yellow
  exit 2
}
Write-Host "✓ 全部通过，可以开工" -ForegroundColor Green
exit 0
