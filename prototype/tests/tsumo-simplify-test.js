/**
 * tsumo-simplify-test.js — 自摸结算简化流程专项测试
 * 覆盖：自摸者=庄家(单输入自动复制到各闲家) / 自摸者=闲家(子+亲两值自动分配)
 *       取消不入账（×关闭填额弹窗）/ 「确认结算」直接入账（无核对明细步骤）后各家分数正确
 * 运行：NODE_PATH=<workspace>/node_modules node tsumo-simplify-test.js
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

// 读取分数表：座名 → 当前分
function readPts(document) {
  const out = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    out[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  return out;
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  function build4pGame() {
    document.getElementById('mode-4').click();
    document.getElementById('btn-next-setup').click();
    document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
    document.getElementById('btn-create-game').click();
  }

  console.log('\n== 场景A：四人局 庄家(P东)自摸 —— 单输入自动复制到3闲家 ==\n');
  build4pGame();
  assert(document.getElementById('page-main').classList.contains('active'), '建局成功进入主界面');
  const preA = readPts(document);
  // 开局进自摸，选庄家 P东（players[0]）
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-tsumo').click();
  Array.from(document.querySelectorAll('#tsumo-pick .p')).find((p) => p.textContent.includes('P东')).click();
  assert(document.getElementById('modal-tsumo-amounts').classList.contains('show'), '选自摸者后进入应付额输入层');
  assert(document.querySelectorAll('.tsumo-shared').length === 1, '庄家自摸只出现一个"每位闲家应付"输入框');
  assert(document.querySelectorAll('.tsumo-koha').length === 0 && document.querySelectorAll('.tsumo-oya').length === 0,
    '庄家自摸不出现闲家/庄家双输入框');
  document.querySelector('.tsumo-shared').value = '1000';
  // 取消：点 × 关闭填额弹窗，不入账
  document.getElementById('modal-tsumo-amounts').querySelector('.close-x').click();
  assert(document.getElementById('modal-result').classList.contains('show') === false, '取消后不进入结算结果');
  const midA = readPts(document);
  assert(JSON.stringify(preA) === JSON.stringify(midA), '取消后各家分数不变');

  // 重新走一遍并点「确认结算」直接入账（核对明细步骤已移除）
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-tsumo').click();
  Array.from(document.querySelectorAll('#tsumo-pick .p')).find((p) => p.textContent.includes('P东')).click();
  document.querySelector('.tsumo-shared').value = '1000';
  document.getElementById('btn-tsumo-confirm').click();
  assert(document.getElementById('modal-tsumo-review') === null, '核对明细弹窗已从DOM移除');
  assert(document.getElementById('modal-result').classList.contains('show'), '点"确认结算"直接进入结算结果弹窗');
  const postA = readPts(document);
  assert(postA['P东'] - midA['P东'] === 3000, '庄家自摸者P东收3闲家各1000 → +3000，实得 ' + (postA['P东']-midA['P东']));
  ['P南', 'P西', 'P北'].forEach((w) => {
    assert(postA[w] - midA[w] === -1000, '闲家 ' + w + ' 各付1000，实得 ' + (postA[w]-midA[w]));
  });
  document.getElementById('btn-result-close').click();

  // 开新局测闲家自摸
  console.log('\n== 场景B：四人局 闲家(P南)自摸 —— 子/亲两值自动分配 ==\n');
  document.getElementById('btn-new-game').click();
  document.getElementById('btn-confirm-ok').click();
  assert(document.getElementById('page-mode').classList.contains('active'), '开新局回到模式选择页');
  build4pGame();
  const preB = readPts(document);
  // 新局庄仍是 P东(players[0])。选闲家 P南 自摸。
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-tsumo').click();
  Array.from(document.querySelectorAll('#tsumo-pick .p')).find((p) => p.textContent.includes('P南')).click();
  assert(document.getElementById('modal-tsumo-amounts').classList.contains('show'), '选自摸者(P南闲家)后进入输入层');
  assert(document.querySelectorAll('.tsumo-shared').length === 0, '闲家自摸不出现单个"每位闲家应付"框');
  assert(document.querySelectorAll('.tsumo-koha').length === 1 && document.querySelectorAll('.tsumo-oya').length === 1,
    '闲家自摸出现"每位闲家(子)应付"与"庄家(亲)应付"两个输入框');
  // koha 应用到另两闲家(西、北)；oya 应用到庄家(东)
  const kohaEl = document.querySelector('.tsumo-koha');
  const oyaEl = document.querySelector('.tsumo-oya');
  const kohaPayers = kohaEl.dataset.payers.split(',');
  assert(kohaPayers.length === 2 && !kohaPayers.includes('P东') && !kohaPayers.includes('P南'),
    '子应付复制对象=其余2闲家(西、北)，实得 ' + kohaPayers.join(','));
  assert(oyaEl.dataset.payers === 'P东', '亲应付只作用于庄家P东，实得 ' + oyaEl.dataset.payers);
  kohaEl.value = '1000';
  oyaEl.value = '2000';
  document.getElementById('btn-tsumo-confirm').click();
  assert(document.getElementById('modal-result').classList.contains('show'), '闲家自摸点"确认结算"直接进入结算结果');
  const postB = readPts(document);
  assert(postB['P南'] - preB['P南'] === 4000, '闲家自摸者P南收1000+1000+2000=4000，实得 ' + (postB['P南']-preB['P南']));
  assert(postB['P东'] - preB['P东'] === -2000, '庄家P东付亲额2000，实得 ' + (postB['P东']-preB['P东']));
  ['P西', 'P北'].forEach((w) => {
    assert(postB[w] - preB[w] === -1000, '闲家 ' + w + ' 各付子额1000，实得 ' + (postB[w]-preB[w]));
  });

  // 三人局：闲家自摸 —— 缺北，只有1个闲家付子额，另庄家付亲额（自摸损场景）
  console.log('\n== 场景C：三人局 闲家(P南)自摸 —— 缺北只1闲家付子额 + 庄付亲额 ==\n');
  document.getElementById('btn-new-game').click();
  document.getElementById('btn-confirm-ok').click();
  function build3pGame() {
    document.getElementById('mode-3').click();
    document.getElementById('btn-next-setup').click();
    document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
    document.getElementById('btn-create-game').click();
  }
  build3pGame();
  const preC = readPts(document);
  // 三人局庄=P东。选闲家 P南 自摸。
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-tsumo').click();
  Array.from(document.querySelectorAll('#tsumo-pick .p')).find((p) => p.textContent.includes('P南')).click();
  const kohaC = document.querySelector('.tsumo-koha');
  assert(!!kohaC && !!document.querySelector('.tsumo-oya'), '三人闲家自摸出现子+亲两个输入框');
  assert(kohaC.dataset.payers === 'P西', '三人局闲家自摸：子应付只作用唯一闲家P西(自摸损)，实得 ' + kohaC.dataset.payers);
  document.querySelector('.tsumo-oya').value = '2000';
  kohaC.value = '1000';
  document.getElementById('btn-tsumo-confirm').click();
  assert(document.getElementById('modal-result').classList.contains('show'), '三人闲家自摸点"确认结算"直接进入结算结果');
  const postC = readPts(document);
  assert(postC['P南'] - preC['P南'] === 3000, '三人闲家自摸P南收1000+2000=3000(自摸损收更少)，实得 ' + (postC['P南']-preC['P南']));
  assert(postC['P东'] - preC['P东'] === -2000, '三人庄家P东付亲额2000，实得 ' + (postC['P东']-preC['P东']));
  assert(postC['P西'] - preC['P西'] === -1000, '三人唯一闲家P西付子额1000，实得 ' + (postC['P西']-preC['P西']));

  console.log('\n====================================');
  console.log('自摸结算简化专项测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  if (fail > 0) process.exit(1);
}

main();
