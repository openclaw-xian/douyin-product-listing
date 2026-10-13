// 抖店发布页属性填充原型（GPVC-001 验证用）
// 用法：node dy_attrs.js   （环境变量 PDD_FLOW_JS / RECON_OUT）
const path = require("path");
const flow = require(process.env.PDD_FLOW_JS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 在页面内找到属性控件容器并把下拉点开。
 * 抖店属性控件的稳定特征：标签叶子 → 上溯第 5 层就是 form item。
 */
async function openAttr(page, label) {
  const r = await page.evaluate((name) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const leaf = Array.from(document.querySelectorAll("label,span,div")).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      const t = clean(el.innerText);
      return t === name || t === "* " + name || t === "*" + name;
    })[0];
    if (!leaf) return { ok: false, reason: "label_not_found" };
    let item = leaf.parentElement, k = 0;
    for (; k < 6 && item; k++) {
      if (item.querySelector("input.ecom-g-select-selection-search-input")) break;
      item = item.parentElement;
    }
    if (!item) return { ok: false, reason: "container_not_found" };
    const sel = item.querySelector("input.ecom-g-select-selection-search-input");
    if (!sel) return { ok: false, reason: "no_select_input", k };
    sel.click();
    sel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return { ok: true, k };
  }, label);
  await sleep(900);
  return r;
}

/** 读当前展开的下拉选项（锁定 auto-dropdown-id-<label>） */
async function readAttrOptions(page, label) {
  return page.evaluate((name) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const box = document.querySelector(".ecom-g-select-dropdown.auto-dropdown-id-" + CSS.escape(name));
    if (!box) return { ok: false, reason: "dropdown_not_found" };
    const items = Array.from(box.querySelectorAll('[class*=select-item],[class*=SelectItem],[role=option],li'))
      .map((el) => clean(el.innerText))
      .filter((t) => t && t.length < 40 && t !== "+新建" + name);
    return { ok: true, items: [...new Set(items)] };
  }, label);
}

/** 选中某个属性值（原生 click，绕过浮层拦截）。多选自动走 multi 分支。 */
async function pickAttr(page, label, value) {
  const r = await page.evaluate((a) => {
    const { label: name, value } = a;
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const pickIn = (box) => {
      const items = Array.from(box.querySelectorAll('[class*=select-item],[class*=SelectItem],[role=option],li,span,div'))
        .filter((el) => el.children.length === 0 && clean(el.innerText) === value);
      if (!items.length) return null;
      items[0].click();
      return clean(items[0].innerText);
    };
    // 1) 单选：auto-dropdown-id-<属性名>
    const single = document.querySelector(".ecom-g-select-dropdown.auto-dropdown-id-" + CSS.escape(name));
    if (single) {
      const hit = pickIn(single);
      if (hit) return { ok: true, clicked: hit, kind: "single" };
      return { ok: false, reason: "value_not_in_options", kind: "single",
        sample: Array.from(single.querySelectorAll('[class*=select-item],li')).slice(0, 12).map((e) => clean(e.innerText)) };
    }
    // 2) 多选：styles_multiSelectDropdown（无 per-属性 id，同一时刻只开一个）
    const multi = Array.from(document.querySelectorAll('[class*=multiSelectDropdown]')).filter(vis)[0];
    if (multi) {
      const hit = pickIn(multi);
      if (hit) return { ok: true, clicked: hit, kind: "multi" };
      return { ok: false, reason: "value_not_in_options", kind: "multi",
        sample: Array.from(multi.querySelectorAll("span,div")).filter((e) => e.children.length === 0)
          .map((e) => clean(e.innerText)).filter(Boolean).slice(0, 20) };
    }
    return { ok: false, reason: "dropdown_not_found" };
  }, { label, value });
  await sleep(700);
  return r;
}

/** 关闭仍展开的下拉（多选点完通常不自动关） */
async function closeDropdown(page) {
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll(".ecom-g-select-dropdown")).filter((e) => e.offsetParent)[0];
    if (el) el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body.click();
  }).catch(() => {});
  await sleep(400);
}

/** 读回该属性当前选中值 */
async function readAttrValue(page, label) {
  return page.evaluate((name) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const leaf = Array.from(document.querySelectorAll("label,span,div")).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      const t = clean(el.innerText);
      return t === name || t === "* " + name || t === "*" + name;
    })[0];
    if (!leaf) return null;
    let item = leaf.parentElement;
    for (let k = 0; k < 6 && item; k++) {
      const sel = item.querySelector('[class*=selection-item],[class*=SelectionItem]');
      if (sel && clean(sel.innerText)) return clean(sel.innerText);
      item = item.parentElement;
    }
    return "";
  }, label);
}

/** 填文本类属性（厚度 / 每卷长度(m) / 每卷宽度(m) / 上市时间） */
async function fillTextAttr(page, label, value) {
  return page.evaluate((a) => {
    const { label: name, value } = a;
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const leaf = Array.from(document.querySelectorAll("label,span,div")).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      const t = clean(el.innerText);
      return t === name || t === "* " + name || t === "*" + name;
    })[0];
    if (!leaf) return { ok: false, reason: "label_not_found" };
    let item = leaf.parentElement;
    for (let k = 0; k < 6 && item; k++) {
      const inp = Array.from(item.querySelectorAll("input.ecom-g-input")).filter(vis)[0];
      if (inp) {
        setter.call(inp, String(value));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.dispatchEvent(new Event("blur", { bubbles: true }));
        return { ok: true, now: inp.value };
      }
      item = item.parentElement;
    }
    return { ok: false, reason: "input_not_found" };
  }, { label, value });
}

/** 选中单选/多选（按可见文本精确点） */
async function pickByText(page, text, { multi = false } = {}) {
  return page.evaluate((a) => {
    const { text, multi } = a;
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const vis = (el) => !!(el && el.offsetParent !== null);
    const leaves = Array.from(document.querySelectorAll("label,span,div,button")).filter((el) => {
      if (!vis(el) || el.children.length) return false;
      return clean(el.innerText) === text;
    });
    if (!leaves.length) return { ok: false, reason: "text_not_found", n: 0 };
    // 优先点最靠近含 radio/checkbox 的祖先
    for (const leaf of leaves) {
      let p = leaf;
      for (let k = 0; k < 4 && p; k++) {
        if (p.querySelector && p.querySelector('input[type=radio],input[type=checkbox]')) {
          const inp = p.querySelector('input[type=radio],input[type=checkbox]');
          leaf.click();
          return { ok: true, how: inp.type, n: leaves.length };
        }
        p = p.parentElement;
      }
    }
    leaves[0].click();
    return { ok: true, how: "fallback_leaf", n: leaves.length };
  }, { text, multi });
}

module.exports = { openAttr, readAttrOptions, pickAttr, readAttrValue, fillTextAttr, pickByText, closeDropdown, sleep };
