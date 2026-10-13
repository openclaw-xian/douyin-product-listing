# 抖店商品上架 · douyin-product-listing

把抖店官方素材包（`商品信息.xlsx` 的「抖音」sheet + 主图/详情图目录）填进抖店商品创建页
（`fxg.jinritemai.com/ffa/g/create`）的自动化流程。

**只填空与自检，绝不点「发布商品」。** 跑到全绿后，交你自己去后台确认并发布。

## 它解决什么

抖店发品的机械劳动量很大：5 张主图、标题、类目、14+7 个类目属性、几十到几百行 SKU 表、
规格图按规格值逐行分配、发货时间、填写检查。大头是「照着素材包填」，但踩点很密 ——
浮层拦指针、多选下拉是虚拟滚动、点下拉是「切换」不是「打开」、平台智能识别会漏填个别行、
规格图只能挂在第一组规格上。

本技能把这条流程固化成一条可重跑的流水线：`① 探活 → ② 主图+标题 → ③ 类目 → ④ 下一步 →
⑤ 属性 → ⑥ 详情图 → ⑦ 规格识别 → ⑦b 补漏 → ⑧ 规格图 → ⑨ 发货/状态 → ⑩ 填写检查 →
⑩b 全表核对 → ⑪ 汇总`。每步都读回校验，并把踩过的坑固化成 **48 条硬门禁**。

## 前置条件

| 依赖 | 说明 |
|---|---|
| Windows + PowerShell 5.1+ | 脚本是 `.ps1`，且**必须存成 UTF-8 带 BOM**（无 BOM 会被按 GBK 读，中文串全烂） |
| Node.js ≥ 18 | playwright-core 1.63.0 已随仓库附带，**不需要 `npm install`** |
| Python 3 | 需 `openpyxl`（解析素材包）+ `Pillow`（图片适配） |
| Chrome | 已**登录抖店**，并以 `--remote-debugging-port=9228` 启动 |

本技能**不代登录、不碰账号密码**，也不绕过验证码 —— 复用你已登录的 Chrome profile。

## 安装

**MiMo Desktop** —— 技能根是 `~/.config/mimocode/skills/`：

```powershell
git clone https://github.com/openclaw-xian/douyin-product-listing.git `
    "$env:USERPROFILE\.config\mimocode\skills\douyin-product-listing"
```

**DeepSeek Harness（DSH）** —— 技能根是 `~/.agents/skills/`。建议用目录联接，只有一份真身：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.agents\skills\douyin-product-listing" `
    "$env:USERPROFILE\.config\mimocode\skills\douyin-product-listing"
```

## 首次配置

仓库里**没有** `config.json` —— 它含店铺名、品牌与本机素材包路径，已被 `.gitignore` 排除。
复制示例再填成自己的值：

```powershell
$skillRoot = "$env:USERPROFILE\.config\mimocode\skills\douyin-product-listing"
Copy-Item "$skillRoot\config.example.json" "$skillRoot\config.json"
```

要填的只有两块：

- **`shops`** —— 店铺名 → `{ port, brand, templates?, note }`。**一家店 = 一个独立 Chrome 实例 +
  一个独立调试端口**；加店只需在这里加一条，代码不用动。
- **`templates`** —— 类目 → 该商品的抖店官方素材包路径（含「抖音」sheet 的那份 `商品信息.xlsx`）。
  抖店后台按类目能直接导出。**没登记的类目要让用户给一份，不要拿别的类目顶替。**

## 自检

改过脚本、或换过机器之后先跑这个（约 20 秒）：

```powershell
& "$skillRoot\scripts\selftest.ps1" -Quick   # 离线，跳过端口/登录
& "$skillRoot\scripts\selftest.ps1"          # 连 CDP 端口与登录态一起查
```

退出码 `0` = 可以开工。它验 8 类机械项：`.ps1` 是否带 BOM、Python/Node 语法、
32 项纯逻辑单测、门禁编号是否连续、必备文件是否齐全、**夹具干跑与基线逐项比对**、
playwright-core 用的是哪一份、以及 preflight。

## 用法

```powershell
$skillRoot = "$env:USERPROFILE\.config\mimocode\skills\douyin-product-listing"
. "$skillRoot\scripts\resolve_env.ps1"; Show-DyEnv

# 0) 素材包没有「抖音」sheet 时（常见：只有淘宝/拼多多 sheet）——先灌数据、再适配图片
& $DyEnv.python "$skillRoot\scripts\fill_dy_template.py" --template <官方模板> `
    --src-xlsx <素材包.xlsx> --product-id <商品号> --out <成品包>\商品信息.xlsx `
    --price-source 拼单价 --dim-order 颜色,尺码
& $DyEnv.python "$skillRoot\scripts\prep_dy_images.py" --src <素材目录> --out <成品包>

# 1) 生成 product.json + dy_spec.xlsx（含图片预检）
& $DyEnv.python "$skillRoot\scripts\build_product.py" --excel <成品包>\商品信息.xlsx `
    --assets <成品包> --out "$skillRoot\output\<商品号>"

# 2) 填表（不发布）。出图组在跑与跑之间会掷硬币 → run_until_green 自动换草稿重跑
$env:DY_PRODUCT = "$skillRoot\output\<商品号>\product.json"
$env:DY_CATEGORY_KEYWORD = "墙贴"
& "$skillRoot\scripts\run_until_green.ps1" -MaxAttempts 4

# 2b) 多店铺：逐店跑 + 输出对照表
& "$skillRoot\scripts\run_until_green.ps1" -Shop 店A,店B -MaxAttempts 3
```

验收看最后几行：`fails` 应为 `[]`、`必填项进度 = 100 %`、报错 `[]`。

## 目录

| 路径 | 内容 |
|---|---|
| `SKILL.md` | **门禁与规则**：48 条硬门禁、四条结构性硬约束、流程表、环境变量全表、退出码契约 |
| `HANDOVER.md` | **交接说明书**：环境前提、每个脚本干什么、标准作业流程、排错速查、新商品 checklist |
| `references/` | `RECON.md`（DOM 侦察报告）、`playbook.md`（逐步操作手册）、`ops-notes.md`（18 个真实事故复盘） |
| `scripts/` | 解析素材包 → 生成数据 → 经 CDP 填表；含 `selftest.ps1`、`test_dy_logic.py` |
| `tests/` | 全表对账工具、参考价探针、离线夹具与基线 |
| `tools/npm/node_modules/playwright-core` | 自带的 playwright-core 1.63.0（换机器免配置的关键） |

## 边界

- **不点「发布商品」**，也**不代登录**。
- 只支持抖店。改价、库存调整、下架、活动报名、客服、订单都不在范围内。
- 选填字段（主图 3:4 / 视频 / 白底图 / 资质等）默认不填，跑完会把「还空着的选填项」列给你。
- 拼多多见 `pdd-product-listing`，淘宝见 `taobao-product-listing`。

## 许可

MIT，见 [`LICENSE`](LICENSE)。

仓库附带 `tools/npm/node_modules/playwright-core`，其许可为 **Apache-2.0**，
许可证原文随包提供于 `tools/npm/node_modules/playwright-core/LICENSE`。
