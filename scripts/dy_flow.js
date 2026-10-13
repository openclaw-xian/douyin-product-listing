#!/usr/bin/env node
/**
 * 抖店（fxg.jinritemai.com）发布页 DOM 层。
 *
 * 分层与 pdd-product-listing 对齐：本文件只管「怎么点」，不管「填什么」。
 * 所有函数都基于 2026-09-30 GPVC-001 实测（见 references/RECON.md）。
 *
 * 关键实测结论（改代码前先读）：
 *  1. 属性控件：标签叶子 → 上溯第 5 层就是 form item 容器
 *  2. 单选下拉展开后 = div.ecom-g-select-dropdown.auto-dropdown-id-<属性名>
 *     多选下拉展开后 = div.ecom-g-select-dropdown.styles_multiSelectDropdown（没有 per-属性 id）
 *  3. 可搜索下拉（品牌）：必须用原生 setter + input 事件，直接赋值不会触发过滤
 *  4. 类目弹窗的搜索结果点击会被 #__ffa-goods-popup-container__ 拦指针 → 必须用原生 el.click()
 *  5. 详情图 file input 的特征是 multiple=true 且邻近文本「上传图片」
 *  6. 批量上传规格图 → 抽屉「规格图设置」→ 行序=上传顺序 → 逐行指定规格值 → 确定
 *  7. 现货发货时间默认「次日发」，必须显式改
 */

const fs = require('fs');
const path = require('path');
const CREATE_URL = 'https://fxg.jinritemai.com/ffa/g/create';
const LIST_URL = 'https://fxg.jinritemai.com/ffa/g/list';
const HOST_RE = /jinritemai\.com/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// playwright-core 统一走 pwresolver（DY_PLAYWRIGHT → 技能自带 tools/npm → 机器级）。
// 以前这里只试 DY_PLAYWRIGHT + 裸模块名 —— 换机器/换 cwd 就 MODULE_NOT_FOUND，
// 而技能其实自带了那份（见 scripts/pwresolver.js 顶部注释）。
const pwresolver = require(path.join(__dirname, 'pwresolver.js'));
function resolvePlaywrightCore() {
  return pwresolver.resolvePlaywrightCore().pw;
}
/** 从哪儿加载的（preflight / 日志用） */
function playwrightSource() {
  return pwresolver.resolvePlaywrightCore();
}

/** CDP 端口探活：可达 + 页面数 + 已登录站点判断 */
async function probePort(port, { timeoutMs = 4000 } = {}) {
  const http = require('http');
  const get = (path) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => req.destroy(new Error('probe_timeout')));
    req.on('error', reject);
  });
  try {
    const ver = await get('/json/version');
    let pages = [];
    try {
      const list = await get('/json/list');
      pages = (JSON.parse(list.body) || []).filter((t) => t.type === 'page');
    } catch (_) {}
    const urls = pages.map((p) => String(p.url || ''));
    return {
      reachable: ver.status === 200,
      tabs: pages.length,
      hasDouyin: urls.some((u) => HOST_RE.test(u)),
      urls: urls.map((u) => u.slice(0, 70)),
      hint: urls.some((u) => HOST_RE.test(u)) ? null : '该端口 Chrome 里没有抖店页面，请先打开 https://fxg.jinritemai.com 登录',
    };
  } catch (e) {
    return { reachable: false, tabs: 0, hasDouyin: false, urls: [], error: e.message };
  }
}

/**
 * 关闭 CDP 无响应的标签页。
 * 教训（拼多多 GPVC-001）：Chrome 154 上 connectOverCDP 会卡在 ws connected，
 * 根因是某个标签页对 Runtime.evaluate 无响应，Playwright 等它初始化直到超时。
 */
async function closeHungTabs(port, { timeoutMs = 3000 } = {}) {
  const http = require('http');
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, timeout: 4000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  const ver = JSON.parse(await get('/json/version'));
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pend.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); resolve({ error: 'TIMEOUT' }); } }, timeoutMs);
  });
  const t = await send('Target.getTargets');
  const pages = (t.result ? t.result.targetInfos : []).filter((x) => x.type === 'page');
  const closed = [];
  for (const p of pages) {
    const att = await send('Target.attachToTarget', { targetId: p.targetId, flatten: true });
    const sid = att.result && att.result.sessionId;
    let alive = false;
    if (sid) {
      const r = await new Promise((resolve) => {
        const mid = ++id;
        pend.set(mid, resolve);
        ws.send(JSON.stringify({
          id: mid, method: 'Runtime.evaluate',
          params: { expression: '1', returnByValue: true }, sessionId: sid,
        }));
        setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); resolve({ error: 'TIMEOUT' }); } }, timeoutMs);
      });
      alive = !r.error && r.result && r.result.result && r.result.result.value === 1;
    }
    if (!alive) {
      await send('Target.closeTarget', { targetId: p.targetId });
      closed.push(String(p.url || '').slice(0, 70));
    }
  }
  ws.close();
  return { checked: pages.length, closed };
}

/** 连接端口并把抖店页面选出来（同 Chrome 里可能同时有拼多多页面） */
async function connectShop(port, { timeout = 120000, maxTabs = 20, closeHung = true } = {}) {
  if (closeHung) { try { await closeHungTabs(port); } catch (_) {} }
  const { chromium } = resolvePlaywrightCore();
  const pre = await probePort(port);
  if (!pre.reachable) throw new Error(`cdp_unreachable: 端口 ${port} 不可达`);
  if (pre.tabs > maxTabs) throw new Error(`cdp_too_many_tabs: ${pre.tabs} 个标签页，先关掉一些`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout });
  const pages = browser.contexts()[0]?.pages() || [];
  const page =
    pages.find((p) => HOST_RE.test(p.url()) && /\/ffa\/g\/create/.test(p.url())) ||
    pages.find((p) => HOST_RE.test(p.url()));
  if (page) await page.bringToFront();
  return { browser, page, douyinPages: pages.filter((p) => HOST_RE.test(p.url())) };
}

async function disconnectPage(browser) {
  try { await browser.close(); } catch (_) {}
}

/**
 * 没有可用的抖店标签页时新开一个创建页。
 * 复用同一个浏览器（= 已登录 profile），**不代登录**：若未登录会落到登录页，
 * 由调用方报错让用户自己登。
 * 触发场景（实测）：标签页加载失败变成 network error 页 → 被 closeHungTabs 当卡死页关掉。
 */
async function openCreatePage(browser, { timeout = 60000 } = {}) {
  const ctx = browser.contexts()[0];
  if (!ctx) return null;
  const blank = ctx.pages().find((p) => /^about:blank$/.test(p.url()));
  const page = blank || (await ctx.newPage());
  await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout });
  await sleep(6000);
  return page;
}

// ---------- 第一步 ----------

async function gotoCreate(page) {
  await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  return detectStep(page);
}

/**
 * 判断当前在第几步。
 * 抖店创建页两步共用一个 URL（/ffa/g/create），**不能靠 URL 判断**，只能看按钮：
 *  step1：有「下一步」
 *  step2：有「发布商品 / 保存草稿 / 填写检查」
 */
async function detectStep(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const btns = Array.from(document.querySelectorAll('button')).filter(vis).map((b) => clean(b.innerText));
    if (btns.includes('下一步')) return 'step1';
    if (btns.some((b) => /发布商品|保存草稿|填写检查/.test(b))) return 'step2';
    return 'unknown';
  });
}

/**
 * 标题：用原生 setter 写入（不依赖 click —— 主图预览浮层会拦指针）。
 * ⚠️ 标题输入框的 placeholder 会随页面状态变（实测）：
 *   全新第一步  → 「请输入2-60个字符（1-30个汉字）」
 *   有草稿/第二步 → 「请输入15-60个字符（8-30个汉字）」
 *   所以**不能写死数字**，按「含 个字符 且含 汉字」来找。
 */
async function setTitle(page, title) {
  await dismissOverlays(page);
  const r = await page.evaluate((val) => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const cands = Array.from(document.querySelectorAll('input')).filter((i) => {
      if (!vis(i)) return false;
      const ph = i.placeholder || '';
      return /个字符/.test(ph) && /汉字/.test(ph);
    });
    if (!cands.length) return { ok: false, reason: 'title_input_not_found' };
    const el = cands[0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return { ok: true, now: el.value, placeholder: el.placeholder };
  }, title);
  await sleep(800);
  return { ok: r.ok && r.now === title, now: r.now, reason: r.reason, placeholder: r.placeholder };
}

/**
 * 等「商品类目」区出现（全新第一步里，类目区要等主图+标题给完、AI 识别后才渲染）。
 * @returns {Promise<{ok:boolean, ms:number, hasManualEntry:boolean}>}
 */
async function waitForCategorySection(page, { timeoutMs = 45000, pollMs = 1000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const t = clean(document.body.innerText);
      return {
        hasSection: /商品类目/.test(t),
        hasManualEntry: /手动选择类目/.test(t),
        hasRecommend: /更多推荐|智能推荐/.test(t),
      };
    });
    if (st.hasManualEntry) return { ok: true, ...st, ms: Date.now() - t0 };
    if (st.hasSection && st.hasRecommend) {
      // 有推荐但还没「手动选择类目」→ 继续等
    }
    await sleep(pollMs);
  }
  const st = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const t = clean(document.body.innerText);
    return { hasSection: /商品类目/.test(t), hasManualEntry: /手动选择类目/.test(t) };
  });
  return { ok: false, ...st, ms: Date.now() - t0, reason: 'category_section_timeout' };
}

/**
 * 关掉阻挡点击的浮层。
 * 实测（GPVC-001）：主图上传后会弹出图片预览，其容器是
 * div.ant-scrolling-effect#__ffa-goods-popup-container__，它会 intercept pointer events，
 * 导致后续 Playwright click 全部超时。Escape + 点空白可关闭。
 */
