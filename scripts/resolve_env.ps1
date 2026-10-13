# Resolve Douyin (抖店) skill paths: config.json > env > auto-detect.
# Dot-source or call; sets $DyEnv hashtable.
#
# 与 pdd-product-listing/scripts/resolve_env.ps1 同构，只换前缀与默认值。

function Get-DySkillRoot {
  Split-Path -Parent $PSScriptRoot
}

function Resolve-DyConfig {
  $root = if ($script:DySkillRoot) { $script:DySkillRoot } else { Get-DySkillRoot }
  $script:DySkillRoot = $root
  $cfgPath = Join-Path $root "config.json"
  # 允许用 DY_CONFIG 指向别的 config（测试多店铺编排时用，不动真配置）
  if ($env:DY_CONFIG -and (Test-Path $env:DY_CONFIG)) { $cfgPath = $env:DY_CONFIG }
  $cfg = [ordered]@{
    chrome = ""; chrome_profile = ""; node = ""; npm = ""; python = ""
    playwright_core = ""; workdir = ""; default_port = 9228; reuse_profile = $true
  }
  if (Test-Path $cfgPath) {
    try {
      # ⚠️ 必须显式 -Encoding UTF8：PowerShell 5.1 的 Get-Content 默认按 ANSI/GBK 读，
      #   而 config.json 是 UTF-8 无 BOM → 中文注释会变乱码、ConvertFrom-Json 直接抛异常。
      #   这个 catch 之前是**静默**的，所以「config.json 一直没被读进来」很久都没被发现
      #   （值大多是空串、default_port 又恰好等于兜底值，所以没暴露）。
      $raw = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($k in @('chrome','chrome_profile','node','npm','python','playwright_core','workdir')) {
        if ($raw.PSObject.Properties.Name -contains $k -and $raw.$k) { $cfg[$k] = [string]$raw.$k }
      }
      if ($raw.PSObject.Properties.Name -contains 'default_port' -and $raw.default_port) {
        $cfg.default_port = [int]$raw.default_port
      }
      if ($raw.PSObject.Properties.Name -contains 'reuse_profile') {
        $cfg.reuse_profile = [bool]$raw.reuse_profile
      }
      # 店铺登记表（多店铺的唯一权威，跟 pdd 的 config.shops 同构）：
      #   shops.<店名> = { port, page_kind, brand, templates? , note }
      # 一家店 = 一个独立 Chrome 实例（独立 --user-data-dir）+ 独立调试端口。
      if ($raw.PSObject.Properties.Name -contains 'shops' -and $raw.shops) { $cfg.shops = $raw.shops }
      if ($raw.PSObject.Properties.Name -contains 'templates' -and $raw.templates) { $cfg.templates = $raw.templates }
    } catch {
      Write-Warning "config.json 解析失败，已回退到自动探测：$($_.Exception.Message)"
    }
  }
  return $cfg
}

<#
  按店名解析端口与模板（多店铺：**不写死店铺**，以 config.shops 为准）。
  规则：
    - 显式 -Shop / $env:DY_SHOP 指定店名 → 用它；
    - 没指定但只登记了一家店 → 用那家（单店场景零配置）；
    - 登记了多家又没指定 → 不猜（shop = ""，端口回落到 default_port，调用方应报错或要求指定）。
  返回 @{ name; port; shop }；shop 为 $null 表示没解析到店。
#>
function Resolve-DyShop {
  param([string]$Name = "")
  $cfg = Resolve-DyConfig
  $shops = $cfg.shops
  $want = if ($Name) { $Name } elseif ($env:DY_SHOP) { $env:DY_SHOP } else { "" }
  if (-not $shops) {
    return @{ name = ""; port = [int]$cfg.default_port; shop = $null; names = @() }
  }
  $names = @($shops.PSObject.Properties.Name)
  if ($want -and ($names -contains $want)) {
    return @{ name = $want; port = [int]$shops.$want.port; shop = $shops.$want; names = $names }
  }
  if (-not $want -and $names.Count -eq 1) {
    $only = $names[0]
    return @{ name = $only; port = [int]$shops.$only.port; shop = $shops.$only; names = $names }
  }
  return @{ name = ""; port = [int]$cfg.default_port; shop = $null; names = $names }
}

