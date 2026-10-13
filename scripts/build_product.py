#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把抖店官方素材包（商品信息.xlsx 的「抖音」sheet）+ 素材目录
→ 生成 run_listing.js 直接可吃的 product.json，
   以及上传给抖店「智能填写助手」的规格 Excel（dy_spec.xlsx）。

用法：
  python build_product.py --excel "<素材包>/商品信息.xlsx" --assets "<素材包>/抖音/商品A-01" --out ./work

可选覆盖（listing.json 或命令行）：
  --title / --brand / --ref-price / --attrs '{"材质":["PVC"]}'

产出：
  work/product.json    归一化后的商品数据
  work/dy_spec.xlsx    规格 Excel（规格类型1 / 规格类型2 / 售卖价 / 现货库存 / 商家编码）
  work/main|detail|specimg/  ASCII 素材副本
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# Windows 下 stdout 默认 cp936(GBK)：print 中文属性会
# UnicodeEncodeError 直接崩（此时 product.json 其实已写好，用户看到的却是失败）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))

# 抖店图片限制
MAIN_MIN_W = 600          # 主图 ≥600×600
DETAIL_MIN_W = 620        # 商详图宽 620-1290px
DETAIL_MAX_W = 1290
DETAIL_MAX_MB = 5         # 商详图 <5MB
IMG_LIMIT_MB = 5


def run_read_excel(xlsx):
    # PYTHONIOENCODING 必须显式传给子进程：Windows 上子进程 stdout 默认 cp936，
    # 中文 JSON 会在管道里被转成 ?，decode 出 U+FFFD，后续标签匹配全部落空。
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run([sys.executable, os.path.join(HERE, "read_excel.py"), xlsx],
                       capture_output=True, env=env)
    txt = r.stdout.decode("utf-8", errors="replace")
    i = txt.find("{")
    if i < 0:
        raise SystemExit("read_excel 无 JSON 输出：\n" + txt[:800] + "\n" + r.stderr.decode("utf-8", "replace")[:800])
    return json.loads(txt[i:]), r.returncode


def norm_key(s):
    return re.sub(r"[\s★>]+", "", str(s or ""))


def pick_asset_dir(assets, *keywords):
    """在 assets 下按关键字找目录（官方模板目录名：主图/商品详情→?/规格图片…）"""
    if not os.path.isdir(assets):
        return None
    names = sorted(os.listdir(assets))
    for kw in keywords:
        for n in names:
            p = os.path.join(assets, n)
            if os.path.isdir(p) and kw in n:
                return p
    return None


def imgs_in(d):
    if not d or not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")))


def copy_ascii(src_dir, dst_dir, prefix, limit=None):
    """拷成 ASCII 名并做体积预检。limit 在**拷贝前**生效（否则会多拷文件到磁盘）"""
    os.makedirs(dst_dir, exist_ok=True)
    fs = imgs_in(src_dir)
    if limit:
        fs = fs[:limit]
    out = []
    for i, f in enumerate(fs, 1):
        src = os.path.join(src_dir, f)
        ext = os.path.splitext(f)[1].lower()
        dst = os.path.join(dst_dir, "%s_%02d%s" % (prefix, i, ext))
        shutil.copyfile(src, dst)
        out.append((f, dst, os.path.getsize(src)))
    return out


def check_sizes(pairs, label, limit_mb=IMG_LIMIT_MB):
    bad = [(f, sz) for f, _, sz in pairs if sz > limit_mb * 1024 * 1024]
    if bad:
        print("★ %s 有图超过 %dMB（抖店会拒）：" % (label, limit_mb))
        for f, sz in bad:
            print("   !! %s  %.2fMB" % (f, sz / 1024.0 / 1024.0))
        raise SystemExit(6)


def check_detail_wh(pairs):
    """商详图宽 620-1290px"""
    try:
        from PIL import Image
    except ImportError:
        print("⚠️ 无 Pillow，跳过商详图宽高校验")
        return []
    bad = []
    for f, dst, _ in pairs:
        try:
            w, h = Image.open(dst).size
        except Exception:
            continue
        if not (DETAIL_MIN_W <= w <= DETAIL_MAX_W):
            bad.append((f, w, h))
    if bad:
        print("★ 商详图宽度不在 %d-%dpx（抖店要求）：" % (DETAIL_MIN_W, DETAIL_MAX_W))
        for f, w, h in bad:
            print("   !! %s  %dx%d" % (f, w, h))
        raise SystemExit(7)
    return []