async function dismissOverlays(page) {
  await page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const sels = [
      '[class*=preview] [class*=close]', '[class*=Preview] [class*=close]',
      '[class*=modal-close]', '[class*=Modal] [class*=close]',
      'svg[class*=close]', '[class*=closeIcon]', '[class*=close-icon]',
    ];
    for (const s of sels) {
      const el = Array.from(document.querySelectorAll(s)).filter(vis)[0];
      if (el) { el.click(); return; }
    }
  }).catch(() => {});
  try { await page.keyboard.press('Escape'); } catch (_) {}
  await sleep(400);
  // 点页面左上角空白（避开所有控件）
  try { await page.mouse.click(2, 2); } catch (_) {}
  await sleep(400);
  return { ok: true };
}

/**
 * 主图：1 张商品正面图 + 4 张辅助图 = 5 个槽位
 * 全部是 input[type=file][accept="image/*"]，按邻近文本区分
 */
async function uploadMainImages(page, files, { timeoutMs = 120000 } = {}) {
  const slots = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const all = Array.from(document.querySelectorAll('input[type=file]'));
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!/image/.test(el.accept || '')) continue;
      let near = '';
      let p = el.parentElement;
      for (let k = 0; k < 6 && p; k++) { const t = clean(p.innerText); if (t) { near = t.slice(0, 40); break; } p = p.parentElement; }
      if (/商品正面图|上传主图/.test(near)) out.push({ i, role: 'front' });
      else if (/上传辅助图/.test(near)) out.push({ i, role: 'extra' });
    }
    return out;
  });
  const front = slots.find((s) => s.role === 'front');
  const extras = slots.filter((s) => s.role === 'extra');
  if (!front) return { ok: false, reason: 'front_slot_not_found', slots };
  const use = files.slice(0, 5);
  await page.locator('input[type=file]').nth(front.i).setInputFiles(use[0], { timeout: timeoutMs });
  await sleep(2500);
  const uploaded = [use[0]];
  for (let k = 1; k < use.length && k <= extras.length; k++) {
    try {
      await page.locator('input[type=file]').nth(extras[k - 1].i).setInputFiles(use[k], { timeout: 30000 });
      uploaded.push(use[k]);
      await sleep(1500);
    } catch (_) {}
  }
  await sleep(1500);
  await dismissOverlays(page);
  return { ok: uploaded.length === use.length, expect: use.length, uploaded: uploaded.length, skipped: files.length - use.length };
}

/**
 * 类目：点「手动选择类目」→ 搜索关键词 → 原生 click 选中 → 确认
 * @param {string} keyword 搜索词，如「墙纸」
 * @param {string} [fullPath] 期望的完整路径（结果文本无分隔符拼接，如「家装建材墙面材料墙纸」）
 */
async function selectCategory(page, keyword, fullPath, { waitMs = 45000 } = {}) {
  await dismissOverlays(page);
  // 全新第一步里类目区是异步渲染的，先等「手动选择类目」入口
  await waitForCategorySection(page, { timeoutMs: waitMs });
  const want = (fullPath || keyword).replace(/[\s>]/g, '');
  // 「手动选择类目」在 AI 推荐区里，那个区域会持续重渲染 →
  // Playwright click 会卡在「element is not stable / detached」。
  // 改用原生 el.click() + 轮询重试，直到弹窗出现。
  let opened = false;
  for (let i = 0; i < 15; i++) {
    const r = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (el) => !!(el && el.offsetParent !== null);
      // 弹窗已开？
      if (Array.from(document.querySelectorAll('*')).some((e) => vis(e) && clean(e.innerText) === '选择类目')) return 'modal_open';
      const el = Array.from(document.querySelectorAll('span,div,button,a'))
        .filter((e) => vis(e) && e.children.length === 0 && clean(e.innerText) === '手动选择类目')[0];
      if (!el) return 'no_entry';
      el.click();
      return 'clicked';
    }).catch(() => 'err');
    if (r === 'modal_open') { opened = true; break; }
    await sleep(1200);
    // 点完等弹窗
    const hasModal = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (el) => !!(el && el.offsetParent !== null);
      return Array.from(document.querySelectorAll('*')).some((e) => vis(e) && clean(e.innerText) === '选择类目');
    });
    if (hasModal) { opened = true; break; }
  }
  if (!opened) return { ok: false, reason: 'manual_picker_entry_not_found' };
  await sleep(1500);
  const si = page.locator('input[placeholder*="类目关键词搜索"]').first();
  if (!(await si.count())) return { ok: false, reason: 'search_input_not_found' };

  // 搜索结果是**异步拉的**：实测偶发 2.5s 后一条 resultItem 都没渲染（sample 为空），
  // 于是被误判成 no_match，接着「下一步」disabled、后面整段假失败。
  // 改成：填完轮询等结果出现（最多 ~12s），没出来就清空重搜一次。
  let picked = { ok: false, reason: 'no_match', sample: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    await si.fill('');
    await sleep(400);
    await si.fill(keyword);
    for (let t = 0; t < 12; t++) {
      await sleep(1000);
      const n = await page.evaluate(() => document.querySelectorAll('div[class*=resultItem]').length);
      if (n > 0) break;
    }
    picked = await page.evaluate((wantPath) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const items = Array.from(document.querySelectorAll('div[class*=resultItem]'));
    const norm = (t) => clean(t).replace(/[\s>]/g, '');
    const hit = items.find((el) => norm(el.innerText) === wantPath) || items.find((el) => norm(el.innerText).endsWith(wantPath));
    if (!hit) return { ok: false, reason: 'no_match', sample: items.slice(0, 10).map((e) => clean(e.innerText)) };
    hit.click();
    return { ok: true, picked: clean(hit.innerText) };
    }, want);
    if (picked.ok) break;
    if (picked.reason !== 'no_match') break;
    await sleep(1500);
  }
  if (!picked.ok) return picked;
  await sleep(2000);

  const confirmed = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const b = Array.from(document.querySelectorAll('button')).find((x) => clean(x.innerText) === '确认');
    if (!b) return { ok: false, reason: 'confirm_btn_not_found' };
    b.click();
    return { ok: true };
  });
  if (!confirmed.ok) return confirmed;
  await sleep(3000);

  const readback = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const m = clean(document.body.innerText).match(/商品类目\s*([^\n]{0,60})/);
    let category = m ? m[1].trim() : null;
    if (category) category = category.split('修改')[0].trim();
    const nextBtn = Array.from(document.querySelectorAll('button')).find((b) => clean(b.innerText) === '下一步');
    return { category, nextEnabled: nextBtn ? !nextBtn.disabled : null };
  });
  return { ok: true, picked: picked.picked, ...readback };
}

async function clickNext(page) {
  const r = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const b = Array.from(document.querySelectorAll('button')).find((x) => clean(x.innerText) === '下一步');
    if (!b) return { ok: false, reason: 'next_not_found' };
    if (b.disabled) return { ok: false, reason: 'next_disabled' };
    b.click();
    return { ok: true };
  });
  if (r.ok) await sleep(10000);
  return r;
}

// ---------- 属性 ----------

const ATTR_LABELS = [
  '品牌', '适用场景', '适用对象', '墙纸规格', '计价单位', '面层工艺', '风格', '图案',
  '有无图案', '同城服务', '壁画材质', '厚度', '每卷长度(m)', '每卷宽度(m)', '材质',
  '类型', '产地', '是否可定制', '辅材套餐', '适用空间', '上市时间',
];

/** 打开某属性下拉（原生 click） */
async function openAttr(page, label) {
  const r = await page.evaluate((name) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const leaf = Array.from(document.querySelectorAll('label,span,div')).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      const t = clean(el.innerText);
      return t === name || t === '* ' + name || t === '*' + name;
    })[0];
    if (!leaf) return { ok: false, reason: 'label_not_found' };
    let item = leaf.parentElement;
    for (let k = 0; k < 6 && item; k++) {
      if (item.querySelector('input.ecom-g-select-selection-search-input')) break;
      item = item.parentElement;
    }
    if (!item) return { ok: false, reason: 'container_not_found' };
    const sel = item.querySelector('input.ecom-g-select-selection-search-input');
    if (!sel) return { ok: false, reason: 'no_select_input' };
    // ★ 幂等：点 trigger 是**切换**。多值属性逐个填时会二次调用本函数，
    //   再点一次会把刚打开的下拉关掉 → 第二个值永远选不上（实测「功能=防滑/耐磨耐踩」
    //   只填进「防滑」，且报 how=retry:retry2）。已展开就直接返回。
    if (sel.getAttribute('aria-expanded') === 'true') return { ok: true, already: true };
    sel.click();
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return { ok: true };
  }, label);
  await sleep(r.ok && r.already ? 200 : 900);
  return r;
}

