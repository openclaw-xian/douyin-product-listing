#!/usr/bin/env node
/**
 * 打印 playwright-core 的解析来源（preflight / selftest 用）。
 *
 * 输出 JSON 一行：
 *   {"ok":true,"how":"技能自带 tools/npm","spec":"C:\\...\\tools\\npm\\node_modules\\playwright-core"}
 *   {"ok":false,"error":"..."}
 * 用法：node scripts/which_pw.js
 */
const path = require('path');
const { resolvePlaywrightCore } = require(path.join(__dirname, 'pwresolver.js'));
try {
  const r = resolvePlaywrightCore();
  console.log(JSON.stringify({ ok: true, how: r.how, spec: r.spec }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message.split('\n')[0] }));
  process.exit(1);
}
