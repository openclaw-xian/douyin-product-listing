#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纯逻辑单测：改完这几个脚本**先跑它**，再碰浏览器。

用法：
  "$MIMO_PYTHON" scripts/test_dy_logic.py

覆盖的四类逻辑，全都是**我改过、也改错过**的地方：
  1. 多色拼接编码合并（`merge_combo_code`）—— 源表的拼接码是坏的，只能从规格值算
  2. 规格值里的括号处理（`strip_brackets` / `brackets_to_dash` / `transform_spec_value`）—— 选错模式会丢信息
  3. 属性值拆分（`split_attr_values`）—— 选项自带的 `/` 被拆坏过
  4. 表头归一与规格图转方（`norm_label` / `key_label` / `to_square_center_crop`）

为什么值得写：这几处都在 `page.evaluate` 之外、纯函数、且改错时**浏览器那边不容易立刻暴露**
（表现往往是「属性静默丢值」「值数悄悄塌陷」「选项选不中」）。跑一遍 1 秒，比跑一遍 200 秒的填表便宜。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import build_product
import fill_dy_template
import prep_dy_images
import read_excel

FAILED = []
PASSED = [0]


def eq(actual, expected, label):
    if actual == expected:
        PASSED[0] += 1
        print("  ✓ %s" % label)
    else:
        FAILED.append(label)
        print("  ✗ %s\n      期望: %r\n      实际: %r" % (label, expected, actual))


def section(title):
    print("\n== %s ==" % title)


# ---------- 1. 多色拼接编码合并 ----------
section("merge_combo_code：拼接码用「各{N/2}片」，源表那种坏码不能直接用")
M = fill_dy_template.merge_combo_code
eq(M("棕色+卡其-10片", "40*40cm", "自粘地毯"), "自粘地毯-40*40-棕色+卡其各5片", "10片装 → 各5片（用户给的模板原例）")
eq(M("棕色+卡其-6片", "30*30cm", "自粘地毯"), "自粘地毯-30*30-棕色+卡其各3片", "6片装 → 各3片")
eq(M("棕色+卡其-2片", "60*60cm", "自粘地毯"), "自粘地毯-60*60-棕色+卡其各1片", "2片装 → 各1片")
eq(M("米白+黑色-10片", "50*50cm", "自粘地毯"), "自粘地毯-50*50-米白+黑色各5片", "另一种双色组合")
eq(M("卡其色-2片", "30*30cm", "自粘地毯"), None, "单色不合并（返回 None → 保持源编码）")
eq(M("棕色+卡其-5片", "30*30cm", "自粘地毯"), None, "总片数为奇数 → 拼不出「各N片」→ None")
eq(M("棕色+卡其-10片", "40*40厘米", "自粘地毯"), "自粘地毯-40*40-棕色+卡其各5片", "尺码带「厘米」也要去掉单位")
eq(M("棕色+卡其-10片", "", "自粘地毯"), None, "没有尺码 → None")

# ---------- 2. 规格值里的括号 ----------
section("括号：'strip' 剥掉 / 'dash' 转连字符")
eq(fill_dy_template.strip_brackets("3米装（卧室书房首选）"), "3米装", "strip：圆括号（全角）")
eq(fill_dy_template.strip_brackets("300厘米*60厘米【不伤爪】"), "300厘米*60厘米", "strip：方括号")
eq(fill_dy_template.strip_brackets("经典白"), "经典白", "strip：没括号就不动")
T = fill_dy_template.transform_spec_value
eq(T("白色#【30倍殿堂品质】9.0纳米旗舰暴粘款", "dash"), "白色#-30倍殿堂品质-9.0纳米旗舰暴粘款",
   "dash：保留括号里的品质档位（GPE-002 的关键——strip 会让同色三档变成同一个值）")
