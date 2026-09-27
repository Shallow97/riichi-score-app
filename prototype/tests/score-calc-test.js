/**
 * score-calc-test.js — 番符点数计算器专项测试
 * 1. rules.js calcScore 纯函数正确性（对照标准日麻速查表）
 * 2. UI：左下角按钮存在可打开弹窗，改番/符/亲闲实时刷新结果
 * 运行：NODE_PATH=<workspace>/node_modules node score-calc-test.js
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
  // ---------- 第一部分：纯函数 calcScore（直接 require rules.js） ----------
  const Rules = require(path.join(ROOT, 'js/rules.js'));
  console.log('\n== 一、calcScore 纯函数（对照标准速查表） ==\n');
  function ck(h, f, seat, expectRon, expectTsumo, label) {
    const r = Rules.calcScore(h, f, seat);
    const ok = !r.error && r.ron === expectRon && r.tsumo === expectTsumo;
    assert(ok, `${label}：荣和${expectRon}/自摸${expectTsumo}` + (ok ? '' : `  实得 ron=${r.ron} tsumo=${r.tsumo} err=${r.error}`));
  }
  // 子家（ko）
  ck(1, 30, 'ko', 1000, 1100, '子30符1番');     // 自摸 300·500 → 和牌者 300+300+500=1100
  ck(2, 30, 'ko', 2000, 2000, '子30符2番');     // 500·1000
  ck(3, 30, 'ko', 3900, 4000, '子30符3番');     // 1000·2000
  ck(4, 30, 'ko', 7700, 7900, '子30符4番(不开切上=7700)'); // 2000·3900
  ck(1, 40, 'ko', 1300, 1500, '子40符1番');     // 400·700
  ck(2, 40, 'ko', 2600, 2700, '子40符2番');     // 700·1300
  ck(3, 40, 'ko', 5200, 5200, '子40符3番');     // 1300·2600
  ck(4, 40, 'ko', 8000, 8000, '子40符4番(base2560→满贯)');
  ck(1, 50, 'ko', 1600, 1600, '子50符1番');     // 400·800
  ck(2, 50, 'ko', 3200, 3200, '子50符2番');     // 800·1600
  ck(2, 25, 'ko', 1600, 1600, '子25符2番(七对子)'); // 400·800
  ck(1, 70, 'ko', 2300, 2400, '子70符1番');     // 600·1200
  ck(3, 60, 'ko', 7700, 7900, '子60符3番(base1920<2000 不开切上)'); // 2000·3900
  // 亲家（oya）
  ck(1, 30, 'oya', 1500, 1500, '亲30符1番');    // 闲各付500
  ck(2, 30, 'oya', 2900, 3000, '亲30符2番');    // 闲各付1000
  ck(3, 30, 'oya', 5800, 6000, '亲30符3番');    // 闲各付2000
  ck(4, 30, 'oya', 11600, 11700, '亲30符4番(不开切上=11600)'); // 闲各付3900
  ck(1, 40, 'oya', 2000, 2100, '亲40符1番');    // 闲各付700
  ck(3, 40, 'oya', 7700, 7800, '亲40符3番');    // 闲各付2600
  // 满贯以上档位（番≥5，无视符数）
  ck(5, 30, 'ko', 8000, 8000, '子5番=满贯');
  ck(6, 30, 'ko', 12000, 12000, '子6番=跳满');
  ck(8, 30, 'ko', 16000, 16000, '子8番=倍满');
  ck(11, 30, 'ko', 24000, 24000, '子11番=三倍满');
  ck(13, 30, 'ko', 32000, 32000, '子13番=役满');
  ck(5, 30, 'oya', 12000, 12000, '亲5番=满贯');
  ck(13, 30, 'oya', 48000, 48000, '亲13番=役满');
  // 边界
  ck(1, 110, 'ko', 3600, 3600, '子110符1番(base880×4=3520→3600)');
  // limit 标签
  const lim = Rules.calcScore(7, 40, 'oya');
  assert(lim.limit === '跳满', '7番亲=跳满标签');
  const lim2 = Rules.calcScore(2, 30, 'ko');
  assert(lim2.limit === null, '2番30符无档位标签');
  const err = Rules.calcScore(0, 30, 'ko');
  assert(!!err.error, '番数0返回错误');
  const err2 = Rules.calcScore(3, 5, 'ko');
  assert(!!err2.error, '符数<20返回错误');

  // ---------- 三人局（缺北自摸损）：总额只算实际付款家 ----------
  console.log('\n== 一·补、三人局自摸损（playerCount=3） ==\n');
  /** 三人局断言：分类应付额与总额各是多少 */
  function ck3(h, f, seat, koPay, oyaPay, total, label) {
    const r = Rules.calcScore(h, f, seat, 3);
    const ok = !r.error && r.tsumoKo === koPay && r.tsumoOya === oyaPay && r.tsumo === total;
    assert(ok, `${label}：闲付${koPay}/庄付${oyaPay}/总额${total}` +
      (ok ? '' : `  实得 ko=${r.tsumoKo} oya=${r.tsumoOya} total=${r.tsumo} err=${r.error}`));
    return r;
  }
  // 子家 3番30符(base960)：闲1000/庄2000；三人只有 1 位闲家付 → 总额 3000（四人 4000）
  const r3ko = ck3(3, 30, 'ko', 1000, 2000, 3000, '三人·子3番30符');
  assert(r3ko.ron === 3900, '三人局「荣和」不受人数影响（仍 3900），实得 ' + r3ko.ron);
  assert(r3ko.tsumoNote.includes('三人缺北'), '三人局分摊说明标注缺北自摸损：' + r3ko.tsumoNote);
  // 亲家 3番30符：闲各付 2000；三人只有 2 位闲家付 → 总额 4000（四人 6000）
  const r3oya = ck3(3, 30, 'oya', 2000, null, 4000, '三人·亲3番30符');
  assert(r3oya.ron === 5800, '三人局亲家荣和不受影响（仍 5800），实得 ' + r3oya.ron);
  assert(r3oya.tsumoNote.includes('三人缺北'), '亲家自摸说明同样标注缺北：' + r3oya.tsumoNote);
  // 满贯档走 LIMIT_LOOKUP 分支，同样要按人数折
  ck3(5, 30, 'ko', 2000, 4000, 6000, '三人·子5番满贯');
  ck3(5, 30, 'oya', 4000, null, 8000, '三人·亲5番满贯');
  // 不传人数时默认四人（向后兼容：上面 45 项断言即基于此口径）
  const dflt = Rules.calcScore(3, 30, 'ko');
  assert(dflt.tsumo === 4000 && !dflt.tsumoNote.includes('三人缺北'),
    '不传人数时默认按四人（tsumo=4000、无缺北标注）');

  // ---------- 第二部分：UI 交互（jsdom） ----------
  console.log('\n== 二、番符表 UI（按钮/弹窗/实时刷新） ==\n');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const calcBtn = document.getElementById('btn-calc');
  assert(!!calcBtn, '存在左下角计算器按钮 btn-calc');
  // 打开弹窗（需先进入对局页使 bindMainPage 绑定按钮；calc-btn 在 DOM，静态点击即可——但 app.js 绑定在 bindMainPage 里）
  // 进入四人局以触发绑定
  function build4p() {
    document.getElementById('mode-4').click();
    document.getElementById('btn-next-setup').click();
    document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
    document.getElementById('btn-create-game').click();
  }
  build4p();
  calcBtn.click();
  const modal = document.getElementById('modal-calc');
  assert(modal.classList.contains('show'), '点击计算器按钮后弹窗打开');
  // 默认 3番/30符/子家
  assert(document.getElementById('calc-han').value === '3', '默认番数=3');
  assert(document.getElementById('calc-fu').value === '30', '默认符数=30');
  assert(document.getElementById('calc-seat-ko').classList.contains('active'), '默认选中子家');
  assert(document.getElementById('calc-ron').textContent === '3,900', '默认(子3番30符)荣和显示 3,900');
  assert(document.getElementById('calc-tsumo').textContent === '4,000', '默认(子3番30符)自摸显示 4,000');
  // 改符数40 → 子3番40符 荣和5200
  document.getElementById('calc-fu').value = '40';
  document.getElementById('calc-fu').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(document.getElementById('calc-ron').textContent === '5,200', '改符40→荣和 5,200');
  // 切亲家 → 亲3番40符 荣和7700
  document.getElementById('calc-seat-oya').click();
  assert(document.getElementById('calc-seat-oya').classList.contains('active'), '点击切到亲家');
  assert(document.getElementById('calc-seat-ko').classList.contains('active') === false, '子家选中态移除');
  assert(document.getElementById('calc-ron').textContent === '7,700', '切亲后(亲3番40符)荣和 7,700');
  // 改番5 → 满贯 亲12000
  document.getElementById('calc-han').value = '5';
  document.getElementById('calc-han').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(document.getElementById('calc-ron').textContent === '12,000', '番5亲=满贯荣和 12,000');
  const note = document.getElementById('calc-note').textContent;
  assert(note.indexOf('满贯') >= 0, '结果区显示【满贯】档位标签');
  // 关闭
  document.getElementById('btn-calc-close').click();
  assert(modal.classList.contains('show') === false, '点击关闭后弹窗关闭');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
