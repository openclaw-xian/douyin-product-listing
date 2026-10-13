# 跑到绿为止 + 多店铺编排。
#
# 背景（单店）：抖店「智能填写助手」会把「添加规格图」挂到哪一组规格上是随机的
# （实测同一份 dy_spec.xlsx，两次跑会互换）。若挂到了另一维，⑧ 会干净中止
# （spec_image_group_mismatch，**不点确定**、不污染草稿），此时重开草稿重跑即可。
#
# 多店铺（与 pdd-product-listing 同构的模型）：
#   一店 = 一个独立 Chrome 实例（独立 --user-data-dir）+ 独立调试端口，登记在 config.json 的 `shops`。
#   本脚本 `-Shop 店名1,店名2` 会**逐店**跑，并且：
#     · **单店失败不阻断**（继续下一家），最后输出**对照表**；
#     · 只对「可重试」的失败换新草稿重跑（别的失败立刻停，免得白刷草稿）；
#     · 退出码：全部店全绿=0；只要有任一店没全绿=1。
#   ⚠️ 不传 -Shop 时：只登记一家店就直接用它；登记多家会报错要求指定（**不猜**，见 pdd「不要写死店铺」）。
#
# 用法：
#   . "<skillRoot>\scripts\resolve_env.ps1"; Show-DyEnv
#   $env:DY_PRODUCT = "<skillRoot>\output\<商品号>\product.json"
#   & "<skillRoot>\scripts\run_until_green.ps1" -MaxAttempts 4            # 单店（唯一的店）
#   & "<skillRoot>\scripts\run_until_green.ps1" -Shop 店A,店B -MaxAttempts 3   # 多店
param(
  [int]$MaxAttempts = 4,
  [string[]]$RetryableFails = @('spec_images'),
  [string[]]$Shop = @()
)

$skillRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'resolve_env.ps1')
if (-not $DyEnv.node) { throw 'resolve_env 没解析出 node' }
if (-not $env:DY_PRODUCT) { throw '请先设置 $env:DY_PRODUCT' }

$env:DY_FRESH = '1'          # 每轮都新开草稿（上一轮可能已被平台换过出图组）

# 单店的「跑到绿为止」循环；返回结果供对照表用
function Invoke-ShopListing {
  param([string]$ShopName, [int]$Port)
  $env:DY_PORT = [string]$Port
  if ($ShopName) { $env:DY_SHOP = $ShopName } else { Remove-Item Env:\DY_SHOP -ErrorAction SilentlyContinue }
  $tag = if ($ShopName) { $ShopName } else { '单店' }
  $final = @{ shop = $tag; port = $Port; ok = $false; attempts = 0; fails = @(); required = ''; errs = '' }

  for ($i = 1; $i -le $MaxAttempts; $i++) {
    Write-Host ("===== [{0}] 第 {1}/{2} 轮 =====" -f $tag, $i, $MaxAttempts) -ForegroundColor Cyan
    $env:DY_ATTEMPT = [string]$i
    $out = & $DyEnv.node (Join-Path $PSScriptRoot 'run_listing.js') 2>&1 | Out-String
    $code = $LASTEXITCODE
    $final.attempts = $i
    $log = Join-Path $skillRoot ("tests\_run_attempt_{0}.log" -f $i)
    [System.IO.File]::WriteAllText($log, $out, (New-Object System.Text.UTF8Encoding($false)))
    # 打印时滤掉 specValues（⑧ 的逐行 JSON 很长）；原始日志在 tests\_run_attempt_N.log
    Write-Host (($out -split "`r?`n" | Where-Object { $_ -notmatch 'specValues' }) -join "`n")

    $mr = [regex]::Match($out, '必填项进度 = (\d+)')
    if ($mr.Success) { $final.required = $mr.Groups[1].Value }
    $me = [regex]::Match($out, '报错 = (\[.*?\])')
    if ($me.Success) { $final.errs = $me.Groups[1].Value }

    if ($code -eq 0) {
      $final.ok = $true
      Write-Host ("★ [{0}] 第 {1} 轮全绿（fails 为空）" -f $tag, $i) -ForegroundColor Green
      return $final
    }

    $mf = [regex]::Match($out, '自检汇总 fails = (\[.*?\])')
    if (-not $mf.Success) {
      Write-Host ("★ [{0}] 没解析到 fails，停止该店重试" -f $tag) -ForegroundColor Red
      $final.fails = @('unparsed')
      return $final
    }
    $fails = @($mf.Groups[1].Value | ConvertFrom-Json)
    $final.fails = $fails
    $blocking = @($fails | Where-Object { $f = $_; -not ($RetryableFails | Where-Object { $f -eq $_ }) })
    if ($blocking.Count -gt 0) {
      Write-Host ("★ [{0}] 有不可重试的失败 {1}，停止该店重试" -f $tag, ($blocking -join ',')) -ForegroundColor Red
      return $final
    }
    Write-Host ("· [{0}] 本轮失败都是可重试项（{1}），换新草稿再来" -f $tag, ($fails -join ',')) -ForegroundColor Yellow
    Start-Sleep -Seconds 3
  }
  Write-Host ("★ [{0}] 跑了 {1} 轮仍未全绿，请人工看 tests\_run_attempt_*.log" -f $tag, $MaxAttempts) -ForegroundColor Red
  return $final
}

