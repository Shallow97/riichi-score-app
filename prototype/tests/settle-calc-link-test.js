/**
 * settle-calc-link-test.js — 回归测试：「和牌结算-填写分数」⇄「番符点数表」联动
 *
 * 需求：结算录入弹窗内增加「点数计算（番符表）」按钮，
 *   1. 点击后打开现有番符表弹窗（叠在录入弹窗之上，录入弹窗不被关闭）；
 *   2. 该途径打开时，"荣和/自摸者"座位按本笔和牌者（收分方）锁定，另一座位置灰且不可切换；
 *   3. 点「关闭」后把计算结果自动键入录入框（荣和→分数；自摸→按闲/庄分类填入应付额）；
 *   4. 从主界面左下角独立打开时不受影响（座位自由切换、关闭不回填）。
 *
 * 覆盖：荣和(和牌者为庄/闲) / 自摸(自摸者为庄/闲) / 独立打开 / 三人局自摸总额，
 *       共六条路径（其中"三人局"一条同时回归"总额按人数折"的口径）。
 * 注意：荣和与自摸走两套不同的弹窗链（settle-amount ⇄ tsumo-amounts），
 *       只覆盖荣和会漏掉"自摸下按钮根本不存在"这类问题，故两条链都必须测。
 * 运行：NODE_PATH=<workspace>/node_modules node settle-calc-link-test.js
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

let document, window;
function pickText(sel, text) {
  return Array.from(document.querySelectorAll(sel)).find((p) => p.textContent.includes(text));
}
const $ = (id) => document.getElementById(id);
function changeSel(id, val) {
  $(id).value = String(val);
  $(id).dispatchEvent(new window.Event('change', { bubbles: true }));
}

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

  // ---- 静态：番符表必须能盖在结算填分弹窗之上（两者同为 .modal-overlay z-index:100，
  //      而 #modal-settle-amount 在 DOM 中更靠后，不抬高会被压在下面）----
  console.log('\n== 一、结构 / 层叠 ==\n');
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const zm = css.match(/#modal-calc\s*\{[^}]*z-index:\s*(\d+)/);
  assert(!!zm && parseInt(zm[1], 10) > 100, 'style.css 中 #modal-calc z-index 高于 .modal-overlay(100)，实得 ' + (zm ? zm[1] : '无'));
  assert(css.indexOf('.seat-chip.locked') >= 0, '存在 .seat-chip.locked 锁定样式');

  console.log('\n== 二、建四人局（庄家=东）并开启一炮多响 ==\n');
  $('mode-4').click();
  $('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'R' + inp.dataset.wind; });
  $('switch-multiron').classList.add('on');
  $('btn-create-game').click();
  assert($('page-main').classList.contains('active'), '进入对局主界面');

  // ---------- 场景1：和牌者 = 庄家（东）→ 座位锁定 oya，回填亲家荣和 ----------
  console.log('\n== 三、和牌者为庄家：座位锁 oya、关闭回填 ==\n');
  $('btn-tsumo-ron').click();
  $('btn-settle-ron').click();
  pickText('#pay-pick .p', 'R南').click();          // 放铳者 = 南
  pickText('#recv-pick .p', 'R东').click();         // 和牌者 = 东（庄家）
  assert($('modal-settle-amount').classList.contains('show'), '进入「和牌结算-填写应付分数」弹窗');
  assert(!!$('btn-settle-calc'), '填分弹窗内存在「点数计算」按钮 #btn-settle-calc');

  $('btn-settle-calc').click();
  assert($('modal-calc').classList.contains('show'), '点击点数计算后打开番符表弹窗');
  assert($('modal-settle-amount').classList.contains('show'), '填分弹窗保持打开（番符表叠在其上）');
  assert($('calc-seat-oya').classList.contains('active'), '座位按和牌者锁定为「亲家（庄）」');
  assert($('calc-seat-ko').classList.contains('locked'), '「子家（闲）」被置灰锁定');
  assert($('calc-link-hint').style.display === 'block', '显示联动提示条');
  assert($('calc-link-hint').textContent.includes('R东'), '提示条标明和牌者 R东：' + $('calc-link-hint').textContent);

  // 锁定后点击另一座位不应生效
  $('calc-seat-ko').click();
  assert($('calc-seat-oya').classList.contains('active'), '点击被锁定的「子家」后仍锁定亲家（不可切换）');

  changeSel('calc-han', 3);
  changeSel('calc-fu', 30);
  assert($('calc-ron').textContent === '5,800', '亲家 3番30符 荣和显示 5,800，实得 ' + $('calc-ron').textContent);
  $('btn-calc-close').click();
  assert(!$('modal-calc').classList.contains('show'), '点「关闭」后番符表关闭');
  assert($('modal-settle-amount').classList.contains('show'), '关闭番符表后仍停留在填分弹窗');
  assert($('settle-amount').value === '5800', '计算结果自动键入分数输入框（5800），实得 ' + $('settle-amount').value);
  assert(!$('calc-seat-ko').classList.contains('locked'), '关闭后座位锁定被解除（恢复自由模式）');

  // ---------- 场景2：多响第2笔，和牌者 = 闲家（西）→ 座位锁 ko ----------
  console.log('\n== 四、和牌者为闲家：座位锁 ko、关闭回填 ==\n');
  $('btn-settle-confirm').click();
  assert($('modal-settle-more').classList.contains('show'), '录入第1笔后弹出「是否还有其它和牌者」');
  $('btn-settle-more-yes').click();
  pickText('#recv-pick .p', 'R西').click();         // 和牌者 = 西（闲家）
  assert($('modal-settle-amount').classList.contains('show'), '第2笔进入填分弹窗');
  $('btn-settle-calc').click();
  assert($('modal-calc').classList.contains('show'), '第2笔再次唤起番符表');
  assert($('calc-seat-ko').classList.contains('active'), '座位按和牌者锁定为「子家（闲）」');
  assert($('calc-seat-oya').classList.contains('locked'), '「亲家（庄）」被置灰锁定');
  assert($('calc-link-hint').textContent.includes('R西'), '提示条标明和牌者 R西：' + $('calc-link-hint').textContent);
  assert($('calc-link-hint').textContent.includes('子家'), '提示条标明身份为子家/闲');

  changeSel('calc-han', 3);
  changeSel('calc-fu', 30);
  assert($('calc-ron').textContent === '3,900', '子家 3番30符 荣和显示 3,900，实得 ' + $('calc-ron').textContent);
  $('btn-calc-close').click();
  assert($('settle-amount').value === '3900', '第2笔结果回填（3900），实得 ' + $('settle-amount').value);

  // 完成本局结算，回到主界面
  console.log('\n== 五、独立打开番符表：不锁定、不回填 ==\n');
  $('btn-settle-more-done').click();
  assert($('modal-result').classList.contains('show'), '完成本局结算，显示结果弹窗');
  $('btn-result-close').click();

  $('btn-calc').click();
  assert($('modal-calc').classList.contains('show'), '左下角按钮可独立打开番符表');
  assert(!$('calc-seat-ko').classList.contains('locked') && !$('calc-seat-oya').classList.contains('locked'),
    '独立打开时两个座位均未锁定');
  assert($('calc-link-hint').style.display === 'none', '独立打开时不显示联动提示条');
  assert($('calc-link-hint').textContent === '', '独立打开时提示条内容已清空');
  $('calc-seat-oya').click();
  assert($('calc-seat-oya').classList.contains('active'), '独立打开时座位可自由切换（切到亲家成功）');
  changeSel('calc-han', 13);
  const before = $('settle-amount').value;
  $('btn-calc-close').click();
  assert($('settle-amount').value === before, '独立打开关闭后不回填分数（仍为 ' + before + '）');

  // ---------- 场景3：自摸者 = 闲家 → 座位锁 ko、按类回填闲/庄两格 ----------
  console.log('\n== 六、自摸路径（闲家自摸）：锁 ko、分类回填 ==\n');
  const windMap = {};
  document.querySelectorAll('#table-seats .seat').forEach((s) => {
    windMap[s.querySelector('.wind').textContent] = s.querySelector('.name').textContent;
  });
  const dealerName = windMap['东'];
  const koName = windMap['南'];
  assert(!!dealerName && !!koName, '从牌桌读到庄家=' + dealerName + '、闲家=' + koName);

  $('btn-tsumo-ron').click();
  $('btn-settle-tsumo').click();
  pickText('#tsumo-pick .p', koName).click();
  assert($('modal-tsumo-amounts').classList.contains('show'), '自摸：进入「自摸结算-输入应付额」弹窗');
  assert(!!$('btn-tsumo-calc'), '自摸填额层存在「点数计算」按钮 #btn-tsumo-calc');
  assert(document.querySelectorAll('#tsumo-amount-list .tsumo-koha').length === 1,
    '闲家自摸出现「每位闲家(子)应付」输入框');
  assert(document.querySelectorAll('#tsumo-amount-list .tsumo-oya').length === 1,
    '闲家自摸出现「庄家(亲)应付」输入框');

  $('btn-tsumo-calc').click();
  assert($('modal-calc').classList.contains('show'), '自摸路径可唤起番符表（此前根本无入口）');
  assert($('modal-tsumo-amounts').classList.contains('show'), '自摸填额弹窗保持打开（番符表叠在其上）');
  assert($('calc-seat-ko').classList.contains('active'), '座位按自摸者（闲家）锁定为「子家（闲）」');
  assert($('calc-seat-oya').classList.contains('locked'), '「亲家（庄）」被置灰锁定');
  assert($('calc-link-hint').style.display === 'block', '显示联动提示条');
  assert($('calc-link-hint').textContent.includes(koName), '提示条标明自摸者 ' + koName + '：' + $('calc-link-hint').textContent);
  assert($('calc-link-hint').textContent.includes('应付额'), '提示条文案指向应付额（非荣和分数）');

  changeSel('calc-han', 3);
  changeSel('calc-fu', 30);
  assert($('calc-tsumo').textContent === '4,000', '子家 3番30符 自摸总额显示 4,000，实得 ' + $('calc-tsumo').textContent);
  const ronFieldBefore = $('settle-amount').value;
  $('btn-calc-close').click();
  assert(!$('modal-calc').classList.contains('show'), '点「关闭」后番符表关闭');
  const kohaInp = $('tsumo-amount-list').querySelector('.tsumo-koha');
  const oyaInp = $('tsumo-amount-list').querySelector('.tsumo-oya');
  assert(kohaInp.value === '1000', '「闲家应付」填入 1000（base960 进位），实得 ' + kohaInp.value);
  assert(oyaInp.value === '2000', '「庄家应付」填入 2000（base1920 进位），实得 ' + oyaInp.value);
  assert($('settle-amount').value === ronFieldBefore, '自摸联动不回填荣和的分数输入框（两套录入互不串写）');
  assert(!$('calc-seat-oya').classList.contains('locked'), '关闭后座位锁定被解除（恢复自由模式）');

  // 端到端：点「确认结算」直接入账（核对明细已移除），用各家分数变化验证分类回填值被正确读取
  function readPtsMap() {
    const m = {};
    document.querySelectorAll('#table-seats .seat').forEach((s) => {
      m[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
    });
    return m;
  }
  const ptsBeforeKo = readPtsMap();
  $('btn-tsumo-confirm').click();
  assert($('modal-result').classList.contains('show'), '点「确认结算」直接进入结算结果（核对明细已移除）');
  const ptsAfterKo = readPtsMap();
  // 注：此前双响含庄家 → 连庄、本场 0→1，故自摸每家加摊 100 点（闲+300 / 庄−100）
  assert(ptsAfterKo[koName] - ptsBeforeKo[koName] === 4000 + 300,
    '自摸者收 4000+本场300（闲1000×2家+庄2000×1，分类回填值被正确读取），实得 ' + (ptsAfterKo[koName] - ptsBeforeKo[koName]));
  assert(ptsAfterKo[dealerName] - ptsBeforeKo[dealerName] === -2000 - 100,
    '庄家付亲额2000+本场100，实得 ' + (ptsAfterKo[dealerName] - ptsBeforeKo[dealerName]));
  assert(ptsAfterKo[windMap['西']] - ptsBeforeKo[windMap['西']] === -1000 - 100, '闲家(西)付子额1000+本场100');
  assert(ptsAfterKo[windMap['北']] - ptsBeforeKo[windMap['北']] === -1000 - 100, '闲家(北)付子额1000+本场100');
  $('btn-result-close').click();

  // ---------- 场景4：自摸者 = 庄家 → 座位锁 oya、单格回填 ----------
  console.log('\n== 七、自摸路径（庄家自摸）：锁 oya、单格回填 ==\n');
  // 场景3已真入账（闲家自摸换庄），重读方位拿当前庄家
  const windMap2 = {};
  document.querySelectorAll('#table-seats .seat').forEach((s) => {
    windMap2[s.querySelector('.wind').textContent] = s.querySelector('.name').textContent;
  });
  const dealerName2 = windMap2['东'];
  $('btn-tsumo-ron').click();
  $('btn-settle-tsumo').click();
  pickText('#tsumo-pick .p', dealerName2).click();
  assert($('modal-tsumo-amounts').classList.contains('show'), '庄家自摸进入填额弹窗');
  assert(document.querySelectorAll('#tsumo-amount-list .tsumo-shared').length === 1,
    '庄家自摸只出现一个「每位闲家应付」输入框');

  $('btn-tsumo-calc').click();
  assert($('calc-seat-oya').classList.contains('active'), '座位按自摸者（庄家）锁定为「亲家（庄）」');
  assert($('calc-seat-ko').classList.contains('locked'), '「子家（闲）」被置灰锁定');
  changeSel('calc-han', 3);
  changeSel('calc-fu', 30);
  $('btn-calc-close').click();
  const sharedInp = $('tsumo-amount-list').querySelector('.tsumo-shared');
  assert(sharedInp.value === '2000', '庄自摸「每位闲家应付」填入 2000，实得 ' + sharedInp.value);
  const ptsBeforeOya = readPtsMap();
  $('btn-tsumo-confirm').click();
  assert($('modal-result').classList.contains('show'), '庄自摸点「确认结算」直接进入结算结果');
  const ptsAfterOya = readPtsMap();
  assert(ptsAfterOya[dealerName2] - ptsBeforeOya[dealerName2] === 6000,
    '庄自摸者共收 6000（2000×3 家），实得 ' + (ptsAfterOya[dealerName2] - ptsBeforeOya[dealerName2]));
  $('btn-result-close').click();

  // ---------- 场景5：三人局 → 番符表自摸总额要扣掉"缺北"那一份 ----------
  console.log('\n== 八、三人局：番符表自摸总额扣掉缺北一份 ==\n');
  $('btn-new-game').click();
  $('btn-confirm-ok').click();
  assert($('page-mode').classList.contains('active'), '「新对局」回到模式选择页');
  $('mode-3').click();
  $('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  $('btn-create-game').click();
  assert($('page-main').classList.contains('active'), '建三人局进入主界面');

  $('btn-calc').click();
  changeSel('calc-han', 3);
  changeSel('calc-fu', 30);
  $('calc-seat-ko').click(); // 座位 chip 会保留上次选择（前面独立打开时切到过亲家），这里显式切回子家
  assert($('calc-seat-ko').classList.contains('active'), '座位切到「子家（闲）」');
  assert($('calc-ron').textContent === '3,900', '三人局荣和不受人数影响（3,900），实得 ' + $('calc-ron').textContent);
  assert($('calc-tsumo').textContent === '3,000',
    '三人局自摸总额扣掉缺北一份（3,000 = 闲1000 + 庄2000），实得 ' + $('calc-tsumo').textContent);
  assert($('calc-note').textContent.includes('三人缺北'), '分摊说明标注三人缺北：' + $('calc-note').textContent);
  $('calc-seat-oya').click();
  assert($('calc-tsumo').textContent === '4,000',
    '三人局亲家自摸 4,000（闲各付2000×2家），实得 ' + $('calc-tsumo').textContent);
  $('btn-calc-close').click();

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main();