/** 选中属性值：单选走 auto-dropdown-id，多选走 styles_multiSelectDropdown */
async function pickAttr(page, label, value) {
  const r = await page.evaluate(async (a) => {
    const { label: name, value } = a;
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    // 可见项里精确找；找不到就**在下拉内部滚动**再找
    // （实测「适用空间」38 项，首屏只渲染约 10 项，「卧室」必须滚动才出现）
    const pickIn = async (box) => {
      // 候选必须**可见**：rc-select 里还有 height:0;width:0;overflow:hidden 的
      // 隐藏 role=option 节点，文本与真值相同，点它不会生效
      const visible = (el) => {
        if (!el || el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const tryClick = () => {
        const items = Array.from(box.querySelectorAll('*'))
          .filter((el) => el.children.length === 0 && clean(el.innerText) === value)
          .filter(visible);
        if (!items.length) return null;
        items[0].click();
        return clean(items[0].innerText);
      };
      let hit = tryClick();
      if (hit) return hit;
      // 选「可滚距离最大」的容器：抖店多选是虚拟树
      // （ecom-g-select-tree-list-holder，overflow:hidden 但可编程滚动；
      //   小元素 ecom-g-select-tree-treenode 也会满足 sh>ch，必须先排除）
      const cands = Array.from(box.querySelectorAll('*'))
        .filter((el) => el.scrollHeight > el.clientHeight + 10)
        .sort((x, y) => (y.scrollHeight - y.clientHeight) - (x.scrollHeight - x.clientHeight));
      const sc = cands[0] || box;
      const stepPx = Math.max(60, Math.floor((sc.clientHeight || 200) / 2));
      for (let st = 0; st <= (sc.scrollHeight || 0) + stepPx; st += stepPx) {
        sc.scrollTop = st;
        await wait(150);
        hit = tryClick();
        if (hit) return hit;
      }
      sc.scrollTop = 0;
      await wait(150);
      return null;
    };
    const collect = (box) => Array.from(box.querySelectorAll('*'))
      .filter((el) => el.children.length === 0 && clean(el.innerText))
      .map((el) => clean(el.innerText)).slice(0, 20);
    const single = Array.from(document.querySelectorAll('.ecom-g-select-dropdown.auto-dropdown-id-' + CSS.escape(name))).filter(vis)[0];
    if (single) {
      const hit = await pickIn(single);
      if (hit) return { ok: true, clicked: hit, kind: 'single' };
      return { ok: false, reason: 'value_not_in_options', kind: 'single', sample: collect(single) };
    }
    // ★ 多选下拉没有 per-属性 id（styles_multiSelectDropdown / ecom-g-tree-select-dropdown）。
    //   取「第一个可见的」会点进**别的控件残留的下拉** → 值落到隔壁字段。
    //   所以要求「可见的多选下拉有且只有一个」，否则拒绝而不是乱点。
    const multis = Array.from(document.querySelectorAll('[class*=multiSelectDropdown]')).filter(vis);
    if (multis.length > 1) {
      return { ok: false, reason: 'ambiguous_dropdown', kind: 'multi', n: multis.length,
               other: multis.slice(0, 3).map((b) => collect(b).slice(0, 4)) };
    }
    const multi = multis[0];
    if (multi) {
      const hit = await pickIn(multi);
      if (hit) return { ok: true, clicked: hit, kind: 'multi' };
      return { ok: false, reason: 'value_not_in_options', kind: 'multi', sample: collect(multi) };
    }
    return { ok: false, reason: 'dropdown_not_found' };
  }, { label, value });
  await sleep(700);
  return r;
}

/** 可搜索下拉（品牌）：必须原生 setter + input 事件才会过滤 */
async function searchAndPickAttr(page, label, keyword) {
  const typed = await page.evaluate((a) => {
    const { label: name, keyword } = a;
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const leaf = Array.from(document.querySelectorAll('label,span,div')).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      const t = clean(el.innerText);
      return t === name || t === '* ' + name || t === '*' + name;
    })[0];
    if (!leaf) return { ok: false, reason: 'label_not_found' };
    let item = leaf.parentElement;
    for (let k = 0; k < 6 && item; k++) {
      const s = item.querySelector('input.ecom-g-select-selection-search-input');
      if (s) {
        s.focus(); s.click();
        setter.call(s, keyword);
        s.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      }
      item = item.parentElement;
    }
    return { ok: false, reason: 'input_not_found' };
  }, { label, keyword });
  if (!typed.ok) return typed;
  await sleep(2500);
  return pickAttr(page, label, keyword);
}

/** 读回属性值 */
async function readAttr(page, label) {
  return page.evaluate((name) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const leaf = Array.from(document.querySelectorAll('label,span,div')).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      const t = clean(el.innerText);
      return t === name || t === '* ' + name || t === '*' + name;
    })[0];
    if (!leaf) return null;
    let item = leaf.parentElement;
    for (let k = 0; k < 6 && item; k++) {
      // 多选控件会渲染**多个** selection-item：只取第一个会让多值属性永远「读回不满足」
      // （实测「功能=防滑/耐磨耐踩」其实已填进页面，但读回只有「防滑」→ 判失败并反复重试）
      const tags = Array.from(item.querySelectorAll('[class*=selection-item],[class*=SelectionItem]'))
        .filter((e) => !/remove/i.test(String(e.className || '')))
        .map((e) => clean(e.innerText)).filter(Boolean);
      if (tags.length) return [...new Set(tags)].join(' / ');
      const i = Array.from(item.querySelectorAll('input.ecom-g-input')).filter(vis)[0];
      if (i && i.value) return i.value;
      item = item.parentElement;
    }
    return '';
  }, label);
}

/** 文本类属性（厚度 / 每卷长度(m) / 每卷宽度(m) / 上市时间） */
async function fillTextAttr(page, label, value) {
  return page.evaluate((a) => {
    const { label: name, value } = a;
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const leaf = Array.from(document.querySelectorAll('label,span,div')).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      const t = clean(el.innerText);
      return t === name || t === '* ' + name || t === '*' + name;
    })[0];
    if (!leaf) return { ok: false, reason: 'label_not_found' };
    let item = leaf.parentElement;
    for (let k = 0; k < 6 && item; k++) {
      const inp = Array.from(item.querySelectorAll('input.ecom-g-input')).filter(vis)[0];
      if (inp) {
        setter.call(inp, String(value));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        return { ok: true, now: inp.value };
      }
      item = item.parentElement;
    }
    return { ok: false, reason: 'input_not_found' };
  }, { label, value });
}

/**
 * 批量填属性。
 * @param {object} map { 属性名: 值 }
 * @param {object} [opts] { searchable: ['品牌'], text: ['厚度'] }
 */
async function fillAttributes(page, map, { searchable = ['品牌'], text = ['厚度', '每卷长度(m)', '每卷宽度(m)', '上市时间'], createMissing = false } = {}) {
  const results = [];
  for (const [label, rawValue] of Object.entries(map)) {
    const labelText = String(label).replace(/\s*★\s*/g, '');
    // 支持多值：值是数组时逐个点选（多选控件）
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).map(String).filter((v) => v !== '');
    const want = Array.isArray(rawValue) ? values.join(' / ') : values[0];
    // ★ 幂等：先读当前值；已覆盖全部目标值就跳过。
    //   多选下拉再点一次同一项会把已选值**取消**（GPVC-001 实测：适用空间/壁画材质 被点空）
    const cur = await readAttr(page, labelText);
    if (cur && values.length && values.every((v) => String(cur).includes(v))) {
      results.push({ label: labelText, want, got: cur, ok: true, how: 'already' });
      continue;
    }
    let r;
    let usedKind = null;            // 记下用的是单选还是多选分支，失败时好给出可解释的原因
    if (text.includes(labelText)) r = await fillTextAttr(page, labelText, values[0]);
    else if (searchable.includes(labelText)) r = await searchAndPickAttr(page, labelText, values[0]);
    else {
      // 多值：逐个点选，每次都重新打开下拉（多选控件点一次不会自动关）
      r = { ok: true, kind: values.length > 1 ? 'multi' : 'single' };
      for (const v of values) {
        const o = await openAttr(page, labelText);
        // 「不是下拉」的属性（实测「货号」是纯文本框）→ 退化为文本直填，
        // 否则会一路报 value_not_in_options，而其实该字段是能填的
        if (!o.ok && /no_select_input|container_not_found|label_not_found/.test(String(o.reason || ''))) {
          r = { ...(await fillTextAttr(page, labelText, v)), kind: 'text_fallback' };
          break;
        }
        if (!o.ok) { r = { ok: false, reason: o.reason }; break; }
        const one = await pickAttr(page, labelText, v);
        if (one.kind) usedKind = one.kind;
        if (!one.ok) { r = one; break; }
      }
      if (!r.ok) { try { await page.keyboard.press('Escape'); } catch (_) {} await sleep(300); }
    }
    // 值不在下拉里 → 可选：新建该选项并选中
    // （抖店自定义属性值**仅在当前草稿有效**，不会写回店铺类目选项集）
    if (createMissing && !r.ok && /value_not_in_options/.test(String(r.reason || ''))) {
      let created;
      try { created = await addAttrOption(page, labelText, values[0]); }
      catch (e) { created = { ok: false, reason: 'addAttrOption_threw:' + e.message }; }
      r = { ok: created.ok, reason: created.ok ? 'created' : created.reason, kind: 'create' };
      if (created.ok) {
        const backC = await readAttr(page, labelText);
        const okC = backC && values.every((v) => String(backC).includes(v));
        results.push({ label: labelText, want, got: backC, ok: !!okC, how: 'created' });
        continue;
      }
    }
    const satisfied = (v) => v && values.every((x) => String(v).includes(x));
    let back = await readAttr(page, labelText);
    let how = r.kind || (r.ok ? 'ok' : r.reason);
    // 多值属性撞上**单值控件**：抖店把单值下拉标成 `auto-dropdown-id-<属性>`（见门禁 7），
    // 每次点击是**替换**而不是累加 → 最后只剩最后一个值。
    // 实测：地垫类目的「适用场景」是单值控件，传「商用,办公」只会留下「办公」。
    // 这不是流程 bug，是**数据给了单值控件承载不了的多值** —— 要给出可读的原因，别只报 retry:retry2。
    const singleOnly = () => !satisfied(back) && values.length > 1 && usedKind === 'single';
    // 抗抖动：下拉偶发没及时打开 / 虚拟节点被回收 → 最多再试 2 轮
    for (let attempt = 0; attempt < 2 && !satisfied(back); attempt++) {
      try { await page.keyboard.press('Escape'); } catch (_) {}
      await sleep(600);
      if (text.includes(labelText)) r = await fillTextAttr(page, labelText, values[0]);
      else if (searchable.includes(labelText)) r = await searchAndPickAttr(page, labelText, values[0]);
      else {
        r = { ok: true, kind: 'retry' };
        for (const v of values) {
          const o2 = await openAttr(page, labelText);
          if (!o2.ok && /no_select_input|container_not_found|label_not_found/.test(String(o2.reason || ''))) {
            r = { ...(await fillTextAttr(page, labelText, v)), kind: 'text_fallback' };
            break;
          }
          if (!o2.ok) { r = { ok: false, reason: o2.reason }; break; }
          const one = await pickAttr(page, labelText, v);
          if (one.kind) usedKind = one.kind;
          if (!one.ok) { r = one; break; }
        }
      }
      await sleep(500);
      back = await readAttr(page, labelText);
      how = (r.kind || (r.ok ? 'ok' : r.reason)) + ':retry' + (attempt + 1);
      if (!satisfied(back)) { try { await page.keyboard.press('Escape'); } catch (_) {} }
    }
    results.push({ label: labelText, want, got: back, ok: !!satisfied(back),
                   how: singleOnly() ? 'single_select_only（该属性是单值控件，多值只会留下最后一个）' : how });
  }
  return { ok: results.every((x) => x.ok), results };
}

