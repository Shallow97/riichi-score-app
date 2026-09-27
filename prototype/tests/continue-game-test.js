/**
 * continue-game-test.js — 回归测试：验证"继续进行中的对局"按钮
 * 场景：开始对局后点左上角"返回"回到模式选择页，此时应能通过"继续当前对局"按钮回到对局。
 * 运行：NODE_PATH=<workspace>/node_modules node continue-game-test.js
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

  const btn = document.getElementById('btn-continue-game');
  assert(!!btn, '模式页存在"继续当前对局"按钮元素');

  console.log('\n== 无对局时按钮应隐藏 ==\n');
  assert(btn.style.display === 'none', '初始无对局时继续按钮隐藏');
  assert(document.getElementById('page-mode').classList.contains('active'), '默认显示模式选择页');

  console.log('\n== 建局进入主界面 ==\n');
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  const inputs = document.querySelectorAll('.setup-name');
  inputs.forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '建局后进入对局主界面');

  console.log('\n== 点左上角"返回"回模式选择页 ==\n');
  document.getElementById('btn-back-main').click();
  assert(document.getElementById('page-mode').classList.contains('active'), '点击返回后回到模式选择页');

  console.log('\n== 有进行中对局时应显示继续按钮 ==\n');
  assert(btn.style.display !== 'none', '回到模式页后有活跃对局 → 继续按钮显示');

  console.log('\n== 点击"继续当前对局"应回到对局 ==\n');
  btn.click();
  assert(document.getElementById('page-main').classList.contains('active'), '点击继续按钮后回到对局主界面');
  // 对局数据应完整保留（回到桌面即证明 game 未丢）
  const seats = document.querySelectorAll('#table-seats .seat');
  assert(seats.length === 4, '回到对局后仍渲染4个座位');
  const pts = Array.from(document.querySelectorAll('#table-seats .pts')).map((e) => e.textContent);
  assert(pts.every((p) => p === '25000'), '四人初始分数25000仍在');

  console.log('\n== 反复返回仍可继续（无对局不被清空） ==\n');
  document.getElementById('btn-back-main').click();
  assert(document.getElementById('page-mode').classList.contains('active'), '再次返回模式选择页');
  assert(btn.style.display !== 'none', '对局仍活跃 → 继续按钮仍显示');
  btn.click();
  assert(document.getElementById('page-main').classList.contains('active'), '再次点击继续可回对局');

  console.log('\n== 新对局清空后按钮应重新隐藏 ==\n');
  document.getElementById('btn-back-main').click();
  document.getElementById('btn-new-game').click();
  document.getElementById('btn-confirm-ok').click(); // 确认放弃当前对局
  assert(document.getElementById('page-mode').classList.contains('active'), '新对局确认后回模式选择页');
  assert(btn.style.display === 'none', '放弃对局后继续按钮隐藏');

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main();
