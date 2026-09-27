/**
 * multiron-settle-test.js — 回归测试：一炮多响(荣和)结算放铳者唯一性
 * 场景：四人局开启"允许一炮多响"。玩家东(a)一炮点响南(b)与西(c)两位和牌者。
 *   - 第1笔：付分人=东，收分人=南
 *   - 点"还有"后：不允许再重选付分人(放铳者固定为东)，只能继续选和牌者(收分人)
 *   - 收分候选必须排除：放铳者东、已收分的南
 *   - 第2笔：收分人=西；第3笔候选只剩北
 * 运行：NODE_PATH=<workspace>/node_modules node multiron-settle-test.js
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
function pickText(sel, text) {
  return Array.from(document.querySelectorAll(sel)).find((p) => p.textContent.includes(text));
}

let document, window;

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  window = dom.window;
  document = window.document;
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  window.localStorage.removeItem('riichi_active_game');

  console.log('\n== 建四人局并开启一炮多响 ==\n');
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'Q' + inp.dataset.wind; });
  document.getElementById('switch-multiron').classList.add('on');
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '进入对局主界面');

  console.log('\n== 第1笔荣和：付分人东→收分人南 ==\n');
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  assert(document.getElementById('modal-settle-pay').classList.contains('show'), '进入选付分人界面');
  pickText('#pay-pick .p', 'Q东').click();
  assert(document.getElementById('modal-settle-recv').classList.contains('show'), '进入选收分人界面');
  pickText('#recv-pick .p', 'Q南').click();
  document.getElementById('settle-amount').value = '2000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-settle-more').classList.contains('show'), '第一笔录入后弹出"是否还有其它和牌者"');
  assert(document.getElementById('modal-result').classList.contains('show') === false, '尚未最终结算(无结果弹窗)');

  console.log('\n== 点"还有"：应固定放铳者，只选下一位和牌者 ==\n');
  document.getElementById('btn-settle-more-yes').click();
  assert(document.getElementById('modal-settle-pay').classList.contains('show') === false, '不再打开"选付分人"界面(放铳者固定为东，不可重选)');
  assert(document.getElementById('modal-settle-recv').classList.contains('show'), '直接进入"选下一位和牌者(收分人)"界面');
  assert(document.getElementById('recv-hint').textContent.includes('Q东'), '收分提示标明放铳者为东');
  // 收分候选应只含 西、北（排除付分人东与已收分南）
  const cand1 = Array.from(document.querySelectorAll('#recv-pick .p')).map((p) => p.textContent);
  assert(cand1.length === 2, '第2笔收分候选应为2人(西、北)，实际: ' + cand1.join('/'));
  assert(!cand1.some((t) => t.includes('Q东')), '候选不含放铳者东');
  assert(!cand1.some((t) => t.includes('Q南')), '候选不含已收分的南');

  console.log('\n== 第2笔：收分人西 ==\n');
  pickText('#recv-pick .p', 'Q西').click();
  document.getElementById('settle-amount').value = '1000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-settle-more').classList.contains('show'), '第2笔后又询问还有无其它和牌者');
  assert(document.getElementById('settle-queue-count').textContent.includes('2 位和牌者收分'), '提示已有2位和牌者收分: ' + document.getElementById('settle-queue-count').textContent);

  console.log('\n== 点"还有"：此刻只剩北未收分 ==\n');
  document.getElementById('btn-settle-more-yes').click();
  assert(document.getElementById('modal-settle-pay').classList.contains('show') === false, '再次确认不打开选付分人界面');
  const cand2 = Array.from(document.querySelectorAll('#recv-pick .p')).map((p) => p.textContent);
  assert(cand2.length === 1 && cand2[0].includes('Q北'), '第3笔收分候选只剩北，实际: ' + cand2.join('/'));

  console.log('\n== 完成本局结算 ==\n');
  // 选北完成第3笔
  pickText('#recv-pick .p', 'Q北').click();
  document.getElementById('settle-amount').value = '1000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-settle-more').classList.contains('show'), '第3笔后询问');
  // 第4次"还有"应无候选(东=付分人，南/西/北均已收分)
  document.getElementById('btn-settle-more-yes').click();
  assert(document.getElementById('modal-settle-recv').classList.contains('show') === false, '已无其它可收分和牌者，不再进入选人界面');
  assert(document.getElementById('modal-settle-more').classList.contains('show'), '保持在询问框，等待用户点"没有"完成');
  document.getElementById('btn-settle-more-done').click();
  assert(document.getElementById('modal-result').classList.contains('show'), '结算完成显示结果弹窗');

  // 校验：放铳者东一人承担全部 -4000，南/西/北各 +2000/+1000/+1000
  console.log('\n== 分数校验(总分守恒) ==\n');
  const nameTo = {};
  Array.from(document.querySelectorAll('.setup-name')).forEach(() => {}); // noop
  // 直接从当前对局玩家取分
  const rp = Array.from(document.querySelectorAll('#result-players .list-item'));
  const net = {};
  rp.forEach((it) => {
    const txt = it.textContent.replace(/\s+/g, ' '); // 归一空白/换行
    const m = txt.match(/(Q[东南西北])：(\d+)点 \(([+-]?\d+)\)/);
    if (m) net[m[1]] = parseInt(m[3], 10);
  });
  assert(net['Q东'] === -4000, '放铳者东净付4000，实际 ' + net['Q东']);
  assert(net['Q南'] === +2000, '南收2000，实际 ' + net['Q南']);
  assert(net['Q西'] === +1000, '西收1000，实际 ' + net['Q西']);
  assert(net['Q北'] === +1000, '北收1000，实际 ' + net['Q北']);
  const sum = Object.values(net).reduce((a, b) => a + b, 0);
  assert(sum === 0, '总分数守恒(=0)，实际 ' + sum);

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main();