/**
 * 在属性下拉里新建一个选项值（抖店自定义属性；**仅当前草稿有效**，不写回店铺类目选项集）。
 *
 * 实测要点（2026-10-05 隔离验证）：
 *  1. **不需要**先在搜索框输入 —— 点「+新建」后编辑器本来就是空的
 *  2. 选择器**必须限定在本属性自己的下拉内**：`.ecom-g-select-dropdown.auto-dropdown-id-<属性名>`
 *     页面上每个属性都有同名入口，其余下拉是 display:none，用 `.first()` 会选中隐藏的那个
 *  3. 必须用 **Playwright 真实点击**（原生 dispatchEvent 触发不了 React；真实点击还会自动滚动到位，
 *     因为该入口在虚拟列表末尾，不输入时可能在可视区外，实测 rect.y = -1334）
 *  4. 编辑器输入框 `input[placeholder="请输入自定义属性"]` 必须用 **keyboard.type** 真实输入
 *     （setter 改值不进 React state，点确认会被当空值）
 *  5. 确认/取消是 `img[alt="确认"]` / `img[alt="取消"]`
 */
async function addAttrOption(page, label, value) {
  try { await page.keyboard.press('Escape'); } catch (_) {}
  await sleep(600);
  await openAttr(page, label);
  await sleep(1500);

  // 1) 真实点击「+新建<属性名>」（限定在本属性的下拉内；真实点击会自动把虚拟列表里的入口滚进视口）
  const entry = page.locator(`.ecom-g-select-dropdown.auto-dropdown-id-${label} span.styles_newSKU__tOwhj`).first();
  if (!(await entry.count())) {
    // 多选属性的下拉没有 auto-dropdown-id → 退回可见的 multiSelectDropdown
    const alt = page.locator('[class*=multiSelectDropdown] span.styles_newSKU__tOwhj').first();
    if (!(await alt.count())) return { ok: false, reason: 'new_entry_not_found' };
    await alt.click({ timeout: 10000, force: true }).catch(() => {});
  } else {
    await entry.click({ timeout: 10000, force: true }).catch(() => {});
  }

  // 2) 轮询等自定义输入框（出现有延迟）
  const custom = page.locator('input[placeholder="请输入自定义属性"]').first();
  let ready = false;
  for (let i = 0; i < 10; i++) {
    await sleep(1200);
    if (await custom.count()) { ready = true; break; }
  }
  if (!ready) return { ok: false, reason: 'custom_input_not_found' };

  // 3) 真实键盘输入值
  await custom.click({ timeout: 8000, force: true }).catch(() => {});
  try { await page.keyboard.press('Control+a'); } catch (_) {}
  try { await page.keyboard.press('Backspace'); } catch (_) {}
  await page.keyboard.type(String(value), { delay: 140 });
  await sleep(900);

  // 4) 点「确认」
  const ok = page.locator('img[alt="确认"]').first();
  if (!(await ok.count())) return { ok: false, reason: 'confirm_btn_not_found' };
  await ok.click({ timeout: 10000, force: true });

  let readback = '';
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    readback = await readAttr(page, label);
    if (String(readback) === String(value)) break;
  }
  return { ok: String(readback) === String(value), readback, created: true };
}

// ---------- 图文 ----------

/** 详情图：multiple=true 且邻近文本「上传图片」。幂等：已够张数就不重复上传 */
async function uploadDetailImages(page, files, { timeoutMs = 180000, force = false } = {}) {
  const before = await readDetailCounter(page);
  if (!force && before && before.uploaded >= files.length) {
    return { ok: true, skipped: true, reason: 'already_enough', counter: before };
  }
  const idx = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const all = Array.from(document.querySelectorAll('input[type=file]'));
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el.multiple || !/image/.test(el.accept || '')) continue;
      let p = el.parentElement;
      for (let k = 0; k < 4 && p; k++) { if (clean(p.innerText) === '上传图片') return i; p = p.parentElement; }
    }
    return -1;
  });
  if (idx < 0) return { ok: false, reason: 'detail_input_not_found' };
  await page.locator('input[type=file]').nth(idx).setInputFiles(files, { timeout: timeoutMs });
  await sleep(8000);
  const counter = await readDetailCounter(page);
  return { ok: true, expect: files.length, before, counter };
}

async function readDetailCounter(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const m = clean(document.body.innerText).match(/商详图片[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]/);
    return m ? { uploaded: Number(m[1]), total: Number(m[2]) } : null;
  });
}

// ---------- 价格库存 ----------

/**
 * 上传规格 Excel → 点「智能识别」。
 * 输入框可能不在页面上：识别完成后助手区变成「完成识别并填入规格选项 / 删除 / 重新上传」，
 * 此时需先点「重新上传」或「删除」把上传卡叫回来。
 */
async function uploadSpecExcel(page, xlsxPath, { identify = true, force = false } = {}) {
  // 幂等：已识别过（助手区显示「完成识别并填入规格选项」或规格表已有行）就直接跳过，
  // 否则会把已建好的规格再识别一遍、且按钮状态与首次不同导致误判失败
  if (!force) {
    const st = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const t = clean(document.body.innerText);
      const rows = document.querySelectorAll('input[placeholder="请输入erp编码"]').length;
      const done = /完成识别并填入规格选项/.test(t);
      return { rows, done };
    });
    if (st.done || st.rows > 0) {
      return { ok: true, skipped: true, reason: 'spec_already_recognized', ...st };
    }
  }
  const findInput = async () => page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('input[type=file]'));
    for (let i = 0; i < all.length; i++) {
      const a = all[i].accept || '';
      if (/\.xlsx|\.xls|\.csv|excel/i.test(a)) return i;
    }
    return -1;
  });
  let idx = await findInput();
  if (idx < 0) {
    // 叫回上传卡
    await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (el) => !!(el && el.offsetParent !== null);
      for (const t of ['重新上传', '删除']) {
        const b = Array.from(document.querySelectorAll('button,span,div'))
          .filter((e) => vis(e) && e.children.length === 0 && clean(e.innerText) === t)[0];
        if (b) { b.click(); return; }
      }
    });
    await sleep(3000);
    idx = await findInput();
  }
  if (idx < 0) return { ok: false, reason: 'spec_excel_input_not_found' };
  await page.locator('input[type=file]').nth(idx).setInputFiles(xlsxPath, { timeout: 60000 });
  await sleep(4000);
  if (!identify) return { ok: true, uploaded: true, idx };
  const clicked = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const b = Array.from(document.querySelectorAll('button')).find((x) => clean(x.innerText) === '智能识别');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  });
  if (!clicked) return { ok: false, reason: 'identify_btn_disabled_or_missing', idx };
  // 判定「识别完成」以**文案**为准，不能只看可见行数：
  // SKU 表是虚拟滚动，识别完成那一刻可见行数可能是 0（PE3 实测因此误判失败）。
  // ★ 但「完成识别」文案出现 ≠ 各列都填完了：助手是**分列递进**填的
  //   （价格/库存 → 编码）。首轮实测一出现文案就 break（progress 还是 null），
  //   结果价格/库存已填、商家编码整列空着 → 所以还要等「价格填写进度 100%」。
  let rows = 0, recognized = false, text = null, progress = null, codesFilled = 0, waitAfterDone = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const st = await page.evaluate(() => {
      const t = (document.body.innerText || '');
      const m = t.match(/(正在为您优化规格层级|完成识别并填入规格选项|已为您生成规格信息)/);
      const p = t.match(/价格填写进度\s*(\d+)%/);
      const codes = Array.from(document.querySelectorAll('input[placeholder="请输入erp编码"]'))
        .filter((el) => el.offsetParent !== null).map((el) => String(el.value || '').trim());
      return {
        rows: codes.length,
        done: /完成识别并填入规格选项/.test(t),
        text: m ? m[1] : null,
        progress: p ? Number(p[1]) : null,
        codesFilled: codes.filter(Boolean).length,
      };
    });
    rows = st.rows; recognized = st.done; text = st.text; progress = st.progress; codesFilled = st.codesFilled;
    if (recognized && progress === 100 && codesFilled > 0) break;
    if (recognized) {
      waitAfterDone += 3;
      if (waitAfterDone >= 30) break;      // 个别类目没有进度文案/编码列 → 别死等
    }
  }
  return { ok: recognized || rows > 0, visibleRows: rows, recognized, priceProgress: progress,
           codesFilled, idx, text };
}

/**
 * 补漏：把「智能识别」漏填的 SKU 单元格补齐。
 *
 * 实测（MZB-007）：72 行里助手漏填了 1 行的价格，症状是 `价格填写进度 98%`、
 * 该行显示「该项为必填，请输入」、库存是 0 —— 而 `fails` 仍为 `[]`（因为可见窗口里
 * 那十几行都是好的）。所以必须在 ⑩ 之前**滚动全表**扫一遍并补齐。
 *
 * 定位：按该行「商家编码」输入框的值去 `product.json` 反查。**同码多行（编码不唯一）时
 * 不猜** —— 直接记为 ambiguous 返回，交人工（例：ZDT-002 有 12 个唯一码对应 36 行）。
 */