# ---------- 目标店 → 端口 ----------
$targets = @()
if ($Shop.Count -gt 0) {
  foreach ($n in $Shop) {
    $r = Resolve-DyShop $n
    if (-not $r.shop) { throw ("config.shops 里没有店「{0}」；已登记：{1}" -f $n, ($r.names -join ' / ')) }
    $targets += @{ name = $n; port = [int]$r.port }
  }
} else {
  $r = Resolve-DyShop
  if (-not $r.shop -and @($r.names).Count -gt 1) {
    throw ("登记了 {0} 家店，必须用 -Shop 指定要发哪些（不猜）：{1}" -f @($r.names).Count, ($r.names -join ' / '))
  }
  $port = if ($env:DY_PORT) { [int]$env:DY_PORT } else { [int]$r.port }
  $targets += @{ name = $r.name; port = $port }
}

# ---------- 逐店跑（单店失败不阻断） ----------
$results = @()
foreach ($t in $targets) {
  $results += Invoke-ShopListing -ShopName $t.name -Port $t.port
}

# ---------- 对照表 ----------
# 中文按显示宽度算（一个汉字占 2 列），否则列会歪
function PadR($s, $w) {
  $len = 0
  foreach ($ch in ([string]$s).ToCharArray()) { $len += if ([int]$ch -gt 255) { 2 } else { 1 } }
  ([string]$s) + (' ' * [Math]::Max(0, $w - $len))
}
Write-Host ""
Write-Host "================ 多店铺对照表 ================" -ForegroundColor Cyan
Write-Host ((PadR '店铺' 20) + (PadR '端口' 8) + (PadR '结果' 10) + (PadR '必填' 8) + '报错 / fails')
foreach ($x in $results) {
  $verdict = if ($x.ok) { '全绿' } else { '未全绿' }
  $detail = if ($x.ok) { $x.errs } else { ("fails=" + ($x.fails -join ',')) + " errs=" + $x.errs }
  $color = if ($x.ok) { 'Green' } else { 'Red' }
  Write-Host ((PadR $x.shop 20) + (PadR $x.port 8) + (PadR $verdict 10) + (PadR ($x.required + '%') 8) + $detail) -ForegroundColor $color
}
$bad = @($results | Where-Object { -not $_.ok })
if ($bad.Count -eq 0) {
  Write-Host ("★ {0} 家店全部全绿" -f $results.Count) -ForegroundColor Green
  exit 0
}
Write-Host ("★ {0}/{1} 家店未全绿；原始日志：tests\_run_attempt_*.log（可重复跑同一命令，幂等）" -f $bad.Count, $results.Count) -ForegroundColor Red
exit 1