function Resolve-DyEnv {
  $cfg = Resolve-DyConfig
  $envMap = @{}

  $envMap.node = if ($cfg.node -and (Test-Path $cfg.node)) { $cfg.node }
    elseif ($env:DY_NODE -and (Test-Path $env:DY_NODE)) { $env:DY_NODE }
    else {
      $c = Get-Command node -ErrorAction SilentlyContinue
      if ($c) { $c.Source } else { "" }
    }

  $envMap.python = if ($cfg.python -and (Test-Path $cfg.python)) { $cfg.python }
    elseif ($env:DY_PYTHON -and (Test-Path $env:DY_PYTHON)) { $env:DY_PYTHON }
    elseif ($env:MIMO_PYTHON -and (Test-Path $env:MIMO_PYTHON)) { $env:MIMO_PYTHON }
    else {
      $c = Get-Command python -ErrorAction SilentlyContinue
      if ($c) { $c.Source } else { "" }
    }

  $envMap.chrome = if ($cfg.chrome -and (Test-Path $cfg.chrome)) { $cfg.chrome }
    elseif ($env:DY_CHROME -and (Test-Path $env:DY_CHROME)) { $env:DY_CHROME }
    else {
      $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
      )
      $hit = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($hit) { $hit } else { "" }
    }

  # playwright-core：config > 环境变量 > **技能自带** > 裸模块名（机器级 / NODE_PATH）。
  # 自带那份（tools\npm\node_modules\playwright-core，约 13MB）是**换机器也能跑**的关键 —— 见 scripts/pwresolver.js
  $skillRootForPw = Split-Path -Parent $PSScriptRoot
  $localPw = Join-Path $skillRootForPw "tools\npm\node_modules\playwright-core"
  $envMap.playwright_core = if ($cfg.playwright_core -and (Test-Path $cfg.playwright_core)) { $cfg.playwright_core }
    elseif ($env:DY_PLAYWRIGHT -and (Test-Path $env:DY_PLAYWRIGHT)) { $env:DY_PLAYWRIGHT }
    elseif (Test-Path $localPw) { $localPw }
    else { "playwright-core" }

  if ($envMap.playwright_core -and $envMap.playwright_core -ne 'playwright-core') {
    $env:DY_PLAYWRIGHT = $envMap.playwright_core
  }

  $envMap.npm = if ($cfg.npm -and (Test-Path $cfg.npm)) { $cfg.npm }
    elseif ($env:DY_NPM -and (Test-Path $env:DY_NPM)) { $env:DY_NPM }
    else { "" }

  $envMap.workdir = if ($cfg.workdir -and $cfg.workdir.Trim()) { $cfg.workdir }
    elseif ($env:DY_WORKDIR -and $env:DY_WORKDIR.Trim()) { $env:DY_WORKDIR }
    else { Join-Path (Get-Location) "output\douyin" }

  $envMap.default_port = $cfg.default_port
  # 店铺：把解析结果一并放进来（run_until_green / preflight 用它做「按店」的事）
  $shop = Resolve-DyShop
  $envMap.shop = $shop.name
  $envMap.shop_port = $shop.port
  $envMap.shops = $cfg.shops
  # 只登记一家店时，端口直接跟店走（单店场景不需要手传 DY_PORT）
  if ($shop.name) { $envMap.default_port = $shop.port }
  # 类目模板：全局 templates + 该店的 templates 覆盖（类目选项集是**店级**的，所以允许按店换模板）
  $tpl = @{}
  if ($cfg.templates) {
    foreach ($p in $cfg.templates.PSObject.Properties) { $tpl[$p.Name] = $p.Value }
  }
  if ($shop.shop -and $shop.shop.templates) {
    foreach ($p in $shop.shop.templates.PSObject.Properties) { $tpl[$p.Name] = $p.Value }
  }
  $envMap.templates = $tpl
  $envMap.chrome_profile = if ($cfg.chrome_profile -and $cfg.chrome_profile.Trim()) { $cfg.chrome_profile } else { "" }
  $envMap.reuse_profile = $cfg.reuse_profile
  $envMap.skill_root = $script:DySkillRoot
  $envMap.read_excel = Join-Path $script:DySkillRoot "scripts\read_excel.py"
  $envMap.build_product = Join-Path $script:DySkillRoot "scripts\build_product.py"
  $envMap.flow_js = Join-Path $script:DySkillRoot "scripts\dy_flow.js"
  $envMap.run_listing = Join-Path $script:DySkillRoot "scripts\run_listing.js"
  $envMap.open_browser = Join-Path $script:DySkillRoot "scripts\open_browser.ps1"

  # 供 Node 步骤脚本使用
  $env:DY_FLOW_JS = $envMap.flow_js

  $script:DyEnv = $envMap
  return $envMap
}

function Show-DyEnv {
  $e = if ($script:DyEnv) { $script:DyEnv } else { Resolve-DyEnv }
  $e.GetEnumerator() | Sort-Object Name | ForEach-Object {
    "{0,-16} {1}" -f $_.Key, $_.Value
  }
}

# Auto-resolve on dot-source
Resolve-DyEnv | Out-Null
