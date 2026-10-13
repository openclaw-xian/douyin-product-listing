# 一条命令自检：证明「这套技能在当前机器上可用」。
#
# 为什么要有它：交接文档里的「记得做」全都会腐烂（BOM、门禁编号、引用路径、夹具能不能跑…）。
# 凡是能机械检查的，就不要靠记性 —— 这个脚本就是那些检查的落点。
#
# 用法：
#   & "<skillRoot>\scripts\selftest.ps1"           # 全跑（含 preflight：会连 CDP 端口看登录态）
#   & "<skillRoot>\scripts\selftest.ps1" -Quick    # 跳过 preflight（不碰浏览器/端口，纯离线）
#
# 退出码：0 = 全绿可开工；1 = 有失败项（每条都带「怎么修」）
#
# 检查项：
#   1) scripts\*.ps1 必须 UTF-8 **带 BOM**（编辑工具会悄悄剥掉 → PS 5.1 按 GBK 读，中文烂掉）
#   2) Python / Node 语法（全部 .py / .js）
#   3) 纯逻辑单测 test_dy_logic.py
#   4) SKILL.md 门禁编号连续 + 「门禁 N」反向引用不越界
#   5) 必备文件清单（有人删了东西立刻发现）
#   6) 夹具干跑：用 tests\fixture_assets 重建 product.json，与 tests\fixture_out 基线逐项比对
#   7) playwright-core 用的是哪一份（技能自带 / 机器级）
#   8) preflight（运行时 / Python 依赖 / CDP 端口+登录 / 类目模板登记）
param(
  [switch]$Quick,
  [switch]$KeepOut
)

$ErrorActionPreference = 'Continue'
$skillRoot = Split-Path -Parent $PSScriptRoot
$script:pass = 0
$script:fail = New-Object System.Collections.Generic.List[string]

function Ok($msg)  { Write-Host ("  [ OK ] " + $msg) -ForegroundColor Green; $script:pass++ }
function Warn($msg) { Write-Host ("  [warn] " + $msg) -ForegroundColor Yellow; $script:pass++ }
function Bad($msg, $fix) {
  Write-Host ("  [FAIL] " + $msg) -ForegroundColor Red
  if ($fix) { Write-Host ("         修法：" + $fix) -ForegroundColor DarkYellow }
  $script:fail.Add($msg)
}
function Head($msg) { Write-Host ("" + $msg) -ForegroundColor Cyan }

Write-Host "==== 抖店上架技能 · 自检 ====" -ForegroundColor Cyan
Write-Host ("技能根 = " + $skillRoot)