async function fillMissingSkuCells(page, skus, { maxRounds = 60 } = {}) {
  const byCode = new Map();
  for (const s of skus) {
    const k = String(s.code || '').trim();
    if (!k) continue;
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(s);
  }
  // 源素材包可能整列没有编码（实测 GPE-002）→ 没有定位依据，滚一遍也无意义，直接跳过。
  if (byCode.size === 0) {
    return { found: 0, filled: [], unresolved: [], ok: true, skipped: 'no_codes_to_match' };
  }
  const resetScroll = () => page.evaluate(() => {
    const inp = document.querySelector('input[placeholder="请输入erp编码"]');
    let el = inp, n = 0;
    while (el && el.parentElement) {
      el = el.parentElement;
      if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop = 0; n++; }
    }
    return n;
  });
  const advance = () => page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const trs = Array.from(document.querySelectorAll('tr.ecom-g-table-row')).filter(vis);
    if (!trs.length) return false;
    let moved = false, el = trs[trs.length - 1];
    while (el && el.parentElement) {
      el = el.parentElement;
      if (el.scrollHeight > el.clientHeight + 10) {
        const b = el.scrollTop;
        el.scrollTop = Math.min(b + 320, el.scrollHeight - el.clientHeight);
        if (el.scrollTop !== b) moved = true;
      }
    }
    return moved;
  });
  const scan = () => page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const out = [];
    for (const tr of Array.from(document.querySelectorAll('tr.ecom-g-table-row')).filter(vis)) {
      const ci = Array.from(tr.querySelectorAll('input[placeholder="请输入erp编码"]'))[0];
      if (!ci) continue;
      const code = String(ci.value || '').trim();
      if (!code) continue;
      const pi = Array.from(tr.querySelectorAll('input[placeholder="请输入"]')).filter((i) => /number/.test(i.className))[0];
      const si = Array.from(tr.querySelectorAll('input[placeholder="请输入库存"]'))[0];
      const price = pi ? String(pi.value || '').trim() : '';
      const stock = si ? String(si.value || '').trim() : '';
      if (price && stock && stock !== '0') continue;
      out.push({ code, price, stock, needPrice: !price, needStock: !stock || stock === '0' });
    }
    return out;
  });
  /** 用原生 setter + input/change + blur 写入（React 受控输入必须这样，直接赋值不进 state） */
  const writeCell = (payload) => page.evaluate((a) => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (const tr of Array.from(document.querySelectorAll('tr.ecom-g-table-row')).filter(vis)) {
      const ci = Array.from(tr.querySelectorAll('input[placeholder="请输入erp编码"]'))[0];
      if (!ci || String(ci.value || '').trim() !== a.code) continue;
      const put = (inp, v) => {
        if (!inp) return false;
        inp.focus();
        setter.call(inp, String(v));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.blur();
        return true;
      };
      const pi = Array.from(tr.querySelectorAll('input[placeholder="请输入"]')).filter((i) => /number/.test(i.className))[0];
      const si = Array.from(tr.querySelectorAll('input[placeholder="请输入库存"]'))[0];
      const didPrice = a.needPrice ? put(pi, a.price) : false;
      const didStock = a.needStock ? put(si, a.stock) : false;
      return { ok: true, didPrice, didStock };
    }
    return { ok: false, reason: 'row_not_found' };
  }, payload);

  const filled = [], unresolved = [], seen = new Set();
  await resetScroll();
  await sleep(900);
  // ★ 必须在**同一个窗口里**扫到就立刻写：虚拟表只渲染可见行，
  //   先滚完再回头写的话，那一行早就不在 DOM 里了（实测报 row_not_found）。
  for (let i = 0; i < maxRounds; i++) {
    await sleep(450);
    for (const h of await scan()) {
      if (seen.has(h.code)) continue;
      seen.add(h.code);
      const cands = byCode.get(h.code) || [];
      if (cands.length !== 1) {
        unresolved.push({ code: h.code, reason: cands.length ? 'code_ambiguous:' + cands.length : 'code_not_in_product_json' });
        continue;
      }
      const s = cands[0];
      const wrote = await writeCell({ code: h.code, price: s.price, stock: s.stock, needPrice: h.needPrice, needStock: h.needStock });
      await sleep(600);
      const back = await page.evaluate((wantCode) => {
        const vis = (el) => !!(el && el.offsetParent !== null);
        for (const tr of Array.from(document.querySelectorAll('tr.ecom-g-table-row')).filter(vis)) {
          const ci = Array.from(tr.querySelectorAll('input[placeholder="请输入erp编码"]'))[0];
          if (!ci || String(ci.value || '').trim() !== wantCode) continue;
          const pi = Array.from(tr.querySelectorAll('input[placeholder="请输入"]')).filter((x) => /number/.test(x.className))[0];
          const si = Array.from(tr.querySelectorAll('input[placeholder="请输入库存"]'))[0];
          return { price: pi ? String(pi.value || '').trim() : null, stock: si ? String(si.value || '').trim() : null };
        }
        return null;
      }, h.code);
      const ok = back && back.price === String(s.price) && back.stock === String(s.stock);
      (ok ? filled : unresolved).push({ code: h.code, want: { price: s.price, stock: s.stock }, got: back, wrote: wrote });
    }
    if (!(await advance())) break;
  }
  return { found: seen.size, filled, unresolved, ok: unresolved.length === 0 };
}

/** 单选/复选：按可见文本点（发货模式 / 发货时间 / 库存计数 / 商品状态 / 售后政策等） */
async function setRadioByText(page, text) {
  const r = await page.evaluate((label) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const rd = Array.from(document.querySelectorAll('input[type=radio]')).filter(vis).find((r) => {
      let p = r.parentElement;
      for (let k = 0; k < 3 && p; k++) { if (clean(p.innerText).includes(label)) return true; p = p.parentElement; }
      return false;
    });
    if (!rd) return { ok: false, reason: 'radio_not_found' };
    if (rd.checked) return { ok: true, already: true };
    const lbl = rd.closest('label') || rd.parentElement;
    (lbl || rd).click();
    return { ok: true, clicked: label };
  }, text);
  await sleep(700);
  return r;
}

async function readRadioChecked(page, text) {
  return page.evaluate((label) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const rd = Array.from(document.querySelectorAll('input[type=radio]')).filter(vis).find((r) => {
      let p = r.parentElement;
      for (let k = 0; k < 3 && p; k++) { if (clean(p.innerText).includes(label)) return true; p = p.parentElement; }
      return false;
    });
    return rd ? rd.checked : null;
  }, text);
}

/**
 * 规格值是否已挂图——**只能当参考**，不能当幂等依据。
 * 教训（2026-09-30）：早先按「页面上有 60-120px 方图」判断，结果被
 * 「规格预览 / SKU 预览图」列的缩略图骗到，空白页也报「已挂图」→ 规格图根本没传。
 * 现在改为：看 `input[placeholder^="请输入规格类型"]` 所在行（上溯 4 层）里有没有 img。
 * 幂等主依据仍是**状态文件**（见 uploadSpecImages 的 stateFile）。
 */
async function readSpecImageState(page) {
  // 只作**信息性**报告：数「真实的素材图」（24-130px 方图，排除 1x1 透明占位与 358px 规格预览）
  return page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const real = Array.from(document.querySelectorAll('img')).filter((im) => {
      if (!vis(im)) return false;
      const b = im.getBoundingClientRect();
      const w = Math.round(b.width), h = Math.round(b.height);
      if (w < 24 || w > 130 || Math.abs(w - h) > 8) return false;
      const src = im.src || '';
      if (src.length < 200 && /^data:image/.test(src)) return false;   // 1x1 透明占位
      return /ecombdimg|shop-material|tplv-/.test(src);
    });
    return { specImageThumbs: real.length };
  });
}

/**
 * 读 SKU 表（虚拟滚动：一次只能看到十几行，取当前窗口）。
 * 抖店 SKU 行的三个关键输入框 placeholder：
 *   价格 → "请输入"（且 class 含 number）
 *   库存 → "请输入库存"
 *   编码 → "请输入erp编码"
 */
async function readSkuTable(page) {
  return page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const prices = Array.from(document.querySelectorAll('input[placeholder="请输入"]'))
      .filter((i) => vis(i) && /number/.test(i.className))
      .map((i) => String(i.value || '').trim());
    const stocks = Array.from(document.querySelectorAll('input[placeholder="请输入库存"]'))
      .filter(vis).map((i) => String(i.value || '').trim());
    const codes = Array.from(document.querySelectorAll('input[placeholder="请输入erp编码"]'))
      .filter(vis).map((i) => String(i.value || '').trim());
    const barcodes = Array.from(document.querySelectorAll('input[placeholder="请输入条形码"]'))
      .filter(vis).map((i) => String(i.value || '').trim());
    const specVals = Array.from(document.querySelectorAll('input[placeholder^="请输入规格类型"]'))
      .filter(vis).map((i) => ({ ph: i.placeholder, v: String(i.value || '').trim() })).filter((x) => x.v);
    const priceProgress = (clean(document.body.innerText).match(/价格填写进度\s*(\d+)%/) || [])[1];
    return { prices, stocks, codes, barcodes, specValues: specVals, priceProgress: priceProgress ? Number(priceProgress) : null };
  });
}

/**
 * 用 product.json 校验 SKU 表当前窗口的值是否都对得上。
 * 只比「集合包含 + 数量一致」，因为虚拟滚动看不到全量。
 */
/**
 * 跨窗口读**全量** SKU 行（虚拟滚动：先归零所有可滚祖先，再自上而下逐窗口取并集）。
 *
 * 为什么必须这样读：`readSkuTable` 只读**当前可见的十几行**。百来行里有没有空值、
 * 编码有没有写错，靠单窗口快照永远看不全 —— 实测 MZB-007 的 72 行里漏了 1 行价格，
 * 而可见窗口全是好的，连「填写检查」都判过。
 *
 * ⚠️ 两个坑（都实测过）：
 *  1. 表格滚到底后**不会自己回顶**，所以必须先 RESET 再往下推，否则从中间开始扫会漏行。
 *  2. 规格值管理区的「值行」也用 `tr.ecom-g-table-row`，但没有价格/库存输入框 →
 *     必须按「有没有价格/库存输入框」过滤，只认真正的 SKU 行。
 */