def split_attr_values(raw, allowed):
    """把产品级属性值拆成多个值。

    ⚠️ 选项表里的值**自己就带 `/`**（如「成品地垫（元/块）」「吸尘等」）——
    无脑 `split(r"[,，/]")` 会把它拆成「成品地垫（元」「块）」，填表必然选不中。
    所以：**整串命中允许值就原样返回**，否则才按分隔符拆。
    """
    s = str(raw or "").strip()
    if not s:
        return []
    if s in (allowed or []):
        return [s]
    return [x.strip() for x in re.split(r"[,，/、]", s) if x.strip()]


def build_spec_xlsx(path, dims, skus, price_key, stock_key, code_key):
    """抖店「智能识别」吃的规格表：已实测 5 列结构可用。
    表头用中文语义（售卖价/库存/规格编码），抖店按语义自动映射。"""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "SKU"
    header = [dims[0], dims[1] if len(dims) > 1 else "规格2",
              "售卖价", "库存", "商家编码"]
    if len(dims) > 2:
        header = [dims[0], dims[1], dims[2], "售卖价", "库存", "商家编码"]
    ws.append(header)
    for s in skus:
        row = [s.get(d, "") for d in dims]
        row += [s.get(price_key), s.get(stock_key), s.get(code_key)]
        ws.append(row)
    wb.save(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--excel", required=True, help="素材包 商品信息.xlsx")
    ap.add_argument("--assets", required=True, help="商品素材目录（含 主图/商品详情/规格图片 等）")
    ap.add_argument("--detail-dir", default=None,
                    help="商详图目录。抖店部分类目模板（如「墙贴」）**没有「商品详情」字段与目录**，"
                         "此时由本 skill 自己带：用这个参数显式指定，或在素材目录/其父目录放 商品详情|详情图|02_详情图")
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default=None)
    ap.add_argument("--brand", default=None)
    ap.add_argument("--ref-price", default=None)
    ap.add_argument("--attrs", default=None, help='JSON: {"材质":["PVC"]}')
    a = ap.parse_args()

    data, code = run_read_excel(a.excel)
    if not data.get("ok"):
        print("★ 素材包预检未过：", json.dumps(data.get("blocking_warnings"), ensure_ascii=False))
        for w in data.get("attr_warnings", []):
            print("   attr:", json.dumps(w, ensure_ascii=False))
        raise SystemExit(2)

    out = a.out
    os.makedirs(out, exist_ok=True)

    dims = [d for d in data["dimensions"] if data["dim_values"].get(d)]
    skus_raw = data["skus"]
    if not dims:
        raise SystemExit("没有有效的规格维度")

    # 素材
    main_src = pick_asset_dir(a.assets, "主图") or pick_asset_dir(a.assets, "轮播")
    # 商详图：显式 --detail-dir 优先；否则在素材目录、再在其父目录找常见命名
    # （「墙贴」类目模板本身没有商品详情字段/目录，所以这里要能兜住）
    parent = os.path.dirname(os.path.abspath(a.assets.rstrip("\\/")))
    detail_src = (a.detail_dir
                  or pick_asset_dir(a.assets, "商品详情", "详情图", "详情")
                  or pick_asset_dir(parent, "商品详情", "详情图", "详情", "02_详情图"))
    specimg_src = pick_asset_dir(a.assets, "规格图片", "预览图")

    main_pairs = copy_ascii(main_src, os.path.join(out, "main"), "main", limit=5)  # 抖店 5 槽位
    detail_pairs = copy_ascii(detail_src, os.path.join(out, "detail"), "detail")
    if not detail_pairs:
        print("⚠️ 未取到商详图：该类目模板可能没有「商品详情」字段（抖店墙贴模板即如此）。")
        print("   请用 --detail-dir 指定商详图目录，或在素材目录下建 商品详情/ 目录放图。")
    spec_pairs = copy_ascii(specimg_src, os.path.join(out, "specimg"), "spec")

    check_sizes(main_pairs, "主图")
    check_sizes(detail_pairs, "商详图", DETAIL_MAX_MB)
    check_sizes(spec_pairs, "规格图")
    check_detail_wh(detail_pairs)

    spec_by_name = {orig: dst for orig, dst, _ in spec_pairs}

    # SKU 归一化
    dims_keys = {norm_key(d): d for d in dims}
    out_skus = []
    for s in skus_raw:
        row = {}
        for d in dims:
            row[d] = s.get(d, "")
        row["price"] = s.get("price")
        row["stock"] = int(s["stock"]) if s.get("stock") is not None else None
        row["code"] = s.get("code")
        row["barcode"] = s.get("barcode")
        img = s.get("specImage")
        row["specImage"] = spec_by_name.get(img) if img else None
        out_skus.append(row)

    # 属性：官方 sheet 的产品级字段 → attrs
    # 名单**不能硬编码**：每个类目的属性集不同（墙贴有「计价单位/壁画材质」，
    # 地垫有「工艺/成分含量/功能/售卖方式」）。抖店在 R4 里给类目属性统一打了
    # key = "category_properties.<id>"，据此推导最稳。
    product_keys = data.get("product_keys") or {}
    ATTR_LABELS = [lab for lab, k in product_keys.items()
                   if isinstance(k, str) and k.startswith("category_properties.")]
    if not ATTR_LABELS:                       # 老数据/无 key 时退回墙贴名单
        ATTR_LABELS = ["适用场景", "适用对象", "墙纸规格", "计价单位", "面层工艺", "风格", "图案",
                       "有无图案", "同城服务", "壁画材质", "厚度", "每卷长度(m)", "每卷宽度(m)",
                       "材质", "类型", "产地", "是否可定制", "辅材套餐", "适用空间", "上市时间"]
    # 品牌由 run_listing 单独走「可搜索下拉」填，不混进属性表
    ATTR_LABELS = [l for l in ATTR_LABELS if l != "品牌"]
    attrs = {}
    allowed = data.get("allowed_options", {}) or {}

    def split_attr(lab, v):
        return split_attr_values(v, allowed.get(lab) or [])

    for lab in ATTR_LABELS:
        v = data["product"].get(lab)
        if v not in (None, ""):
            attrs[lab] = split_attr(lab, v)
    if a.attrs:
        attrs.update(json.loads(a.attrs))

    multi = {k: v for k, v in attrs.items() if isinstance(v, list) and len(v) > 1}
    if multi:
        print("ℹ️ 多值属性（fillAttributes 会逐个点选，读回要求全部命中）：")
        for k, v in multi.items():
            print("   %s = %s" % (k, " / ".join(v)))

    # 「模板里有、但我们没填」的属性 —— 跑完要**列给用户**问要不要补（门禁 47，用户 2026-10-09 要求）。
    # 名单必须取 `product_fields`（R4 里**所有** category_properties 列），
    # **不能**用 `product_keys` —— 那个只收「R5 已有值」的列（等于我们已填的，算出来恒为 0，实测踩过）。
    # 品牌由 run_listing 单独填，不算「没填」。
    pf = data.get("product_fields") or []
    unfilled_req = [f["label"] for f in pf
                    if f["required"] and f["label"] != "品牌" and f["label"] not in attrs]
    unfilled_opt = [f["label"] for f in pf
                    if not f["required"] and f["label"] != "品牌" and f["label"] not in attrs]
    if unfilled_req:
        print("★ 必填属性没有数据（表单会卡，先解决再交付）：%s" % " / ".join(unfilled_req))
    print("ℹ️ 未填的**选填**属性 %d 项（默认留空；按门禁 47 要列给用户问要不要补）：%s"
          % (len(unfilled_opt), " / ".join(unfilled_opt) if unfilled_opt else "（无）"))

    title = a.title or data.get("title") or data["product"].get("商品标题")
    # 品牌（门禁 43）：抖店品牌是必填且必须是你店已申请/已授权的，而源数据常与实际不一致。
    # 之前这里是 `or "示例品牌"` 的静默兜底 —— 等于把「沿用上一批」做成了默认值，
    # 正是门禁 41 点名要避免的形态。现在改成**响亮地说明来源**。
    brand_raw = a.brand or data["product"].get("品牌")
    if brand_raw:
        brand = str(brand_raw).strip()
        print("品牌 = %s（来源：%s）" % (brand, "命令行 --brand" if a.brand else "素材包"))
    else:
        brand = "示例品牌"
        print("⚠ 素材包与命令行都没给品牌 → 兜底用「%s」。抖店品牌是**必填**且必须是"
              "你店已申请/已授权的（门禁 43）—— 请确认这个兜底值是本次要用的。" % brand)
    ref = a.ref_price or data["product"].get("参考价设置") or data["product"].get("参考价")
    try:
        ref = float(ref) if ref is not None else None
    except Exception:
        ref = None

    max_price = max([s["price"] for s in out_skus if s.get("price") is not None] or [0])

    product = {
        "title": title,
        "brand": brand,
        "ref_price": ref,
        "category": data.get("category"),
        "cate_id": data.get("cate_id"),
        "dimensions": dims,
        "skus": out_skus,
        "attributes": attrs,
        "allowed_options": data.get("allowed_options", {}),
        "max_price": max_price,
        "main_count": len(main_pairs),
        "detail_count": len(detail_pairs),
        "spec_image_count": len(spec_pairs),
        "dy_spec_xlsx": None,
    }

    # 抖店规格 Excel（智能识别用）
    spec_xlsx = os.path.join(out, "dy_spec.xlsx")
    build_spec_xlsx(spec_xlsx, dims, out_skus, "price", "stock", "code")
    product["dy_spec_xlsx"] = spec_xlsx.replace("\\", "/")

    # 规格图 → 规格值 的配对。
    # 图片可能沿任一维度变化（GPVC-001 按「颜色」= dims[0]；PE3 按「尺寸」= 色+档位 = dims[1]）。
    # 规则：找**能唯一确定图片的最小维度组合**，然后按该组合取值顺序配对。
    def unique_by(keys):
        m = {}
        for s in out_skus:
            k = tuple(str(s.get(d) or "") for d in keys)
            img = s.get("specImage")
            if not img:
                continue
            if k in m and m[k] != img:
                return None          # 该组合下图片不唯一，弃用
            m[k] = img
        return m or None

    # Excel 引用的规格图文件名 vs 素材目录里实际存在的文件。
    # 对不上时 specImage 会是 None，后面配对必然为 0 —— 之前这一步完全无声，
    # 表现为「规格图一张没填」却查不出原因（实测：Excel 写 sku_01.jpg，目录里是 spec_01.jpg）。
    declared = {r["specImage"] for r in skus_raw if r.get("specImage")}
    missing = sorted(f for f in declared if f not in spec_by_name)
    if missing:
        print("★ 规格图文件名对不上：Excel 引用了 %d 个文件，素材目录里找不到其中 %d 个（如 %s）"
              % (len(declared), len(missing), ", ".join(missing[:5])))
        print("   素材目录的规格图文件名必须与 Excel「规格图片文件名」列一字不差。")
        if not spec_pairs:
            raise SystemExit(4)

    sku_images = {s["specImage"] for s in out_skus if s.get("specImage")}
    pair_dim = None
    img_of = None
    for keys in ([d] for d in dims):                      # 先试单维度
        m = unique_by(keys)
        if m:
            pair_dim, img_of = keys, m
            break
    if img_of is None:                                     # 退回全维度组合
        m = unique_by(dims)
        if m:
            pair_dim, img_of = list(dims), m

    pair_note = None
    spec_pairs_out = []
    spec_dropped_files = []
    if pair_dim and len(pair_dim) > 1:
        # 图沿**多个**维度变化（实测 ZDT-003：24 张图按「颜色×尺寸」出）。
        # 两个平台约束叠加，决定了只能用「值 → 一张图」：
        #   ① 抽屉只列**第一组规格**的值（硬约束 1）；
        #   ② **一个规格值只能挂一张图** —— 实测：图 0 占用了「卡其色-2片/5片/10片」后，
        #      同色另外 3 张图的规格值下拉里**再也找不到这些值**（picked 第一个就 break，
        #      clickedAny=false，重试 3 轮现象完全一致）。
        #      抽屉支持的是「一张图 → 多个值」，不是「一个值 → 多张图」。
        # → 投影到 dims[0]，且**每个值只留给它遇到的第一张图**；后面的图用不上，明确报出来。
        billed = {}        # dims[0] 的值 -> 占用它的图
        projected = {}
        for s in out_skus:
            img = s.get("specImage")
            v = str(s.get(dims[0]) or "")
            if not img or not v:
                continue
            f = img.replace("\\", "/")
            owner = billed.setdefault(v, f)
            if owner != f:
                if os.path.basename(f) not in spec_dropped_files:
                    spec_dropped_files.append(os.path.basename(f))
                continue
            g = projected.setdefault(f, {"file": f, "dim": [dims[0]], "specValues": []})
            if v not in g["specValues"]:
                g["specValues"].append(v)
        spec_pairs_out = list(projected.values())
        print("★ 规格图沿多维度变化（%s）→ 投影到第一组规格「%s」：%d 张图共挂 %d 个值"
              % ("×".join(pair_dim), dims[0], len(spec_pairs_out),
                 sum(len(g["specValues"]) for g in spec_pairs_out)))
        if spec_dropped_files:
            print("   ⚠ 一个规格值只能挂一张图 → 另有 %d 张图用不上（值已被先出现的图占用）：%s%s"
                  % (len(spec_dropped_files), ", ".join(spec_dropped_files[:6]),
                     " …" if len(spec_dropped_files) > 6 else ""))
    elif pair_dim:
        # 一张图可以对应**多个**规格值（例：10 张图管 30 个「颜色-片数」值，每图 3 个值）。
        # 抽屉的规格值下拉是多选 → 按图片聚合，一行选多个值，而不是「一图一行值」。
        grouped = {}
        seen_v = []
        for s in out_skus:
            k = tuple(str(s.get(d) or "") for d in pair_dim)
            if k in seen_v:
                continue
            seen_v.append(k)
            img = img_of.get(k)
            if not img:
                continue
            label = str(s.get(pair_dim[0]) or "")
            if not label:
                continue
            f = img.replace("\\", "/")
            g = grouped.setdefault(f, {"file": f, "dim": list(pair_dim), "specValues": []})
            if label not in g["specValues"]:
                g["specValues"].append(label)
        spec_pairs_out = list(grouped.values())

    # 有规格图却配不出归属 → 必须显式暴露。
    # 否则 run_listing 会「无配对，跳过」，规格图一张不填，而 fails 仍是 []。
    if declared and not sku_images:
        pair_note = {"error": "spec_image_files_not_found", "declared": len(declared),
                     "hint": "Excel 引用的规格图文件名在素材目录里不存在，文件名必须一字不差"}
        print("★ 规格图全部未能对上文件：不会填任何规格图。")
    elif sku_images and not spec_pairs_out:
        pair_note = {"error": "spec_pairing_failed", "sku_images": len(sku_images),
                     "hint": "规格图无法按任一维度唯一确定归属；需人工指定维度，或让规格图只随单一维度变化"}
        print("★ 规格图配对失败：%d 张图无法确定归属，不会填规格图。" % len(sku_images))
        print("   请检查素材包「规格图片文件名」列与规格值的对应关系。")

    payload = {
        "product": product,
        "main_images": [d.replace("\\", "/") for _, d, _ in main_pairs],
        "detail_images": [d.replace("\\", "/") for _, d, _ in detail_pairs],
        "spec_images": spec_pairs_out,
        "spec_pairing": pair_note,
    }
    if spec_dropped_files:
        # 只作留痕：没有代码读这个字段，但交付时要能回答「源数据里那 N 张图去哪了」。
        payload["spec_image_note"] = {
            "dropped": spec_dropped_files,
            "why": "平台一个规格值只能挂一张图；这些图对应的值已被先出现的图占用",
        }
    # 跑完要列给用户的两件事之一（门禁 47）：还没填的选填属性 / 必填却没数据的属性
    payload["unfilled_optional_attrs"] = unfilled_opt
    if unfilled_req:
        payload["unfilled_required_attrs"] = unfilled_req
    out_json = os.path.join(out, "product.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    print("类目 =", data.get("category"), "| cateId =", data.get("cate_id"))
    print("标题 =", title)
    print("品牌 =", brand, "| 参考价 =", ref, "| 最高售价 =", max_price)
    print("规格 =", dims, "| SKU =", len(out_skus))
    print("主图 =", len(main_pairs), "（源 %d，抖店上限 5）" % len(imgs_in(main_src)))
    print("商详图 =", len(detail_pairs), "| 规格图 =", len(spec_pairs), "| 规格图配对 =", len(spec_pairs_out))
    print("属性 =", json.dumps(attrs, ensure_ascii=False))
    print("规格 Excel =", spec_xlsx)
    print("->", out_json)


if __name__ == "__main__":
    main()
