/**
 * help-reference-test.js — 回归测试：桌面右上角"？"规则速查按钮 + 页签弹窗
 *
 * 场景：
 *  1. 进入四人局后，对局桌面存在右上角 #btn-help（"？"）按钮。
 *  2. 点击后 #modal-help 打开（只读工具，不占操作权）。
 *  3. 默认停在「番数查询」页签（#help-pane-han 可见，#help-pane-fu 隐藏），役种内容非空。
 *  4. 点「符数查询」页签 → 切到 #help-pane-fu，番数页隐藏；含关键符数规则文字（如 门前/底符、暗刻、切上）。
 *  5. 切回「番数查询」页签 → 番数页再次可见。
 *  6. 点弹窗关闭按钮（.close-x）→ 弹窗关闭。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node help-reference-test.js
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const rulesCode = fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8');
  const storageCode = fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

  window.eval(rulesCode);
  window.eval(storageCode);
  const { document } = window;
  window.eval(appCode);
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // 进入四人局以触发 bindMainPage 对按钮的绑定
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();

  // 1. 按钮存在
  const helpBtn = document.getElementById('btn-help');
  assert(!!helpBtn, '存在右上角规则速查按钮 #btn-help');

  // 2. 点击打开弹窗
  const modal = document.getElementById('modal-help');
  assert(!!modal, '存在 #modal-help 弹窗结构');
  assert(modal.classList.contains('show') === false, '初始弹窗未打开');
  helpBtn.click();
  assert(modal.classList.contains('show'), '点击"？"后弹窗打开');

  // 3. 默认停在番数页签
  const tabHan = document.getElementById('help-tab-han');
  const tabFu = document.getElementById('help-tab-fu');
  const paneHan = document.getElementById('help-pane-han');
  const paneFu = document.getElementById('help-pane-fu');
  assert(tabHan.classList.contains('active'), '默认激活「番数查询」页签');
  assert(tabFu.classList.contains('active') === false, '「符数查询」页签初始未激活');
  assert(paneHan.style.display !== 'none', '番数页签内容可见');
  assert(paneFu.style.display === 'none', '符数页签内容初始隐藏');

  // 番数内容非空（含关键役种文字）
  const hanText = paneHan.textContent;
  assert(hanText.indexOf('立直') >= 0 && hanText.indexOf('役满') >= 0, '番数页含立直与役满分组的役种内容');

  // 4. 切到符数查询
  tabFu.click();
  assert(tabFu.classList.contains('active'), '点击后「符数查询」页签激活');
  assert(tabHan.classList.contains('active') === false, '「番数查询」页签取消激活');
  assert(paneFu.style.display !== 'none', '符数页签内容可见');
  assert(paneHan.style.display === 'none', '番数页签内容隐藏');
  const fuText = paneFu.textContent;
  assert(fuText.indexOf('门清') >= 0 && fuText.indexOf('暗刻') >= 0 && fuText.indexOf('切上') >= 0,
    '符数页含门清底符/刻子/切上等规则要点');

  // 5. 切回番数查询
  tabHan.click();
  assert(tabHan.classList.contains('active'), '切回后「番数查询」页签激活');
  assert(paneHan.style.display !== 'none', '番数页签内容再次可见');
  assert(paneFu.style.display === 'none', '符数页签内容再次隐藏');

  // 6. 关闭弹窗
  const closeX = modal.querySelector('.close-x');
  assert(!!closeX, '弹窗存在关闭按钮 .close-x');
  closeX.click();
  assert(modal.classList.contains('show') === false, '点击关闭按钮后弹窗关闭');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
