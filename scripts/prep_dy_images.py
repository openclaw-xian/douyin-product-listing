#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「拼多多/淘宝」形态的商品图，整理成抖店能吃的形态，并铺进成品包目录。

抖店比拼多多严的三处（都实测过）：
  1) 主图 ≥600×600，最多 5 槽 → 超出截断
  2) 商详图 **宽 620-1290px**、<5MB → 超宽的等比缩到 1290
  3) 规格图 **宽高比 1:1** → 非方形按「居中裁切」转方（裁切优先，缺边太多才补边）

用法：
  python prep_dy_images.py --src "<拼多多\\ZDT-002>" --out "<成品包>" \
      [--skeleton "<官方模板>\\抖音\\商品A-01（复制后改名）"] [--spec-prefix 卡其=SKU_01_卡其]
"""
import argparse
import json
import os
import re
import shutil
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from PIL import Image

IMG_EXT = (".png", ".jpg", ".jpeg", ".webp")
DETAIL_MIN_W, DETAIL_MAX_W = 620, 1290
MAIN_MIN = 600
MB = 1024 * 1024


def imgs_in(d):
    if not d or not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if f.lower().endswith(IMG_EXT))


def pick(d, *kws):
    for kw in kws:
        for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            p = os.path.join(d, n)
            if os.path.isdir(p) and kw in n:
                return p
    return None


def save_under_mb(im, path, limit_mb=5):
    """PNG 超限就转 JPEG；JPEG 还超就降质量。返回最终体积。"""
    im.save(path)
    if os.path.getsize(path) <= limit_mb * MB:
        return os.path.getsize(path)
    if path.lower().endswith(".png"):
        jp = os.path.splitext(path)[0] + ".jpg"
        rgb = im.convert("RGB") if im.mode in ("RGBA", "P", "LA") else im
        for q in (92, 85, 80, 72):
            rgb.save(jp, quality=q)
            if os.path.getsize(jp) <= limit_mb * MB:
                os.remove(path)
                return os.path.getsize(jp)
        os.remove(path)
        return os.path.getsize(jp)
    for q in (92, 85, 80, 72):
        im.save(path, quality=q)
        if os.path.getsize(path) <= limit_mb * MB:
            break
    return os.path.getsize(path)


def to_square_center_crop(im, max_pad_ratio=0.0):
    """居中裁切成 1:1。裁掉的比例超过 (1-max_pad_ratio) 时改为补边，避免裁掉主体。"""
    w, h = im.size
    if w == h:
        return im, "already_square"
    s = min(w, h)
    if max_pad_ratio and s / max(w, h) < max_pad_ratio:
        side = max(w, h)
        bg = im.convert("RGB").crop((0, 0, 1, 1)).resize((side, side))
        bg.paste(im, ((side - w) // 2, (side - h) // 2), im if im.mode == "RGBA" else None)
        return bg, "padded"
    left, top = (w - s) // 2, (h - s) // 2
    return im.crop((left, top, left + s, top + s)), "center_crop"


def slug(name):
    return re.sub(r"[^\w\u4e00-\u9fff]+", "_", os.path.splitext(name)[0]).strip("_")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="商品素材目录（含 商品轮播图/商品详情/预览图 等）")
    ap.add_argument("--out", required=True, help="成品包输出目录")
    ap.add_argument("--skeleton", default=None, help="官方模板的商品文件夹（复制其空目录结构）")
    ap.add_argument("--main-dir", default=None, help="主图源目录（默认自动找 主图/轮播）")
    ap.add_argument("--detail-dir", default=None, help="商详图源目录（默认自动找 商品详情/详情）")
    ap.add_argument("--spec-dir", default=None, help="规格图源目录（默认自动找 规格图片/预览图）")
    ap.add_argument("--main-name-prefix", default="主图")
    ap.add_argument("--detail-name-prefix", default="详情图片")
    ap.add_argument("--spec-name-prefix", default=None,
                    help="规格图重命名前缀（如 SKU_），默认保留源文件名以便素材包引用")
    a = ap.parse_args()

    src, out = a.src, a.out
    os.makedirs(out, exist_ok=True)
    if a.skeleton and os.path.isdir(a.skeleton):
        for n in sorted(os.listdir(a.skeleton)):
            p = os.path.join(a.skeleton, n)
            if os.path.isdir(p):
                os.makedirs(os.path.join(out, n), exist_ok=True)

    main_src = a.main_dir or pick(src, "商品轮播图", "主图", "轮播")
    detail_src = a.detail_dir or pick(src, "商品详情", "详情图", "详情")
    spec_src = a.spec_dir or pick(src, "预览图", "规格图片")

    report = {"main": [], "detail": [], "spec": [], "warnings": []}

    # ---- 主图 ----
    md = os.path.join(out, "主图")
    os.makedirs(md, exist_ok=True)
    for i, f in enumerate(imgs_in(main_src)[:5], 1):
        im = Image.open(os.path.join(main_src, f))
        if min(im.size) < MAIN_MIN:
            report["warnings"].append("main_%s_too_small_%dx%d" % (f, *im.size))
        ext = os.path.splitext(f)[1].lower()
        d = os.path.join(md, "%s_%02d%s" % (a.main_name_prefix, i, ext))
        sz = save_under_mb(im, d)
        report["main"].append({"file": os.path.basename(d), "size": im.size, "kb": round(sz / 1024)})

    # ---- 商详图 ----
    dd = os.path.join(out, "商品详情")
    os.makedirs(dd, exist_ok=True)
    for i, f in enumerate(imgs_in(detail_src), 1):
        im = Image.open(os.path.join(detail_src, f))
        w, h = im.size
        note = "ok"
        if w > DETAIL_MAX_W:
            nh = max(1, round(h * DETAIL_MAX_W / w))
            im = im.resize((DETAIL_MAX_W, nh), Image.LANCZOS)
            note = "resized_w%d->%d" % (w, DETAIL_MAX_W)
        elif w < DETAIL_MIN_W:
            note = "TOO_NARROW_w%d" % w
            report["warnings"].append("detail_%s_too_narrow_%d" % (f, w))
        ext = os.path.splitext(f)[1].lower()
        d = os.path.join(dd, "%s_%02d%s" % (a.detail_name_prefix, i, ext))
        sz = save_under_mb(im, d)
        final = os.path.basename(d)
        if not final.lower().endswith(ext):
            note += "+converted_jpg"
        report["detail"].append({"src": f, "file": final, "size": im.size, "kb": round(sz / 1024), "note": note})

    # ---- 规格图 → 1:1 ----
    sd = os.path.join(out, "规格图片")
    os.makedirs(sd, exist_ok=True)
    for i, f in enumerate(imgs_in(spec_src), 1):
        im = Image.open(os.path.join(spec_src, f))
        before = im.size
        sq, how = to_square_center_crop(im)
        if sq.mode in ("RGBA", "P", "LA"):
            sq = sq.convert("RGBA")
        name = ("%s%02d_%s.png" % (a.spec_name_prefix, i, slug(f))) if a.spec_name_prefix else f
        d = os.path.join(sd, name)
        sz = save_under_mb(sq, d)
        report["spec"].append({"src": f, "file": os.path.basename(d), "before": before,
                               "after": sq.size, "kb": round(sz / 1024), "how": how})

    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