# ---------- 1) .ps1 必须带 BOM ----------
Head "== 1) .ps1 编码（UTF-8 带 BOM）=="
$ps1 = Get-ChildItem (Join-Path $skillRoot "scripts\*.ps1")
foreach ($f in $ps1) {
  $b = [System.IO.File]::ReadAllBytes($f.FullName)
  $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  if ($bom) { Ok ($f.Name + " BOM ok") }
  else {
    Bad ($f.Name + " 缺 BOM（PS 5.1 会按 GBK 读，中文串烂掉）") `
        ("补 BOM：`$p='" + $f.FullName + "';`$d=[IO.File]::ReadAllBytes(`$p);if(-not(`$d[0]-eq0xEF)){[IO.File]::WriteAllBytes(`$p,([byte[]](0xEF,0xBB,0xBF)+`$d))}")
  }
}

# ---------- 运行环境 ----------
Head "== 2) 运行环境 =="
. (Join-Path $skillRoot "scripts\resolve_env.ps1")
if (-not $DyEnv.python -or -not (Test-Path $DyEnv.python)) { Bad "python 没解析出来" "检查 config.json 的 python / 环境变量 MIMO_PYTHON" }
else { Ok ("python = " + $DyEnv.python) }
if (-not $DyEnv.node -or -not (Test-Path $DyEnv.node)) { Bad "node 没解析出来" "装 Node.js 或在 config.json 里写 node 路径" }
else { Ok ("node = " + $DyEnv.node) }

$py = $DyEnv.python
$node = $DyEnv.node
if ($py -and $node) {

  # ---------- 3) 语法 ----------
  Head "== 3) 语法 =="
  $pyFiles = Get-ChildItem (Join-Path $skillRoot "scripts\*.py")
  $badPy = 0
  foreach ($f in $pyFiles) { & $py -m py_compile $f.FullName 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $badPy++; Bad ("python 语法错：" + $f.Name) "看 py_compile 的报错行号" } }
  if ($badPy -eq 0) { Ok ($pyFiles.Count.ToString() + " 个 .py 语法通过") }

  $jsFiles = @(Get-ChildItem (Join-Path $skillRoot "scripts\*.js")) + @(Get-ChildItem (Join-Path $skillRoot "tests\*.js"))
  $badJs = 0
  foreach ($f in $jsFiles) { & $node --check $f.FullName 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $badJs++; Bad ("js 语法错：" + $f.Name) "看 node --check 的报错" } }
  if ($badJs -eq 0) { Ok ($jsFiles.Count.ToString() + " 个 .js 语法通过") }

  # ---------- 4) 纯逻辑单测 ----------
  Head "== 4) 纯逻辑单测 =="
  $ut = & $py (Join-Path $skillRoot "scripts\test_dy_logic.py") 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $ut -match "全部通过") {
    $m = [regex]::Match($ut, "全部通过：(\d+) 项")
    Ok ("test_dy_logic.py 通过（" + $m.Groups[1].Value + " 项断言）")
  } else {
    Bad "test_dy_logic.py 失败" "跑 & `$DyEnv.python <skillRoot>\scripts\test_dy_logic.py 看具体哪条断言"
  }

  # ---------- 5) 文档结构：门禁编号 ----------
  Head "== 5) SKILL.md 门禁编号 =="
  $skillPath = Join-Path $skillRoot "SKILL.md"
  $txt = [System.IO.File]::ReadAllText($skillPath, [System.Text.Encoding]::UTF8)
  $nums = @()
  foreach ($m in [regex]::Matches($txt, "(?m)^(\d+)\. ")) { $nums += [int]$m.Groups[1].Value }
  $gateNums = @()
  foreach ($n in $nums) { $gateNums += $n }
  $expected = 1
  $gaps = @()
  foreach ($n in $gateNums) {
    if ($n -eq $expected) { $expected++ } elseif ($n -gt $expected) { $gaps += ("缺 " + $expected); $expected = $n + 1 }
  }
  if ($gaps.Count -eq 0) { Ok ("门禁编号 1.." + ($expected - 1) + " 连续") }
  else { Bad ("门禁编号不连续：" + ($gaps -join ", ")) "补上缺号，或把后面整体重编号" }

  # 「门禁 N」反向引用不能越界
  $maxGate = $expected - 1
  $refMax = 0
  foreach ($m in [regex]::Matches($txt, "门禁\s*(\d+)")) { $v = [int]$m.Groups[1].Value; if ($v -gt $refMax) { $refMax = $v } }
  if ($refMax -le $maxGate) { Ok ("「门禁 N」引用最大 = " + $refMax + " ≤ 实际 " + $maxGate) }
  else { Bad ("「门禁 N」引用越界：引用了 门禁 " + $refMax + "，但只到 " + $maxGate) "多半是插入/删除门禁后反向引用没同步（见 ops-notes 教训）" }

  # ---------- 6) 必备文件清单 ----------
  Head "== 6) 必备文件 =="
  $must = @(
    "SKILL.md", "HANDOVER.md", "config.example.json", "locales\zh-CN.json", "locales\en-US.json",
    "scripts\resolve_env.ps1", "scripts\preflight.ps1", "scripts\selftest.ps1", "scripts\run_until_green.ps1",
    "scripts\pwresolver.js", "scripts\dy_flow.js", "scripts\run_listing.js",
    "scripts\read_excel.py", "scripts\fill_dy_template.py", "scripts\build_product.py", "scripts\prep_dy_images.py",
    "scripts\test_dy_logic.py", "references\RECON.md", "references\playbook.md", "references\ops-notes.md",
    "tests\README.md", "tests\verify_sku_table.js", "tests\reveal_reference_price.js",
    "tests\fixture_商品信息_GPVC001.xlsx", "tests\fixture_assets", "tests\fixture_out\product.json"
  )
  $miss = @()
  foreach ($m in $must) { if (-not (Test-Path (Join-Path $skillRoot $m))) { $miss += $m } }
  if ($miss.Count -eq 0) { Ok ($must.Count.ToString() + " 个必备文件/目录都在") }
  else { Bad ("缺文件：" + ($miss -join ", ")) "从备份/别的机器补齐；这些是交接与自检的支点" }
  # config.json 被 .gitignore 排除（含店铺名/品牌/本机素材包路径），所以它**不在**必备清单里；
  # 缺了不是错误，但要说清怎么补 —— 否则新克隆的人会以为技能装坏了。
  if (Test-Path (Join-Path $skillRoot "config.json")) { Ok "config.json 在（自己的真实配置）" }
  else { Warn "还没有 config.json —— 复制 config.example.json 成 config.json，填成自己的店铺/品牌/素材包路径（不填也能跑，但店铺与类目模板都认不出来）" }

  # ---------- 6b) config.json 结构（shops / templates）----------
  Head "== 6b) config.json（店铺登记 / 类目模板）=="
  $cfgPath = Join-Path $skillRoot "config.json"
  $usingExample = $false
  if (-not (Test-Path $cfgPath)) {
    # 公开仓库里 config.json 被 .gitignore 排除（含店铺名/品牌/本机路径），新克隆只有 example。
    # 对着 example 检查仍然有意义（结构/端口唯一性/字段齐不齐），但要提醒这是示例值。
    $cfgPath = Join-Path $skillRoot "config.example.json"
    $usingExample = $true
  }
  # 读 UTF-8 必须显式 -Encoding（PS 5.1 默认 GBK → 中文乱码 → ConvertFrom-Json 抛异常）
  try { $cfg = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json } catch { $cfg = $null }
  if (-not $cfg) {
    Bad "config.json 解析失败" "看是否被写坏（重复键/少逗号）；PS 5.1 读它必须显式 -Encoding UTF8"
  } else {
    if ($usingExample) { Warn "正在检查 config.example.json（示例值）—— 复制成 config.json 填好自己的值后这条就消失" }
    $shopNames = if ($cfg.shops) { @($cfg.shops.PSObject.Properties.Name) } else { @() }
    if ($shopNames.Count -eq 0) { Warn "config.shops 里一家店都没登记（多店铺靠它；单店也建议登记）" }
    else {
      $ports = @()
      $badShop = @()
      foreach ($n in $shopNames) {
        $p = $cfg.shops.$n.port
        if (-not $p) { $badShop += $n } else { $ports += [int]$p }
      }
      $dup = @($ports | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
      if ($badShop.Count -gt 0) { Bad ("这些店没有 port：" + ($badShop -join ', ')) "每家店一个端口（一店一 Chrome 实例），补上 port" }
      elseif ($dup.Count -gt 0) { Bad ("端口重复：" + ($dup -join ', ')) "一店一端口：两家店共用端口 = 其实在同一家店里填表（门禁 48）" }
      else { Ok ("shops：" + $shopNames.Count + " 家 / 端口 " + ($ports -join ', ') + "（无重复）") }
    }
    $tplNames = if ($cfg.templates) { @($cfg.templates.PSObject.Properties.Name) } else { @() }
    if ($tplNames.Count -eq 0) { Warn "config.templates 里没有登记任何类目素材包（门禁 45 会让用户给一份）" }
    else {
      $noFile = @()
      foreach ($t in $tplNames) { $pp = $cfg.templates.$t.path; if (-not $pp -or -not (Test-Path $pp)) { $noFile += $t } }
      if ($noFile.Count -gt 0) { Warn ("这些类目登记了模板但文件不在（可能被移动/改名）：" + ($noFile -join ', ')) }
      else { Ok ("templates：" + $tplNames.Count + " 个类目，文件都在（" + ($tplNames -join '/') + "）") }
    }
  }

  # ---------- 7) 夹具干跑 ----------
  Head "== 7) 夹具干跑（离线，不碰浏览器）=="
  $outDir = Join-Path $env:TEMP ("dy_selftest_" + (Get-Date -Format "HHmmss"))
  $dr = & $py (Join-Path $skillRoot "scripts\build_product.py") `
        --excel (Join-Path $skillRoot "tests\fixture_商品信息_GPVC001.xlsx") `
        --assets (Join-Path $skillRoot "tests\fixture_assets") `
        --out $outDir 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Bad ("夹具干跑退出码 " + $LASTEXITCODE) "看上面的报错；夹具坏了要么补 tests\fixture_assets，要么修 build_product"
    Write-Host $dr
  } else {
    $base = Get-Content -Raw -Encoding UTF8 (Join-Path $skillRoot "tests\fixture_out\product.json") | ConvertFrom-Json
    $now = Get-Content -Raw -Encoding UTF8 (Join-Path $outDir "product.json") | ConvertFrom-Json
    $cmp = @(
      @{ n = "SKU 数"; a = $base.product.skus.Count; b = $now.product.skus.Count },
      @{ n = "主图"; a = $base.main_images.Count; b = $now.main_images.Count },
      @{ n = "商详图"; a = $base.detail_images.Count; b = $now.detail_images.Count },
      @{ n = "规格图"; a = $base.spec_images.Count; b = $now.spec_images.Count },
      @{ n = "属性数"; a = $base.product.attributes.PSObject.Properties.Name.Count; b = $now.product.attributes.PSObject.Properties.Name.Count }
    )
    $diff = @()
    foreach ($c in $cmp) { if ($c.a -ne $c.b) { $diff += ($c.n + " 基线 " + $c.a + " ≠ 本次 " + $c.b) } }
    if ($diff.Count -eq 0) { Ok ("干跑与 fixture_out 基线一致（" + $cmp[0].b + " SKU / 主图 " + $cmp[1].b + " / 详情 " + $cmp[2].b + " / 规格图 " + $cmp[3].b + " / 属性 " + $cmp[4].b + "）") }
    else { Bad ("干跑与基线不一致：" + ($diff -join "; ")) "要么是行为真的变了（确认是有意改动后更新 tests\fixture_out 基线），要么是回归" }
    if (-not $KeepOut) { Remove-Item -Recurse -Force $outDir -ErrorAction SilentlyContinue }
  }

  # ---------- 8) playwright-core 来源 ----------
  Head "== 8) playwright-core =="
  $pw = & $node (Join-Path $skillRoot "scripts\which_pw.js") 2>&1 | Out-String
  if ($pw -match '"ok":\s*true') {
    $how = ([regex]::Match($pw, '"how":\s*"([^"]+)"')).Groups[1].Value
    $spec = ([regex]::Match($pw, '"spec":\s*"([^"]+)"')).Groups[1].Value
    # 注意：resolve_env.ps1 会把自带那份塞进 DY_PLAYWRIGHT，所以 how 可能显示 DY_PLAYWRIGHT。
    # 判定「是不是技能自带」要看**路径**，不是看 how（否则永远报 warn）。
    $specSafe = $spec -replace '\\\\', '\'
    if ($specSafe -match 'tools\\npm') { Ok ("技能自带副本（换机器也能跑）：" + $specSafe) }
    elseif ($how -match 'DY_PLAYWRIGHT') { Ok ("DY_PLAYWRIGHT 指定：" + $specSafe) }
    else { Write-Host ("  [warn] 仅机器级解析：" + $specSafe + " —— 只在这台机器成立；技能自带那份应在 tools\npm\node_modules\playwright-core") -ForegroundColor Yellow; $script:pass++ }
  } else { Bad "playwright-core 解析失败" "确认 tools\npm\node_modules\playwright-core 在；或 config.json 的 playwright_core 指向它" }
}

# ---------- 9) preflight ----------
if ($Quick) {
  Head "== 9) preflight（-Quick 跳过）=="
  Write-Host "  跳过了（要连 CDP 端口/看登录态就跑不带 -Quick 的）" -ForegroundColor DarkGray
} else {
  Head "== 9) preflight（端口/登录/类目模板）=="
  $realCfg = Join-Path $skillRoot "config.json"
  if (-not (Test-Path $realCfg)) {
    # 没有自己的 config.json 就没有真店铺/真素材包可查 —— 查 example 只会报一堆假 FAIL。
    Write-Host "  跳过：还没有自己的 config.json（复制 config.example.json 成 config.json 并填好后再跑）" -ForegroundColor DarkGray
  } else {
    $cfg = Get-Content -Raw -Encoding UTF8 $realCfg | ConvertFrom-Json
    $cat = @($cfg.templates.PSObject.Properties.Name)[0]
    $pf = & (Join-Path $skillRoot "scripts\preflight.ps1") -Category $cat 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { Ok ("preflight 通过（类目样板：" + $cat + "）") }
    elseif ($LASTEXITCODE -eq 2) { Write-Host "  [warn] preflight 有警告（exit 2）" -ForegroundColor Yellow; $script:pass++ }
    else { Bad ("preflight 阻断（exit " + $LASTEXITCODE + "）") "看 preflight 输出里标 [FAIL] 的那条" }
    Write-Host $pf
  }
}

# ---------- 结论 ----------
Write-Host ""
if ($script:fail.Count -eq 0) {
  Write-Host ("★ 自检全绿：" + $script:pass + " 项通过 —— 可以开工") -ForegroundColor Green
  exit 0
} else {
  Write-Host ("★ 自检未过：" + $script:fail.Count + " 项失败 / " + $script:pass + " 项通过") -ForegroundColor Red
  foreach ($f in $script:fail) { Write-Host ("   - " + $f) -ForegroundColor Red }
  exit 1
}
