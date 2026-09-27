/**
 * view-lock-test.js — 回归测试：桌面"视角锁定"（选择自己→整桌旋转使其固定在下方位）
 *
 * 场景：
 *  1. 四人建局默认各槽位 class 唯一（未锁定时行为与原一致：物理 seat 东/南/西/北 → east/south/west/north）。
 *  2. 点左上角 #btn-view 打开弹窗（纯本机工具）。
 *  3. 选某名玩家并点"锁定" → 该玩家所在 .seat 具 class seat-south(下方)，且四槽位各出现一次（整桌旋转）。
 *  4. 锁定后该座位带 .you-mark"我"。
 *  5. 再次打开弹窗 → 显示"解除锁定"按钮；点击解除 → 恢复初始槽位。
 *  6. 换局/重进主界面后锁定持续（半庄内有效）。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node view-lock-test.js
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

  function seatElOf(name) {
    return Array.from(document.querySelectorAll('#table-seats .seat'))
      .find((s) => s.querySelector('.name') && s.querySelector('.name').textContent === name);
  }
  function slotOf(name) {
    const cls = seatElOf(name) ? seatElOf(name).className : '';
    const m = cls.match(/seat-(east|south|west|north)/);
    return m ? m[1] : null;
  }
  function slotAll() {
    return Array.from(document.querySelectorAll('#table-seats .seat'))
      .map((s) => ((s.className.match(/seat-(east|south|west|north)/) || [])[1] || null));
  }
  function assertFourUnique(label) {
    const slots = slotAll();
    assert(slots.length === 4, label + ': 渲染4个座位');
    const set = new Set(slots);
    ['east', 'south', 'west', 'north'].forEach((c) => assert(set.has(c), label + ': 含槽位 seat-' + c));
    assert(slots.length === set.size, label + ': 四个槽位各出现一次（无重叠/缺位）');
  }

  console.log('\n== 视角按钮与弹窗存在 ==\n');
  assert(!!document.getElementById('btn-view'), '桌面存在视角切换按钮 #btn-view');
  assert(!!document.getElementById('modal-view'), '存在视角锁定弹窗 #modal-view');
  assert(!!document.getElementById('view-pick'), '弹窗存在玩家选择列表 #view-pick');
  assert(!!document.getElementById('btn-view-lock'), '弹窗存在"锁定"按钮');
  assert(!!document.getElementById('btn-view-unlock'), '弹窗存在"解除锁定"按钮');
  assert(!document.getElementById('btn-view-close'), '不再有内嵌"关闭"按钮(顶部×已提供关闭)');
  const lockBtn = document.getElementById('btn-view-lock');
  assert(lockBtn && lockBtn.parentElement.classList.contains('view-actions'), '"锁定"按钮在 .view-actions 容器内');
  assert(lockBtn.parentElement.querySelectorAll('button').length === 2, '弹窗底部仅 2 个动作按钮(锁定/解除锁定)');

  // 回归保护：弹窗底栏两个按钮必须强制同高（防止 v2/v3 类的渲染差异回归）。
  // 锁死显式 height + flex 居中规则，与 padding/border-bottom 渲染差异解耦。
  const cssText = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  // 抽取 .modal-view .view-actions .btn { ... } 整个规则体（只到下一个右花括号）
  const btnRuleMatch = cssText.match(/\.modal-view \.view-actions \.btn\s*\{([\s\S]*?)\}/);
  assert(!!btnRuleMatch, '.modal-view .view-actions .btn 的 CSS 规则存在且结构完整');
  const btnBody = btnRuleMatch ? btnRuleMatch[1] : '';
  assert(/height:\s*50px/.test(btnBody), '.modal-view .view-actions .btn 规则体内显式 height:50px 锁死按钮等高');
  assert(/display:\s*flex/.test(btnBody), '.modal-view .view-actions .btn 规则体内 display:flex');
  assert(/align-items:\s*center/.test(btnBody), '.modal-view .view-actions .btn 规则体内 align-items:center');
  assert(/justify-content:\s*center/.test(btnBody), '.modal-view .view-actions .btn 规则体内 justify-content:center');

  console.log('\n== 建四人局 ==\n');
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  const inputs = document.querySelectorAll('.setup-name');
  assert(inputs.length === 4, '四人模式有4个座位输入框');
  inputs.forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '进入对局主界面');

  console.log('\n== 未锁定：默认物理方位定位 ==\n');
  assertFourUnique('未锁定');
  assert(slotOf('P东') === 'east', '未锁定 P东 在左(east)槽位');
  assert(slotOf('P南') === 'south', '未锁定 P南 在下(south)槽位');
  assert(slotOf('P西') === 'west', '未锁定 P西 在右(west)槽位');
  assert(slotOf('P北') === 'north', '未锁定 P北 在上(north)槽位');

  console.log('\n== 打开视角弹窗（纯本机工具） ==\n');
  document.getElementById('btn-view').click();
  assert(document.getElementById('modal-view').classList.contains('show'), '点 #btn-view 打开视角弹窗');
  const pickItems = document.querySelectorAll('#view-pick .p');
  assert(pickItems.length === 4, '弹窗列出4名玩家');
  assert(document.getElementById('btn-view-unlock').style.display === 'none', '未锁定时"解除锁定"按钮隐藏');

  console.log('\n== 锁定 P东（物理东/默认左）→ 整桌旋转使其到下方位 ==\n');
  const pickEast = Array.from(pickItems).find((el) => el.querySelector('.name').textContent === 'P东');
  assert(!!pickEast, '选择项中存在 P东');
  pickEast.click();
  assert(pickEast.classList.contains('selected'), '点击 P东 后该项高亮选中');
  document.getElementById('btn-view-lock').click();
  assert(!document.getElementById('modal-view').classList.contains('show'), '锁定后弹窗关闭');

  assertFourUnique('锁定 P东 后');
  assert(slotOf('P东') === 'south', '锁定 P东 → P东 显示在下(south)槽位');
  const eastEl = seatElOf('P东');
  assert(!!eastEl.querySelector('.you-mark'), '锁定玩家的座位带"我"标记');
  assert(eastEl.querySelector('.you-mark').textContent === '我', '"我"标记文字为 我');

  console.log('\n== 换局/重进主界面后锁定持续 ==\n');
  document.getElementById('btn-back-main').click();
  document.getElementById('btn-continue-game').click();
  assert(slotOf('P东') === 'south', '返回并重新进入后 P东 仍在下(south)——半庄内锁定持续');

  console.log('\n== 再开弹窗 → 可解除锁定 ==\n');
  document.getElementById('btn-view').click();
  assert(document.getElementById('btn-view-unlock').style.display !== 'none', '已锁定时显示"解除锁定"按钮');
  document.getElementById('btn-view-unlock').click();
  assert(!document.getElementById('modal-view').classList.contains('show'), '解除锁定后弹窗关闭');
  assertFourUnique('解除后');
  assert(slotOf('P东') === 'east', '解除后 P东 回到左(east)槽位');
  assert(slotOf('P南') === 'south', '解除后 P南 回到下(south)槽位');

  console.log('\n== 锁定 P北（物理北/默认上）→ 到下方 ==\n');
  document.getElementById('btn-view').click();
  const pickNorth = Array.from(document.querySelectorAll('#view-pick .p')).find((el) => el.querySelector('.name').textContent === 'P北');
  pickNorth.click();
  document.getElementById('btn-view-lock').click();
  assert(slotOf('P北') === 'south', '锁定 P北 → P北 显示在下(south)');
  assertFourUnique('锁 P北');

  console.log('\n== 通过顶部×关闭弹窗：不做任何锁定（视图不变） ==\n');
  const before = slotAll().join(',');
  document.getElementById('btn-view').click();
  // 弹窗顶部的 × 关闭按钮（不再有内嵌"关闭"按钮）
  document.querySelector('#modal-view .close-x').click();
  assert(!document.getElementById('modal-view').classList.contains('show'), '点顶部×后弹窗关闭');
  const after = slotAll().join(',');
  assert(before === after, '关闭后桌面槽位不变（未发生锁定）');

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
