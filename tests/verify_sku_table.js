#!/usr/bin/env node
/**
 * 全表扫 SKU 并出**可交付的凭据**（独立排查用；流程内的 ⑩b 已经在做同一件事）。
 *
 * 为什么还留这个独立入口：`run_listing.js` 跑到 ⑩b 就结束了，如果那一步判 FAIL、
 * 或者事后想单独复核一张已经填好的草稿，就需要一个「不重跑整条流程」的只读入口。
 * **扫描逻辑不在这里重复实现** —— 它就是 `flow.checkSkuTable(page, product)`，
 * 避免两边各写一套、慢慢分叉（我一开始就是分别在两处实现的，已经吃过重复的亏）。
 *
 * 用法：
 *   DY_PRODUCT="<skillRoot>\output\<商品号>\product.json" DY_PORT=9228 \
 *     node "<skillRoot>\tests\verify_sku_table.js"
 *
 * 两种模式由 product.json 自动决定：
 *  A. 有商家编码 → 按编码逐行对账（读到的编码集合 == 期望、无缺、无越界、无空值）
 *  B. 无商家编码 → 核对**各规格维度的值集合**（值数之积 == SKU 数），并确认全表无一行缺价格/库存
 *     （行 DOM 只渲染最后一个规格维度，没编码无法逐行定位）
 */
const fs = require('fs');
const path = require('path');
const flow = require(path.join(__dirname, '..', 'scripts', 'dy_flow.js'));

const productPath = process.env.DY_PRODUCT;
if (!productPath) { console.error('[扫表] FATAL: 请设置 DY_PRODUCT=.../product.json'); process.exit(2); }
const D = JSON.parse(fs.readFileSync(productPath, 'utf8'));

(async () => {
  const { browser, page } = await flow.connectShop(process.env.DY_PORT || '9228', { maxTabs: 20 });
  if (!page) { console.error('[扫表] FATAL: 没有可用的抖店标签页'); process.exit(3); }
  try {
    console.log('[扫表] 步骤 =', await flow.detectStep(page));
    console.log('[扫表] 商品 =', D.product.title, '| SKU =', D.product.skus.length);
    const t0 = Date.now();
    const r = await flow.checkSkuTable(page, D.product);   // ← 与 ⑩b 同一套逻辑
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`[扫表] 全表核对用时 ${secs}s | 扫过行次 = ${r.scanned} | 模式 = ${r.requireCode ? 'A（按编码）' : 'B（无编码→核规格值集合）'}`);
    console.log('[扫表] ---');
    console.log(`[扫表] 行数：价格 ${r.counts.price} / 库存 ${r.counts.stock} / 编码 ${r.counts.code}，对齐 = ${r.countsAligned}`);
    console.log(`[扫表] 空值：价格 ${r.empty.price} / 库存 ${r.empty.stock} / 编码 ${r.empty.code}`);
    console.log('[扫表] 越界：价格', r.unexpected.price.length, JSON.stringify(r.unexpected.price.slice(0, 5)),
                '| 库存', r.unexpected.stock.length, JSON.stringify(r.unexpected.stock.slice(0, 5)),
                '| 编码', r.unexpected.code.length, JSON.stringify(r.unexpected.code.slice(0, 5)));
    if (r.requireCode) console.log(`[扫表] 期望里有但没读到的编码 = ${r.missing.length}`, JSON.stringify(r.missing.slice(0, 5)));
    if (r.holey !== null) console.log(`[扫表] 缺价格/库存的行 = ${r.holey}`);
    if (r.specValues) {
      for (const s of r.specValues) console.log(`[扫表] 规格维度「${s.dim}」值数 ${s.got} / 期望 ${s.expected} ${s.ok ? '✓' : '✗'}`);
      console.log(`[扫表] 各维度值数之积 == SKU 数（${D.product.skus.length}）= ${r.specValues.rowsMatch}`);
    }
    console.log('[扫表] ★ 全表对账 =', r.ok ? 'PASS' : 'FAIL');
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    console.error('[扫表] FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    await flow.disconnectPage(browser);
  }
})().catch((e) => { console.error('[扫表] FATAL:', e.message); process.exit(1); });