eq(T("长30米/宽50厘米【贴15平】母婴品质", "dash"), "长30米/宽50厘米-贴15平-母婴品质", "dash：保留铺贴面积")
eq(T("3米装（卧室书房首选）", "dash"), "3米装-卧室书房首选", "dash：圆括号同样处理")
# 关键回归：**「会不会撞」要实测，别靠推**
#  · PE3 那种括号里是**唯一区分信息** → strip 会撞（12 值塌成 4）→ 必须 dash
#  · GPE-002 那种括号后面还有档位文字 → strip **不会撞**（只是丢了「10倍/20倍/30倍」这个标签）
raw_collapse = ["白色（2.0版/标准遮丑）", "白色（3.0版/强胶暴粘不透底）", "白色（4.0版/纳米抗菌真无味）"]
eq(len({T(v, "strip") for v in raw_collapse}), 1,
   "★ PE3 实测：括号是唯一区分信息时，strip 会把 3 个值撞成 1 个（12 值塌成 4 的根因）→ 必须用 dash")
eq(len({T(v, "dash") for v in raw_collapse}), 3, "dash 保留 3 个不同值")

raw_gpe2 = ["白色#【10倍非凡品质】5.0标准款", "白色#【20倍颠覆品质】7.0无味强胶款", "白色#【30倍殿堂品质】9.0纳米旗舰暴粘款"]
eq(len({T(v, "strip") for v in raw_gpe2}), 3,
   "★ GPE-002 实测：括号后面还有档位文字 → strip 不会撞（取 dash 是为了**保留档位标签**，不是为了防撞）")
eq(len({T(v, "dash") for v in raw_gpe2}), 3, "dash 同样 3 个值，且标签更完整")
eq(len({T(v, "strip") for v in raw_gpe2}), len({T(v, "dash") for v in raw_gpe2}),
   "→ 结论：两种模式的值数相同，差别只在**信息是否保留**（别宣称剥掉会撞）")
eq(T("", "dash"), "", "空值不炸")

# ---------- 3. 属性值拆分 ----------
section("split_attr_values：选项自带的 / 不能拆")
S = build_product.split_attr_values
eq(S("成品地垫（元/块）", ["成品地垫（元/块）", "成品地垫"]), ["成品地垫（元/块）"],
   "整串命中允许值 → 不拆（曾把它拆成「成品地垫（元」「块）」导致选不中）")
eq(S("防水,防潮,自粘", []), ["防水", "防潮", "自粘"], "逗号分隔照拆")
eq(S("商用/办公", []), ["商用", "办公"], "不在允许值里 → `/` 当分隔符")
eq(S("聚酯纤维（涤纶）", []), ["聚酯纤维（涤纶）"], "括号里的斜杠/逗号不参与拆（无分隔符）")
eq(S("", []), [], "空值 → 空列表")
eq(S("  长3米/5米/10米*宽50厘米  ", []), ["长3米", "5米", "10米*宽50厘米"], "PE3 的具体规格就是这种写法")

# ---------- 4. 表头归一 + 规格图转方 ----------
section("表头归一：★ 前缀与内部空格都要吃掉")
eq(read_excel.norm_label("★ 商品标题"), "商品标题", "norm_label 去 ★")
eq(read_excel.norm_label("★价格"), "价格", "norm_label 去 ★（无空格）")
eq(read_excel.key_label("规格类型 1"), "规格类型1", "key_label 去内部空格（否则维度识别落空）")
eq(read_excel.key_label("  ★ 现货库存 "), "现货库存", "key_label 组合场景")

section("to_square_center_crop：非方形按居中裁切转 1:1")
sq, how = prep_dy_images.to_square_center_crop(prep_dy_images.Image.new("RGB", (752, 1008)))
eq((sq.size, how), ((752, 752), "center_crop"), "3:4 → 居中裁切 1:1")
sq2, how2 = prep_dy_images.to_square_center_crop(prep_dy_images.Image.new("RGB", (1024, 1024)))
eq((sq2.size, how2), ((1024, 1024), "already_square"), "已是方形 → 原样")

# ---------- 汇总 ----------
print("\n" + "=" * 56)
if FAILED:
    print("✗ 失败 %d 项 / 共 %d 项：" % (len(FAILED), len(FAILED) + PASSED[0]))
    for f in FAILED:
        print("   -", f)
    sys.exit(1)
print("✓ 全部通过：%d 项" % PASSED[0])