async function scanSkuTableFull(page, { maxRounds = 120, stableRounds = 6 } = {}) {
  const read = () => page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const trs = Array.from(document.querySelectorAll('tr.ecom-g-table-row')).filter(vis)
      .filter((tr) => tr.querySelector('input[placeholder="请输入库存"]') || tr.querySelector('input[placeholder="请输入erp编码"]'));
    const g = (tr, ph) => {
      const i = Array.from(tr.querySelectorAll('input[placeholder="' + ph + '"]'))[0];
      return i ? String(i.value || '').trim() : null;
    };
    return trs.map((tr) => {
      const pi = Array.from(tr.querySelectorAll('input[placeholder="请输入"]')).filter((i) => /number/.test(i.className))[0];
      return {
        code: g(tr, '请输入erp编码'),
        stock: g(tr, '请输入库存'),
        price: pi ? String(pi.value || '').trim() : null,
        text: clean(tr.innerText).slice(0, 40),
      };
    });
  });
  const reset = () => page.evaluate(() => {
    const inp = document.querySelector('input[placeholder="请输入erp编码"]') || document.querySelector('tr.ecom-g-table-row');
    let el = inp, n = 0;
    while (el && el.parentElement) {
      el = el.parentElement;
      if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop = 0; n++; }
    }
    return n;
  });
  const advance = () => page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const trs = Array.from(document.querySelectorAll('tr.ecom-g-table-row')).filter(vis);
    if (!trs.length) return false;
    let moved = false, el = trs[trs.length - 1];
    while (el && el.parentElement) {
      el = el.parentElement;
      if (el.scrollHeight > el.clientHeight + 10) {
        const b = el.scrollTop;
        el.scrollTop = Math.min(b + 320, el.scrollHeight - el.clientHeight);
        if (el.scrollTop !== b) moved = true;
      }
    }
    return moved;
  });

  const byCode = new Map();   // 有编码：code → row（含 <empty> 前缀的占位行）
  const holey = new Map();    // 无编码：缺价格/库存的行
  const allRows = [];
  await reset();
  await sleep(900);
  let stagnant = 0;
  for (let round = 0; round < maxRounds; round++) {
    for (let w = 0; w < 8; w++) {   // 滚动后行是分步渲染的：先出文本、后入 input
      await sleep(350);
      const probe = await read();
      if (probe.filter((r) => r.code).length >= Math.max(4, probe.length - 2)) break;
    }
    const rows = await read();
    const before = byCode.size + holey.size;
    for (const r of rows) {
      allRows.push(r);
      const k = r.code || ('<empty>' + r.text);
      if (!byCode.has(k)) byCode.set(k, r);
      if (!r.price || !r.stock) holey.set(r.text + '|' + r.price + '|' + r.stock, r);
    }
    const moved = await advance();
    if (!moved) break;
    stagnant = (byCode.size + holey.size) > before ? 0 : stagnant + 1;
    if (stagnant >= stableRounds) break;
  }
  return { byCode, holey, scanned: allRows.length };
}

async function checkSkuTable(page, product, { full = true } = {}) {
  const wantPrices = new Set(product.skus.map((s) => String(s.price)));
  const wantStocks = new Set(product.skus.map((s) => String(s.stock)));
  // 商家编码在抖店是**选填**，源素材包里可能是空的（实测 GPE-002：整列空）。
  // 那种情况下「编码为空」不是错误 → 只有 product.json 里确实有编码时才校验它。
  const wantCodes = new Set(product.skus.map((s) => String(s.code || '')).filter(Boolean));
  const requireCode = wantCodes.size > 0;

  // 默认**全表**（不再只看可见窗口）：验收要一轮到位，不靠事后另开扫描补证。
  const full_ = full ? await scanSkuTableFull(page) : null;
  const t = full_ ? null : await readSkuTable(page);
  const rows = full_ ? [...full_.byCode.values()] : null;
  const visible = full_ ? rows.filter((r) => r.code && !r.code.startsWith('__none__')) : null;

  const codes = full_ ? [...full_.byCode.keys()].filter((c) => !c.startsWith('<empty>')) : (t ? t.codes : []);
  const prices = full_ ? rows.map((r) => r.price).filter((v) => v !== null) : t.prices;
  const stocks = full_ ? rows.map((r) => r.stock).filter((v) => v !== null) : t.stocks;
  const codeList = full_ ? rows.filter((r) => r.code).map((r) => r.code) : t.codes;

  const bad = {
    price: prices.filter((v) => v && !wantPrices.has(v)),
    stock: stocks.filter((v) => v && !wantStocks.has(v)),
    code: requireCode ? codeList.filter((v) => v && !wantCodes.has(v)) : [],
  };
  const empty = {
    price: prices.filter((v) => !v).length,
    stock: stocks.filter((v) => !v).length,
    code: requireCode ? codeList.filter((v) => !v).length : 0,
  };
  const countsAligned = prices.length === stocks.length && (!requireCode || stocks.length === codeList.length);
  const missing = full_ && requireCode ? [...wantCodes].filter((c) => !full_.byCode.has(c)) : [];

  // 无编码时无法逐行定位（行 DOM 只渲染最后一个规格维度）→ 改核对**规格值集合**，
  // 并按下式等价校验行数：各维度唯一值数之积 == SKU 数。
  let specValues = null;
  if (!requireCode) {
    try {
      const groups = await readSpecImageGroup(page);
      const byDim = {};
      for (const s of product.skus) {
        for (const d of product.dimensions || []) (byDim[d] = byDim[d] || new Set()).add(String(s[d]));
      }
      specValues = groups.map((g) => {
        const expect = new Set([...(byDim[g.label] || [])]);
        const got = new Set(g.values);
        const same = expect.size === got.size && [...expect].every((v) => got.has(v));
        return { dim: g.label, expected: expect.size, got: got.size, ok: same };
      });
      const prod = groups.reduce((a, g) => a * new Set(g.values).size, 1);
      specValues.rowsMatch = prod === product.skus.length;
    } catch (_) { specValues = null; }
  }

  const ok = !bad.price.length && !bad.stock.length && !bad.code.length
    && !empty.price && !empty.stock && !empty.code
    && (!requireCode || !missing.length)
    && countsAligned && prices.length > 0
    && (requireCode ? (!full_ || codes.length > 0) : (full_.holey.size === 0 && (!specValues || (specValues.every((s) => s.ok) && specValues.rowsMatch))));

  return {
    ok, full: !!full_, scanned: full_ ? full_.scanned : null,
    counts: { price: prices.length, stock: stocks.length, code: codeList.length },
    countsAligned, requireCode, empty, unexpected: bad, missing,
    holey: full_ ? full_.holey.size : null,
    priceProgress: full_ ? null : t.priceProgress,
    specValues, expectSkus: product.skus.length,
  };
}

/**
 * 读「带规格图的那一组规格」= 页面规则里的「第一组规格」。
 *
 * ⚠️ 两个坑都实测过：
 *  1. 哪一组算「第一组」由平台的**智能填写助手**决定，跑与跑之间会互换
 *     （ZDT-002：一次颜色组带图、下一次尺码组带图）；而「添加规格图」开关对非第一组是禁用的
 *     （点了 aria-checked 不变），只能靠**移动顺序**纠正。
 *  2. 组名**不是固定的**「规格类型1/2」：猫抓板类目里助手把两组命名成「颜色」「规格」，
 *     于是按 `/^规格类型\d$/` 找组头会一个都找不到（实测 4 轮全挂在 no_group_with_image_switch）。
 *
 * → 所以判据全部改成**结构性**的、与名字无关的：
 *    · 组头行 = 含叶子文本「添加规格图」的那一行（往上走到同时含「上移/下移」的容器）
 *    · 组名 = 该行里的 `.ecom-g-select-selection-item`（如「颜色」「规格」）
 *    · **带图组 = 组头行里含「批量上传规格图」的那一组**（只有它才有这个入口，实测成立）
 *    · 组的值 = placeholder 为「请输入<组名>」的输入框（组名动态，所以不能写死）
 * 返回 [{label, on, values}]，按页面上的先后顺序。
 */
async function readSpecImageGroup(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const heads = [];
    const labels = Array.from(document.querySelectorAll('*'))
      .filter((e) => vis(e) && e.children.length === 0 && clean(e.innerText) === '添加规格图');
    for (const lab of labels) {
      let row = lab;
      for (let k = 0; k < 6 && row.parentElement; k++) {
        row = row.parentElement;
        if (/上移|下移/.test(clean(row.innerText))) break;
      }
      const nameEl = Array.from(row.querySelectorAll('.ecom-g-select-selection-item')).filter(vis)[0];
      const name = nameEl ? clean(nameEl.innerText) : '';
      if (!name || heads.some((h) => h.label === name)) continue;
      heads.push({ label: name, on: /批量上传规格图/.test(clean(row.innerText)),
                   y: Math.round(row.getBoundingClientRect().y), values: [] });
    }
    heads.sort((a, b) => a.y - b.y);
    // 组的值：placeholder 是「请输入<组名>」（组名动态）
    for (const inp of Array.from(document.querySelectorAll('input'))) {
      if (!vis(inp)) continue;
      const ph = String(inp.placeholder || '');
      const v = String(inp.value || '').trim();
      if (!v || !ph.startsWith('请输入')) continue;
      const g = heads.find((h) => h.label === ph.replace(/^请输入/, ''));
      if (g && !g.values.includes(v)) g.values.push(v);
    }
    return heads;
  });
}

/**
 * 把某个规格组上移到第一位（点「上移」→ 平台弹窗点「确定」）。
 *
 * 平台弹窗原文：「仅第一组规格支持添加规格图片，若确认移动该规格项顺序，原规格图片将被清空，需重新上传」
 * —— 所以必须**在传规格图之前**调顺序。
 * 「上移」控件的定位：它和组头在同一视觉行（实测 y 差 < 46px），按 y 匹配最稳
 * （class 是 CSS Modules 哈希，text 精确匹配后仍可能命中多个）。
 * 注：必须 Playwright **真实点击** —— 原生 el.click() 也会弹窗但不生效。
 */
