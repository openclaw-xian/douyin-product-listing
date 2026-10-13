#!/usr/bin/env node
/**
 * 抖店上架全流程编排（**只填空与自检，绝不点「发布商品」**）。
 *
 * 用法（先用 build_product.py 生成 product.json）：
 *   DY_PRODUCT=work/product.json DY_PORT=9228 node scripts/run_listing.js
 *
 * 环境变量：
 *   DY_PRODUCT   必填，product.json 路径
 *   DY_PORT      CDP 端口，默认取 config.json 的 default_port（9228）
 *   DY_MAX_TABS  标签页上限，默认 20（超出请先关标签）
 *   DY_SKIP_ATTRS  =1 时跳过属性填充（调试用）
 *   DY_STOP_AFTER  在指定步骤后停下（如 step5），便于分段验证
 *
 * 实测依据见 references/RECON.md：主图 5 槽位 / 类目弹窗需原生 click / 属性上溯第 5 层 /
 * 详情图 input = multiple && 邻近「上传图片」/ 规格 Excel 智能识别 / 规格图抽屉逐行分配。
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const flow = require(process.env.DY_FLOW_JS || path.join(__dirname, 'dy_flow.js'));

const productPath = process.env.DY_PRODUCT;
if (!productPath) { console.error('[FATAL] 请设置 DY_PRODUCT=.../product.json'); process.exit(2); }
const D = JSON.parse(fs.readFileSync(productPath, 'utf8'));
const P = D.product;
// 端口：DY_PORT > config.json 的 default_port > 9228。
// 以前这里写死 '9228'，而文档说「默认取 config.json」—— 改 config 后直接跑 run_listing 仍然是 9228（实测差异）。
const CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); } catch (_) { return {}; }
})();
const PORT = String(process.env.DY_PORT || CONFIG.default_port || '9228');
// DY_ATTEMPT：由 run_until_green.ps1 每轮设进来，只用于日志（以前设了却没人读）
const ATTEMPT = process.env.DY_ATTEMPT || null;
// DY_STOP_AFTER 只支持这几个档；**传别的值以前会静默跑完全程并新建草稿**（实测差异），现在直接报错
const STOP_AFTER = process.env.DY_STOP_AFTER || null;
const STOP_OK = ['step4', 'step5', 'step7', 'step7b'];
if (STOP_AFTER && !STOP_OK.includes(STOP_AFTER)) {
  console.error('[FATAL] DY_STOP_AFTER=' + STOP_AFTER + ' 不支持，可选：' + STOP_OK.join(' / ')
    + '（传别的值以前会静默跑完全程）');
  process.exit(2);
}

const T0 = Date.now();
// util.format：否则 '…%s…' 的占位符不会被替换（第一段是固定前缀，console.log 的
// 格式化只作用于第一个参数，日志里会留下字面量 %s）
const log = (...a) => console.log('[抖店]', `[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, util.format(...a));
const steps = [];
const record = (name, value) => { steps.push({ name, value }); return value; };

(async () => {
  log('产品 =', P.title, '| 类目 =', P.category, '| 端口 =', PORT, '| SKU =', P.skus.length,
      ATTEMPT ? ('| 第 ' + ATTEMPT + ' 轮') : '');

  // ① 探活
  const probe = await flow.probePort(PORT);
  log('① 探活 =', JSON.stringify({ reachable: probe.reachable, tabs: probe.tabs, hasDouyin: probe.hasDouyin }));
  if (!probe.reachable) throw new Error('cdp_unreachable: 端口不可达');
  // ★ 没有抖店标签页时**不能在这里退出**：下面 connectShop 会返回 page=null，
  //   兜底那段 openCreatePage 才是新开页面的地方。
  //   这个早退守卫曾经让兜底变成**死代码**，而 Troubleshooting 却写着「会自动新开」——
  //   2026-10-09 实测踩到（Chrome 里抖店标签被关掉 → 直接 no_douyin_page 退出）。
  if (!probe.hasDouyin) {
    log('① 没有抖店标签页 → 交给下面的兜底新开创建页（复用已登录 profile，不代登录）');
  }

  const det = await flow.connectShop(PORT, { maxTabs: Number(process.env.DY_MAX_TABS || 20) });
  const { browser } = det;
  let page = det.page;
  if (!page) {
    // 原逻辑在这里直接退出。实测更常见的情况是：抖店标签页加载失败变成 network error 页，
    // 被 closeHungTabs 当「卡死页」关掉 → 端口活着但没有可用页面。此时新开一个即可。
    log('① 没有可用的抖店标签页 → 新开创建页（复用已登录 profile，不代登录）');
    try { page = await flow.openCreatePage(browser); } catch (e) { log('   新开失败：', e.message); }
    if (!page) { log('★ 无法打开抖店创建页，请确认 Chrome 已登录抖店'); await flow.disconnectPage(browser); process.exit(3); }
  }

  try {
    log('① 当前页 =', page.url());
    let step = await flow.detectStep(page);
    // DY_FRESH=1 → 强制从第一步重开（会新建草稿，旧草稿仍在后台）
    if (process.env.DY_FRESH === '1' || step === 'unknown') {
      log('   重开创建页（DY_FRESH=%s, step=%s）', process.env.DY_FRESH || '', step);
      await flow.gotoCreate(page);
      step = await flow.detectStep(page);
      // ★ 新草稿里什么都没有 → 规格图的幂等状态文件必须作废。
      //   否则 ⑧ 会以「签名一致」判定已经传过而跳过，新草稿一张规格图都没有，
      //   偏偏 fails 还是 []（实测踩过：新草稿要在 ⑩ 的「请上传规格图」报错里才发现）。
      const sf = path.join(path.dirname(productPath), '.spec_images_done.json');
      if (fs.existsSync(sf)) { fs.unlinkSync(sf); log('   已作废规格图状态文件（新草稿，⑧ 需重传）'); }
    }
    log('① 当前步骤 =', step, '（抖店两步共用一个 URL，靠按钮判断）');

    if (step === 'step1') {
      // ② 主图 5 + 标题
      record('main', await flow.uploadMainImages(page, D.main_images));
      log('② 主图 =', JSON.stringify(steps[steps.length - 1].value));
      record('title', await flow.setTitle(page, P.title));
      log('② 标题 =', JSON.stringify(steps[steps.length - 1].value));

      // ③ 类目（搜索 + 确认）
      record('category', await flow.selectCategory(page, process.env.DY_CATEGORY_KEYWORD || '墙纸', P.category));
      log('③ 类目 =', JSON.stringify(steps[steps.length - 1].value));

      // ④ 下一步
      record('next', await flow.clickNext(page));
      log('④ 下一步 =', JSON.stringify(steps[steps.length - 1].value));

      step = await flow.detectStep(page);
      log('④ 现在步骤 =', step);
      if (step !== 'step2') {
        // 没进第二步 = 类目没确认 / 主图或标题不合规。继续往下填只会得到一屏假失败，
        // 而且是在「类目还没定」的表单上乱填 —— 直接中止并指明去看哪一步的读回值。
        throw new Error('step1_not_advanced: 「下一步」没生效（当前仍在 ' + step + '）；'
          + '通常是类目未选中或主图/标题不合规，查上面 ② 主图/标题 与 ③ 类目 的读回值。');
      }
    } else {
      // ★ 身份校验：当前标签页可能是**另一条草稿**（别的商品/别的类目）。
      //   直接往下填会把数据混进错误的商品，所以要读回标题/类目比对。
      const ident = await page.evaluate((wantCat) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const t = clean(document.body.innerText);
        const norm = (x) => String(x || '').replace(/[\s>]/g, '');
        const el = Array.from(document.querySelectorAll('input')).find((i) => /个字符/.test(i.placeholder || ''));
        return {
          category: (t.match(/商品类目\s*([^\n]{0,120})/) || [])[1] || null,
          // 「商品类目」附近常有平台的改类目建议文案，会把路径挤到中间，
          // 用 endsWith 会误判「不符」→ 直接在整页文案里找目标路径
          bodyHasWanted: wantCat ? norm(t).includes(norm(wantCat)) : false,
          title: el ? el.value : null,
        };
      }, P.category);
      const normCat = (x) => String(x || '').replace(/[\s>]/g, '');
      const catOk = !ident.category || !P.category || ident.bodyHasWanted
        || normCat(ident.category).includes(normCat(P.category));
      const titleOk = !ident.title || !P.title || ident.title === P.title;
      log('★ 已在第二步：跳过主图/标题/类目（就地继续，不刷新页面）');
      log('   身份校验：类目 =', JSON.stringify(ident.category), catOk ? '✓' : '★与目标不符',
          '| 标题 =', JSON.stringify(String(ident.title || '').slice(0, 20)), titleOk ? '✓' : '★与目标不符');
      if ((!catOk || !titleOk) && process.env.DY_ALLOW_STEP2_MISMATCH !== '1') {
        throw new Error('step2_draft_mismatch: 当前草稿与 product.json 不一致（类目/标题），'
          + '拒绝继续填表以免污染别的商品。确认无误可设 DY_ALLOW_STEP2_MISMATCH=1 跳过。');
      }
    }
    if (STOP_AFTER === 'step4') { log('★ 按 DY_STOP_AFTER 停在 step4'); return; }

    // ⑤ 属性
    if (process.env.DY_SKIP_ATTRS === '1') {
      log('⑤ 属性 = (DY_SKIP_ATTRS=1 跳过)');
    } else {
      const attrs = {};
      // 数组原样传下去：fillAttributes 支持多值（逐个点选 + 读回要求全部命中），
      // 之前在这里拍平成 v[0]，多值属性会静默只填第一个。
      for (const [k, v] of Object.entries(P.attributes || {})) attrs[k] = Array.isArray(v) ? v.slice() : v;
      if (P.brand) attrs['品牌'] = P.brand;
      const r = await flow.fillAttributes(page, attrs, { createMissing: process.env.DY_CREATE_ATTR_MISSING === '1' });
      record('attrs', r);
      log('⑤ 属性 ok =', r.ok, '| createMissing =', process.env.DY_CREATE_ATTR_MISSING === '1');
      r.results.forEach((x) => log(`    ${x.ok ? '✓' : '✗'} ${x.label} = ${JSON.stringify(x.got)}${x.ok ? '' : ' (want ' + JSON.stringify(x.want) + ', how=' + x.how + ')'}`));
    }
    if (STOP_AFTER === 'step5') { log('★ 按 DY_STOP_AFTER 停在 step5'); return; }

    // ⑥ 详情图
    record('detail', await flow.uploadDetailImages(page, D.detail_images));
    log('⑥ 详情图 =', JSON.stringify(steps[steps.length - 1].value));

    // ⑦ 规格 Excel + 智能识别
    if (P.dy_spec_xlsx && fs.existsSync(P.dy_spec_xlsx)) {
      record('specExcel', await flow.uploadSpecExcel(page, P.dy_spec_xlsx));
      log('⑦ 规格识别 =', JSON.stringify(steps[steps.length - 1].value));
    } else {
      log('⑦ 规格识别 = (无 dy_spec.xlsx，跳过)');
    }
    if (STOP_AFTER === 'step7') { log('★ 按 DY_STOP_AFTER 停在 step7'); return; }

    // ⑦b 补漏：智能识别偶发会漏填个别行（实测 MZB-007：72 行漏 1 行价格，
    //     价格填写进度 98%、该行显示「该项为必填，请输入」，但可见窗口是好的 → fails 仍绿）。
    //     必须滚动全表扫一遍，按「商家编码」反查 product.json 补齐。
    {
      const miss = await flow.fillMissingSkuCells(page, P.skus);
      record('skuCells', miss);
      log('⑦b 补漏 =', JSON.stringify({ found: miss.found, filled: miss.filled.length, unresolved: miss.unresolved.length }));
      miss.filled.forEach((x) => log(`    ✓ 补 ${x.code} → 价格 ${x.got && x.got.price} 库存 ${x.got && x.got.stock}`));
      miss.unresolved.forEach((x) => log(`    ✗ ${x.code} (${x.reason}) want=${JSON.stringify(x.want)} got=${JSON.stringify(x.got)}`));
    }
    if (STOP_AFTER === 'step7b') { log('★ 按 DY_STOP_AFTER 停在 step7b'); return; }

    // ⑧ 规格图（批量上传 + 逐行分配规格值）
    //   幂等靠状态文件：DOM 判据会被「规格预览/SKU预览图」缩略图骗到
    if ((D.spec_images || []).length) {
      const specStateFile = path.join(path.dirname(productPath), '.spec_images_done.json');
      record('specImages', await flow.uploadSpecImages(page, D.spec_images, { stateFile: specStateFile }));
      log('⑧ 规格图 =', JSON.stringify(steps[steps.length - 1].value));
    } else {
      log('⑧ 规格图 = (无配对，跳过)');
    }

    // ⑨ 发货 / 库存计数 / 状态（默认已选，逐项确认）
    for (const [label, want] of [['现货', '发货模式'], ['48小时', '现货发货时间'], ['下单减库存', '库存计数'], ['上架', '商品状态']]) {
      const before = await flow.readRadioChecked(page, label);
      if (before === true) { log(`⑨ ${want} = ${label} (已选)`); continue; }
      const r = await flow.setRadioByText(page, label);
      const after = await flow.readRadioChecked(page, label);
      log(`⑨ ${want} = ${label} -> ${after === true ? 'OK' : '★未选中'} (${JSON.stringify(r)})`);
    }

    // ⑩ 填写检查 + 读回
    record('fillCheck', await flow.runFillCheck(page));
    const st = steps[steps.length - 1].value;
    log('⑩ 填写检查 =', JSON.stringify(st));

    // ⑩b SKU 表校验（**全表**：跨窗口取并集，不再只看可见窗口）
    //   这一步就是验收口径 —— 它过了就停，不必再另开扫描「自造第二轮核验」。
    const skuChk = await flow.checkSkuTable(page, P);
    record('skuTable', skuChk);
    log('⑩b SKU表（全表）=', JSON.stringify(skuChk));
    if (skuChk.specValues) {
      skuChk.specValues.forEach((s) => log(`    ${s.ok ? '✓' : '✗'} 规格维度 ${s.dim}: 值数 ${s.got}/${s.expected}`));
    }

    // ⑪ 汇总
    const fails = [];
    const m = steps.find((s) => s.name === 'main');
    if (m && !m.value.ok) fails.push('main_images');
    const t = steps.find((s) => s.name === 'title');
    if (t && !t.value.ok) fails.push('title');
    const a = steps.find((s) => s.name === 'attrs');
    if (a && !a.value.ok) fails.push('attrs');
    const se = steps.find((s) => s.name === 'specExcel');
    if (se && !se.value.ok) fails.push('spec_excel_identify');
    const si = steps.find((s) => s.name === 'specImages');
    if (si && !si.value.ok) fails.push('spec_images');
    const sk = steps.find((s) => s.name === 'skuTable');
    if (sk && !sk.value.ok) fails.push('sku_table');
    // ★ 表单里有报错 = 有必填项没填上 → 必须进 fails。
    //   之前只看 fails 的各个步骤，结果「必填进度 100% / errs 有 1 个错」这种半成品也报全绿
    //   （实测 MZB-007：72 行漏 1 行价格，fails 仍是 []）。
    if (st && Array.isArray(st.errs) && st.errs.length) fails.push('form_errors:' + st.errs.length);
    // ★ 补漏没补上的也必须进 fails
    const sc = steps.find((s) => s.name === 'skuCells');
    if (sc && sc.value.unresolved && sc.value.unresolved.length) {
      fails.push('sku_cells_missing:' + sc.value.unresolved.length);
    }
    // ★ 静默降级必须进 fails，不能只打 warning（否则「声明 8 张图、配对 0 个」也能全绿通过）
    if (D.spec_pairing && D.spec_pairing.error) fails.push('spec_pairing:' + D.spec_pairing.error);
    if ((D.spec_images || []).length === 0 && (P.spec_image_count || 0) > 0) {
      fails.push('spec_images_not_paired');
    }
    const multiAttrs = Object.entries(P.attributes || {}).filter(([, v]) => Array.isArray(v) && v.length > 1);
    if (multiAttrs.length) {
      log('   多值属性 =', JSON.stringify(multiAttrs.map(([k, v]) => k + '=' + v.join('/'))));
    }

    log('★ 自检汇总 fails =', JSON.stringify(fails));
    log('★ 表单：必填项进度 =', st.requiredProgress, '% | 详情 =', st.detailUploaded + '/' + st.detailTotal, '| 报错 =', JSON.stringify(st.errs));
    // ★ 门禁 47：跑完必须把「还空着的选填项」摆给用户，不能只说「全绿」。
    //   页面侧（挑重点用）：平台自己的「重要属性 x/y · 其他属性 x/y」+ 待选计数；
    //   模板侧（完整清单）：build_product 算出的 product.json.unfilled_optional_attrs。
    if (st.attrProgress) {
      log('★ 类目属性：重要属性 =', st.attrProgress.important, '| 其他属性 =', st.attrProgress.other,
          '| 页面待选 =', st.pendingSelectCount);
    }
    const unfReq = D.unfilled_required_attrs || [];
    const unfOpt = D.unfilled_optional_attrs || [];
    if (unfReq.length) log('★ 必填属性没有数据（会卡表单，先解决再交付）：', unfReq.join(' / '));
    log('★ 未填的选填属性 ' + unfOpt.length + ' 项（门禁 47：列给用户问要不要补'
        + (unfOpt.length > 8 ? '；先问「重要属性」里空着的那几个，别一次甩全部' : '') + '）：',
        unfOpt.length ? unfOpt.join(' / ') : '（无）');
    const gid = (page.url().match(/goods_id=(\d+)/) || [])[1];
    log('★ 未发布 · 草稿 goods_id =', gid || '(尚未生成，发布或保存草稿后才有)');
    log('★ 请自行检查后在抖店后台点「发布商品」');
    // 退出码契约：fails 非空 = 1，便于外层「跑到绿为止」重试
    // （典型可重试项：spec_image_group_mismatch —— 平台把出图组换到另一维，重开草稿重跑即可）
    if (fails.length) process.exitCode = 1;
  } catch (e) {
    console.error('[抖店] FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    await flow.disconnectPage(browser);
  }
})().catch((e) => { console.error('[抖店] FATAL:', e.message); process.exit(1); });
