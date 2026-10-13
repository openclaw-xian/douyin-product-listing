#!/usr/bin/env node
/**
 * 「参考价」开关：读状态 / 可逆拨动 / 强制归位。
 *
 * 墙纸类目表单里「参考价」行 = `[attr-field-id="参考价"]`，里面**只有一个 `button.ecom-g-switch`**
 * （`role="switch"`、`dropdownclassname="auto-dropdown-id-参考价"`），**默认关、无 ★**。
 * 拨开后行结构会整体变样（这就是上一版用「文本=参考价 + 含 switch」选择器失效的原因）。
 *
 * 用法：
 *   NODE_PATH=%USERPROFILE%\node_modules node tests/reveal_reference_price.js [端口] [--toggle|--off|--on]
 *
 * 默认（不带参数）= 只读。**不点发布、不点保存草稿。**
 */
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const PORT = args.find((a) => /^\d+$/.test(a)) || process.env.DY_PORT || '9228';
const MODE = (args.find((a) => a.startsWith('--')) || '--read').replace('--', '');
const FIELD = process.env.DY_REF_FIELD || '参考价';

function getJSON(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path, timeout: 8000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = (field) => `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const row = document.querySelector('[attr-field-id="' + ${JSON.stringify(field)} + '"]');
  if (!row) return { found: false };
  const sw = row.querySelector('button.ecom-g-switch');
  const lines = document.body.innerText.split('\\n').map(clean);
  return {
    found: true,
    hasStar: !!row.querySelector('[class*=required]') || /(^|\\s)\\*(?=\\S)/.test(clean(row.innerText).slice(0, 8)),
    switchAria: sw ? sw.getAttribute('aria-checked') : null,
    switchAttrs: sw ? { role: sw.getAttribute('role'), dropdownclassname: sw.getAttribute('dropdownclassname'), placeholder: sw.getAttribute('placeholder') } : null,
    inputs: Array.from(row.querySelectorAll('input, textarea, [class*=select-selection-item]')).map((e) => ({
      tag: e.tagName.toLowerCase(), type: e.getAttribute('type'), placeholder: e.getAttribute('placeholder'),
      value: 'value' in e ? e.value : null, text: clean(e.innerText) || null, disabled: !!e.disabled,
    })),
    requiredProgress: (clean(document.body.innerText).match(/必填项进度\\s*(\\d+)%/) || [])[1] || null,
    refLines: lines.filter((l) => /参考价|凭证|吊牌|零售价|市场价/.test(l)),
    rowHTML: row.outerHTML.slice(0, 2600),
  };
})()`;

const CLICK_SWITCH = (field) => `(() => {
  const row = document.querySelector('[attr-field-id="' + ${JSON.stringify(field)} + '"]');
  if (!row) return { ok: false, why: 'row not found' };
  const sw = row.querySelector('button.ecom-g-switch');
  if (!sw) return { ok: false, why: 'switch not found' };
  sw.click();
  return { ok: true, before: sw.getAttribute('aria-checked') };
})()`;

(async () => {
  // playwright-core 走技能统一的解析入口（DY_PLAYWRIGHT → 技能自带 tools/npm → 机器级），
  // 这样换机器/没设 NODE_PATH 也能跑（见 scripts/pwresolver.js）
  const { chromium } = require(path.join(__dirname, '..', 'scripts', 'pwresolver.js')).playwright();
  const list = await getJSON('/json/list');
  if (!list.some((t) => /fxg\.jinritemai\.com\/ffa\/g\/create/.test(t.url || ''))) {
    console.error('没有抖店创建页'); process.exit(2);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (!/fxg\.jinritemai\.com\/ffa\/g\/create/.test(page.url())) continue;
        const before = await page.evaluate(READ(FIELD));
        console.log('=== 当前（' + MODE + '）===');
        console.log(JSON.stringify(before, null, 2));
        if (!before.found) break;

        const want = MODE === 'on' ? 'true' : MODE === 'off' ? 'false' : null;
        if (want && before.switchAria !== want) {
          console.log('\n-> 拨动开关:', JSON.stringify(await page.evaluate(CLICK_SWITCH(FIELD))));
          await SLEEP(1500);
          const after = await page.evaluate(READ(FIELD));
          console.log('=== 拨动后 ===');
          console.log(JSON.stringify(after, null, 2));
        } else if (MODE === 'toggle') {
          console.log('\n-> 拨动开关:', JSON.stringify(await page.evaluate(CLICK_SWITCH(FIELD))));
          await SLEEP(1500);
          console.log('=== 拨动后 ===');
          const after = await page.evaluate(READ(FIELD));
          console.log(JSON.stringify(after, null, 2));
          console.log('\n-> 拨回:', JSON.stringify(await page.evaluate(CLICK_SWITCH(FIELD))));
          await SLEEP(1500);
          const back = await page.evaluate(READ(FIELD));
          console.log('=== 拨回后 ===');
          console.log(JSON.stringify({ switchAria: back.switchAria, requiredProgress: back.requiredProgress }, null, 2));
        } else {
          console.log('\n（只读，未拨动）');
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