async function moveSpecGroupUp(page, label) {
  const info = await page.evaluate((lab) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    // 组名不是固定的「规格类型N」→ 从「添加规格图」标签所在行里取 `.ecom-g-select-selection-item`
    const headers = [];
    for (const l of Array.from(document.querySelectorAll('*')).filter((e) => vis(e) && e.children.length === 0 && clean(e.innerText) === '添加规格图')) {
      let row = l;
      for (let k = 0; k < 6 && row.parentElement; k++) {
        row = row.parentElement;
        if (/上移|下移/.test(clean(row.innerText))) break;
      }
      const nameEl = Array.from(row.querySelectorAll('.ecom-g-select-selection-item')).filter(vis)[0];
      const name = nameEl ? clean(nameEl.innerText) : '';
      if (name && !headers.some((h) => h.name === name)) {
        headers.push({ name, y: Math.round(row.getBoundingClientRect().y) });
      }
    }
    const me = headers.find((h) => h.name === lab);
    if (!me) return { ok: false, reason: 'group_header_not_found', headers };
    const ups = Array.from(document.querySelectorAll('[class*=style_item]'))
      .filter((e) => vis(e) && clean(e.innerText) === '上移')
      .map((e) => ({ y: Math.round(e.getBoundingClientRect().y), disabled: /disabled/.test(String(e.className)) }));
    const mine = ups.filter((u) => Math.abs(u.y - me.y) < 46);
    if (!mine.length) return { ok: false, reason: 'up_not_found', headers, ups };
    if (mine[0].disabled) return { ok: false, reason: 'up_disabled' };
    return { ok: true, y: mine[0].y, headers };
  }, label);
  if (!info.ok) return info;
  const loc = page.getByText('上移', { exact: true });
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const b = await loc.nth(i).boundingBox().catch(() => null);
    if (!b || Math.abs(b.y - info.y) > 6) continue;
    await loc.nth(i).click({ timeout: 10000 });
    await sleep(1200);
    const modal = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const vis = (el) => !!(el && el.offsetParent !== null);
      const m = Array.from(document.querySelectorAll('.ecom-g-modal-root')).filter(vis)[0];
      if (!m) return { shown: false };
      const b = Array.from(m.querySelectorAll('button')).filter(vis).find((x) => clean(x.innerText) === '确定');
      if (!b) return { shown: true, confirmed: false };
      b.click();
      return { shown: true, confirmed: true, text: clean(m.innerText).slice(0, 80) };
    });
    await sleep(3000);
    return { ok: true, modal };
  }
  return { ok: false, reason: 'up_locator_not_found', y: info.y, n };
}

/**
 * 保证「带规格图的那一组」就是 `wantedValues` 所属的那一组。
 * 平台把能力绑在**显示第一位**的组上，而哪一组在第一位由智能填写助手的异步创建顺序决定（会变），
 * 所以先验；不对就把我们那一组上移（平台弹窗明确说了移动会清空原图 → 必须在传图前做）。
 */
async function ensureSpecImageGroup(page, wantedValues) {
  const wanted = new Set(wantedValues);
  let groups = await readSpecImageGroup(page);
  let on = groups.find((g) => g.on);
  if (!on) return { ok: false, reason: 'no_group_with_image_switch', groups };
  if (on.values.some((v) => wanted.has(v))) return { ok: true, already: true, groups };

  const target = groups.find((g) => g.values.some((v) => wanted.has(v)));
  if (!target) return { ok: false, reason: 'spec_image_group_not_found', groups };

  for (let attempt = 0; attempt < 3; attempt++) {
    const moved = await moveSpecGroupUp(page, target.label);
    if (!moved.ok) return { ok: false, reason: 'move_failed:' + moved.reason, groups, moved };
    groups = await readSpecImageGroup(page);
    on = groups.find((g) => g.on);
    if (on && on.values.some((v) => wanted.has(v))) return { ok: true, moved: true, attempt: attempt + 1, groups };
    if (!groups.length || groups[0].label === target.label) {
      return { ok: false, reason: 'move_no_effect', groups, moved };
    }
  }
  return { ok: false, reason: 'move_insufficient', groups };
}

/**
 * 规格图：批量上传 → 抽屉逐行指定规格值 → 确定。
 * @param {Array<{file:string, specValues:string[]}>} pairs 顺序 = 上传顺序 = 行序
 *   一行可挂**多个**规格值：抽屉的规格值下拉是多选，所以「10 张图对 30 个颜色值」
 *   只要 10 行、每行选 3 个值即可。（旧的 {file, specValue:string} 写法仍兼容）
 *
 * 实测坑（首轮 10 行只有 1 行对，其余缺值/串行）：
 *   抽屉里每个行的下拉是 portal 到 body 的，**没有** per-行 id（trigger 的 aria-controls
 *   指向的 id 在页面里取不到）。上一行残留的下拉会让 `.ecom-g-select-dropdown` 出现两个，
 *   取「第一个可见的」就会把值点进**隔壁行**（实测第 5 行的「深蓝色-5片」落到第 4 行）。
 *   → 所以每行赋值前先清干净，赋值时要求「可见下拉有且只有 1 个」且「本行 trigger 的
 *     aria-expanded === 'true'」，把整行点选放在**同一个 evaluate 内**完成（弹层引用稳定）。
 */
async function uploadSpecImages(page, pairs, { timeoutMs = 180000, force = false, stateFile = null } = {}) {
  pairs = (pairs || []).map((p) => ({
    file: p.file,
    specValues: (p.specValues || (p.specValue ? [p.specValue] : [])).map(String).filter(Boolean),
  })).filter((p) => p.file && p.specValues.length);
  // 幂等主依据：状态文件（DOM 判据不可靠，见 readSpecImageState 注释）
  const sig = JSON.stringify(pairs.map((p) => [p.specValues, path.basename(p.file)]));
  if (!force && stateFile && fs.existsSync(stateFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (prev.signature === sig) {
        const st = await readSpecImageState(page);
        return { ok: true, skipped: true, reason: 'state_file_match', ...st };
      }
    } catch (_) {}
  }
  // ★ 出图维度校验 + 自动纠正：
  //   抽屉的规格值下拉只列「第一组规格」的值，而哪一组是第一组由平台的智能填写助手决定（跑与跑之间会换）。
  //   不先验就开抽屉的话所有行都会 value_not_found，连点 3 轮、耗时翻倍，最后点「确定」还会把草稿弄脏
  //   （实测：另一组凭空多出「有图但值为空」的幻影行，价格填写进度 100% → 28%）。
  //   平台的弹窗原文确认「仅第一组规格支持添加规格图片，若确认移动该规格项顺序，原规格图片将被清空」，
  //   所以这里直接**把出图那一组上移到第一位**（在传图之前做，清空无损失），而不是换个草稿重跑。
  let groupInfo = null;
  try {
    const ensure = await ensureSpecImageGroup(page, pairs.flatMap((p) => p.specValues));
    if (!ensure.ok) {
      return {
        ok: false, reason: 'spec_image_group_mismatch', confirmed: false, drawerConfirmed: false,
        group: (ensure.groups || []).find((g) => g.on)?.label || null,
        groupValues: ((ensure.groups || []).find((g) => g.on)?.values || []).slice(0, 6),
        hint: '规格图能力不在我们出图的那一组上，且自动上移没成功（'
            + ensure.reason + '）。可以重开草稿重跑（大概率换回另一边）。',
        groups: (ensure.groups || []).map((g) => ({ label: g.label, on: g.on, n: (g.values || []).length })),
      };
    }
    const on = (ensure.groups || []).find((g) => g.on);
    groupInfo = on ? { group: on.label, n: on.values.length, moved: !!ensure.moved } : null;
  } catch (_) {}

  const idx = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const all = Array.from(document.querySelectorAll('input[type=file]'));
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el.multiple || !/image/.test(el.accept || '')) continue;
      let p = el.parentElement;
      for (let k = 0; k < 4 && p; k++) { if (/批量上传规格图/.test(clean(p.innerText))) return i; p = p.parentElement; }
    }
    return -1;
  });
  if (idx < 0) return { ok: false, reason: 'batch_spec_image_input_not_found' };
  await page.locator('input[type=file]').nth(idx).setInputFiles(pairs.map((p) => p.file), { timeout: timeoutMs });
  await sleep(6000);

  let rows = 0;
  for (let i = 0; i < 10; i++) {
    rows = await page.evaluate(() => {
      const vis = (el) => !!(el && el.offsetParent !== null);
      const drawer = Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter(vis)[0];
      if (!drawer) return 0;
      const imgRows = Array.from(drawer.querySelectorAll('tr')).filter((tr) => tr.querySelector('img')).length;
      const selRows = Array.from(drawer.querySelectorAll('tr')).filter((tr) => tr.querySelector('input.ecom-g-select-selection-search-input')).length;
      return Math.max(imgRows, selRows);
    });
    if (rows > 0) break;
    await sleep(1500);
  }
  if (!rows) return { ok: false, reason: 'drawer_rows_not_found' };

  const openDropdownCount = () => page.evaluate(() => Array.from(document.querySelectorAll('.ecom-g-select-dropdown')).filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).length);

  /** 清掉所有残留下拉（上一行的弹层会让「唯一可见」断言失效）。
   *  ⚠️ 用「点抽屉内部空白」而不是 Escape：Escape 有时会连**抽屉**一起关掉，
   *  于是后续行全都 openRow 失败（实测：第 1 行成功、2-9 行 `clicked:false`，
   *  带着半残赋值点了「确定」→ 6 处「请上传规格图」+ 价格进度掉到 76%）。 */
  const closeDropdowns = async () => {
    for (let k = 0; k < 3; k++) {
      if ((await openDropdownCount()) === 0) return true;
      await page.evaluate(() => {
        const vis = (el) => !!(el && el.offsetParent !== null);
        const drawer = Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter(vis)[0];
        if (!drawer) return;
        const spot = drawer.querySelector('th') || drawer.querySelector('[class*=drawer-header]') || drawer;
        spot.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        spot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        spot.click();
      }).catch(() => {});
      await sleep(400);
    }
    if ((await openDropdownCount()) === 0) return true;
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await sleep(400);
    return (await openDropdownCount()) === 0;
  };

  const drawerAlive = () => page.evaluate(() =>
    !!Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter((el) => el.offsetParent !== null)[0]);

  // ★ 按「图片行序」定位：赋值后该行的 select 结构可能变化，
  //   用「含 select 的行」当下标会漂移（实测只有第 1 行成功、其余全 got:""）。
  //   图片是上传时固定的，按 img 出现顺序取行最稳。
  const openRow = (ri) => page.evaluate((r) => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const drawer = Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter(vis)[0];
    if (!drawer) return { ok: false, reason: 'drawer_not_found' };
    const imgRows = Array.from(drawer.querySelectorAll('tr')).filter((tr) => tr.querySelector('img'));
    const tr = imgRows[r] || Array.from(drawer.querySelectorAll('tr'))[r + 1];
    if (!tr) return { ok: false, reason: 'row_not_found', n: imgRows.length };
    const inp = tr.querySelector('input.ecom-g-select-selection-search-input');
    if (!inp) return { ok: false, reason: 'row_no_select', n: imgRows.length };
    if (inp.getAttribute('aria-expanded') === 'true') return { ok: true, already: true };
    inp.click();
    inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return { ok: true };
  }, ri);

  /**
   * 在**本行自己**的下拉里点选全部目标值。
   * 断言：可见下拉恰好 1 个 + 本行 trigger aria-expanded=true；整行点选在一个 evaluate 内完成。
   */
  const pickRowValues = (ri, wants) => page.evaluate(async ({ r, wants: ws }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const boxVis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const vis = (el) => { if (!el || el.offsetParent === null) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const drawer = Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter((el) => el.offsetParent !== null)[0];
    if (!drawer) return { ok: false, reason: 'drawer_not_found' };
    const imgRows = Array.from(drawer.querySelectorAll('tr')).filter((tr) => tr.querySelector('img'));
    const tr = imgRows[r] || Array.from(drawer.querySelectorAll('tr'))[r + 1];
    if (!tr) return { ok: false, reason: 'row_not_found' };
    const trg = tr.querySelector('input.ecom-g-select-selection-search-input');
    if (!trg) return { ok: false, reason: 'row_no_select' };
    const boxes = Array.from(document.querySelectorAll('.ecom-g-select-dropdown')).filter(boxVis);
    if (boxes.length !== 1) return { ok: false, reason: 'ambiguous_dropdown', n: boxes.length };
    if (trg.getAttribute('aria-expanded') !== 'true') return { ok: false, reason: 'row_dropdown_not_open' };
    const box = boxes[0];
    const tryClick = (v) => {
      const items = Array.from(box.querySelectorAll('*'))
        .filter((e) => e.children.length === 0 && clean(e.innerText) === v)
        .filter(vis);
      if (!items.length) return null;
      items[0].click();
      return clean(items[0].innerText);
    };
    const picked = [];
    for (const v of ws) {
      let hit = tryClick(v);
      if (!hit) {
        const cands = Array.from(box.querySelectorAll('*'))
          .filter((e) => e.scrollHeight > e.clientHeight + 10)
          .sort((x, y) => (y.scrollHeight - y.clientHeight) - (x.scrollHeight - x.clientHeight));
        const sc = cands[0];
        if (sc) {
          const stepPx = Math.max(60, Math.floor((sc.clientHeight || 200) / 2));
          for (let st = 0; st <= (sc.scrollHeight || 0) + stepPx && !hit; st += stepPx) {
            sc.scrollTop = st;
            await wait(140);
            hit = tryClick(v);
          }
          sc.scrollTop = 0;
        }
      }
      picked.push({ v, ok: !!hit });
      if (!hit) break;
      await wait(280);
    }
    return { ok: picked.every((p) => p.ok), picked };
  }, { r: ri, wants });

  // 读回该行**全部**已选规格值（多选 → 多个 selection-item）
  const readRowValues = (ri) => page.evaluate((r) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const drawer = Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter(vis)[0];
    if (!drawer) return null;
    const imgRows = Array.from(drawer.querySelectorAll('tr')).filter((tr) => tr.querySelector('img'));
    const tr = imgRows[r] || Array.from(drawer.querySelectorAll('tr'))[r + 1];
    if (!tr) return null;
    return Array.from(tr.querySelectorAll('[class*=selection-item],[class*=SelectionItem]'))
      .filter((e) => !/remove/i.test(String(e.className || '')))
      .map((e) => clean(e.innerText)).filter(Boolean);
  }, ri);

  const assign = [];
  const result = [];
  const n = Math.min(pairs.length, rows);
  for (let i = 0; i < n; i++) result.push(null);

  for (let pass = 0; pass < 3; pass++) {
    const todo = [];
    for (let i = 0; i < n; i++) if (!result[i] || !result[i].ok) todo.push(i);
    if (!todo.length) break;
    if (pass > 0) await sleep(800);
    for (const i of todo) {
      if (!(await drawerAlive())) {
        result[i] = { i, ok: false, reason: 'drawer_closed_midway' };
        for (let j = i + 1; j < n; j++) if (!result[j]) result[j] = { j, ok: false, reason: 'drawer_closed_midway' };
        break;
      }
      const wants = pairs[i].specValues;
      await closeDropdowns();
      const opened = await openRow(i);
      if (!opened.ok) { result[i] = { i, ok: false, reason: opened.reason }; continue; }
      await sleep(opened.already ? 250 : 900);
      const pk = await pickRowValues(i, wants);
      try { await page.keyboard.press('Escape'); } catch (_) {}
      await sleep(600);
      const got = await readRowValues(i);
      const wantSet = [...new Set(wants)].sort();
      const gotSet = [...new Set(got || [])].sort();
      const same = wantSet.length === gotSet.length && wantSet.every((v, k) => v === gotSet[k]);
      result[i] = { i, specValues: wantSet, ok: !!pk.ok && same, got: gotSet, want: wantSet,
                    clickedAny: !!(pk.picked || []).some((p) => p.ok),
                    reason: pk.ok ? undefined : pk.reason,
                    missed: pk.ok ? undefined : (pk.picked || []).filter((p) => !p.ok).map((p) => p.v) };
    }
  }
  result.forEach((r2, i) => { if (r2) assign.push(r2); else assign.push({ i, ok: false, reason: 'not_attempted' }); });

  // ★ 硬保险：**没全部成功就绝不点「确定」**。点「确定」= 把「图片→规格值」的映射落到 SKU 表上；
  //   只落一部分会造出「有图但值为空/少值」的幻影行，价格填写进度整表垮掉（实测 100% → 76% / 28%）。
  //   宁可失败重来，也不要把草稿弄脏。
  const notOk = assign.filter((a) => !a.ok);
  if (notOk.length) {
    try { await page.keyboard.press('Escape'); } catch (_) {}
    const afterNo = await readSpecImageState(page);
    return {
      ok: false,
      reason: notOk.every((a) => !a.clickedAny) ? 'spec_values_not_clickable_in_drawer'
                                                : 'incomplete_spec_image_assignment',
      rows, assign, confirmed: false, drawerConfirmed: false, groupInfo, ...afterNo,
    };
  }

  const confirmed = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const drawer = Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter(vis)[0];
    if (!drawer) return { ok: false, reason: 'drawer_not_found' };
    const b = Array.from(drawer.querySelectorAll('button')).find((x) => clean(x.innerText) === '确定');
    if (!b) return { ok: false, reason: 'confirm_not_found' };
    b.click();
    return { ok: true };
  });
  await sleep(4000);
  const closed = await page.evaluate(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    return !Array.from(document.querySelectorAll('[class*=drawer-content-wrapper]')).filter(vis)[0];
  });
  const after = await readSpecImageState(page);
  const ok = assign.every((a) => a.ok) && confirmed.ok;
  if (ok && stateFile) {
    try { fs.writeFileSync(stateFile, JSON.stringify({ signature: sig, at: new Date().toISOString() }, null, 1)); } catch (_) {}
  }
  return { ok, rows, assign, confirmed: confirmed.ok, drawerClosed: closed, groupInfo, ...after };
}

// ---------- 校验 ----------

/** 必填项进度 / 报错 / 填写检查 */
async function runFillCheck(page) {
  const clicked = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const b = Array.from(document.querySelectorAll('button')).filter(vis).find((x) => clean(x.innerText) === '填写检查');
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(4000);
  return { clicked, ...(await readFormState(page)) };
}

async function readFormState(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const t = clean(document.body.innerText);
    const progress = (t.match(/必填项进度\s*(\d+)%/) || [])[1];
    const title = (() => {
      const el = Array.from(document.querySelectorAll('input')).find((i) => {
        const ph = i.placeholder || '';
        return /个字符/.test(ph) && /汉字/.test(ph);
      });
      return el ? el.value : null;
    })();
    const category = (() => {
      const m = t.match(/商品类目\s*([^\n]{0,50})/);
      return m ? m[1].split('修改')[0].trim() : null;
    })();
    const detail = (t.match(/商详图片[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]/) || []);
    const errs = Array.from(document.querySelectorAll('[class*=error],[class*=Error]')).filter(vis).map((e) => clean(e.innerText)).filter(Boolean).slice(0, 10);
    const pendingAttrs = (t.match(/请选择/g) || []).length;
    // 平台自己的「还有什么空着」信号：重要属性 x/y · 其他属性 x/y（分类属性区）。
    // 用它来**挑重点**问用户 —— 光把模板里 34 个空着的选填属性全甩过去没人看得完（门禁 47）。
    const imp = t.match(/重要属性\s*(\d+)\s*\/\s*(\d+)/);
    const oth = t.match(/其他属性\s*(\d+)\s*\/\s*(\d+)/);
    const attrProgress = (imp || oth)
      ? { important: imp ? `${imp[1]}/${imp[2]}` : null, other: oth ? `${oth[1]}/${oth[2]}` : null }
      : null;
    return {
      title, category,
      requiredProgress: progress ? Number(progress) : null,
      detailUploaded: detail[1] ? Number(detail[1]) : null,
      detailTotal: detail[2] ? Number(detail[2]) : null,
      errs, pendingSelectCount: pendingAttrs, attrProgress,
    };
  });
}

module.exports = {
  CREATE_URL, LIST_URL,
  resolvePlaywrightCore, playwrightSource, probePort, closeHungTabs, connectShop, disconnectPage, openCreatePage, sleep, dismissOverlays,
  gotoCreate, detectStep, setTitle, waitForCategorySection, uploadMainImages, selectCategory, clickNext,
  ATTR_LABELS, openAttr, pickAttr, searchAndPickAttr, readAttr, fillTextAttr, fillAttributes, addAttrOption,
  uploadDetailImages, readDetailCounter,
  uploadSpecExcel, fillMissingSkuCells, setRadioByText, readRadioChecked, uploadSpecImages, readSpecImageState, readSpecImageGroup,
  moveSpecGroupUp, ensureSpecImageGroup,
  readSkuTable, scanSkuTableFull, checkSkuTable,
  runFillCheck, readFormState,
};
