/**
 * domtest.js — 用 jsdom 模拟浏览器环境，端到端验证界面逻辑
 * 运行：NODE_PATH=<workspace>/node_modules node domtest.js
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

  // 拦截外部脚本，改为从文件系统加载
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // 注入 localStorage（jsdom 自带，但确认）
  // 加载三个 JS 文件到 window 上下文
  const rulesCode = fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8');
  const storageCode = fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

  window.eval(rulesCode);
  window.eval(storageCode);

  const { document } = window;

  console.log('\n== 测试1: 初始页面为模式选择 ==\n');
  // app.js 用 DOMContentLoaded/readyState 判断，jsdom 下 document.readyState='loading'，需手动触发
  // 先 eval app.js（此时会绑定 DOMContentLoaded）
  window.eval(appCode);
  // 触发 DOMContentLoaded
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // 断言模式页激活
  assert(document.getElementById('page-mode').classList.contains('active'), '默认显示模式选择页');

  console.log('\n== 测试1b: 首页查看对局记录跳转 ==\n');
  const gotoBtn = document.getElementById('btn-goto-history');
  assert(!!gotoBtn, '首页存在"查看对局记录"按钮');
  gotoBtn.click();
  assert(document.getElementById('page-history').classList.contains('active'), '点击后进入对局历史页');
  // 返回模式页继续后续测试（jsdom outside-only 内联 onclick 不生效，用"开新对局"按钮返回）
  document.getElementById('btn-new-game-history').click();
  assert(document.getElementById('page-mode').classList.contains('active'), '从历史页返回模式页');

  console.log('\n== 测试2: 选择三人模式并进入设置页 ==\n');
  document.getElementById('mode-3').click();
  document.getElementById('btn-next-setup').click();
  assert(document.getElementById('page-setup').classList.contains('active'), '进入开局设置页');
  assert(document.getElementById('setup-mode-label').textContent.includes('三人模式'), '模式标签显示三人模式');
  // 三人模式有3个座位输入框
  const nameInputs = document.querySelectorAll('.setup-name');
  assert(nameInputs.length === 3, '三人模式有3个座位用户名输入框');

  console.log('\n== 测试3: 填写用户名并建局 ==\n');
  nameInputs.forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  // 打开西入开关
  document.getElementById('switch-west').classList.add('on');
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '进入对局主界面');
  // 检查座位渲染
  const seats = document.querySelectorAll('#table-seats .seat');
  assert(seats.length === 3, '渲染3个座位');
  // 中心局数
  assert(document.getElementById('center-round').textContent === '东1局', '中心显示东1局');
  // 初始分数35000
  const ptsText = Array.from(document.querySelectorAll('#table-seats .pts')).map(e=>e.textContent);
  assert(ptsText.every(p => p === '35000'), '三人初始35000');

  // 总分合理性校验：三人建局总分应=35000×3=105000，无警告横幅
  assert(document.getElementById('total-check-banner').style.display === 'none', '三人建局总分正确，无警告横幅');
  const sum3 = ptsText.reduce((a, b) => a + parseInt(b, 10), 0);
  assert(sum3 === 105000, '三人初始总分105000');

  console.log('\n== 测试4: 立直 ==\n');
  // 打开立直选人弹窗
  document.getElementById('btn-riichi').click();
  assert(document.getElementById('modal-riichi').classList.contains('show'), '立直弹窗打开');
  // 点第一个玩家立直
  const riichiPicks = document.querySelectorAll('#riichi-pick .p');
  riichiPicks[0].click();
  assert(document.getElementById('modal-riichi').classList.contains('show') === false, '立直后弹窗关闭');
  // 检查供托和分数
  assert(document.getElementById('center-kyotaku').textContent.includes('1000'), '供托显示1000');
  const p0 = document.querySelectorAll('#table-seats .pts')[0];
  assert(p0.textContent === '34000', '立直后分数34000');
  // 立直棒指示：替换旧"立直"文字方框为横放立直棒（白条+红点）
  const riichiSticks = document.querySelectorAll('#table-seats .riichi-stick');
  assert(riichiSticks.length === 1, '立直后出现1根立直棒');
  assert(riichiSticks[0].querySelector('.riichi-stick-dot') !== null, '立直棒内含红色圆点');
  assert(document.querySelectorAll('#table-seats .riichi-flag').length === 0, '无旧"立直"文字方框');

  console.log('\n== 测试4b: 立直可撤销（再次点按已立直者取消） ==\n');
  // 重新打开立直选人：已立直者分数下方应显示立直棒（无高亮、无文字提示）
  document.getElementById('btn-riichi').click();
  assert(document.getElementById('modal-riichi').classList.contains('show'), '再次打开立直弹窗');
  const riichiPickItems = Array.from(document.querySelectorAll('#riichi-pick .p'));
  assert(!riichiPickItems[0].classList.contains('riichi-picked'), '已立直者无高亮类(riichi-picked)');
  assert(riichiPickItems[0].querySelector('.riichi-stick') !== null, '已立直者在选人列表分数下方显示立直棒');
  assert(riichiPickItems[0].textContent.includes('已立直') === false, '选人列表不再显示"已立直"文字提示');
  // 点已立直的同一玩家 → 取消立直
  riichiPickItems[0].click();
  assert(document.getElementById('modal-riichi').classList.contains('show') === false, '取消立直后弹窗关闭');
  assert(document.getElementById('center-kyotaku').textContent.includes('0'), '取消立直后供托归0: ' + document.getElementById('center-kyotaku').textContent);
  const p0b = document.querySelectorAll('#table-seats .pts')[0];
  assert(p0b.textContent === '35000', '取消立直后分数退回35000');
  assert(document.querySelectorAll('#table-seats .riichi-stick').length === 0, '取消立直后立直棒消失');
  // 再立直一次，验证可再次立直（开关往返）
  document.getElementById('btn-riichi').click();
  document.querySelectorAll('#riichi-pick .p')[0].click();
  assert(document.getElementById('center-kyotaku').textContent.includes('1000'), '再次立直后供托恢复1000');

  console.log('\n== 测试5: 和牌结算（荣和） ==\n');
  document.getElementById('btn-tsumo-ron').click();
  assert(document.getElementById('modal-settle-type').classList.contains('show'), '和牌类型弹窗打开');
  // 选荣和
  document.getElementById('btn-settle-ron').click();
  assert(document.getElementById('modal-settle-pay').classList.contains('show'), '荣和→选付分人弹窗打开');
  // 选付分人 P东
  const payPicks = document.querySelectorAll('#pay-pick .p');
  payPicks[0].click();
  assert(document.getElementById('modal-settle-recv').classList.contains('show'), '选收分对象弹窗');
  // 选收分对象（第2个）
  const recvPicks = document.querySelectorAll('#recv-pick .p');
  recvPicks[0].click();
  assert(document.getElementById('modal-settle-amount').classList.contains('show'), '填分数弹窗');
  // 填分数
  document.getElementById('settle-amount').value = '2000';
  document.getElementById('btn-settle-confirm').click();
  // 未开启"允许一炮多响"：不存在"本局还有其他付分人"的情况，确认后直接完成结算
  assert(document.getElementById('modal-settle-more').classList.contains('show') === false, '未开启多响时不询问"是否还有其他人付分"');
  assert(document.getElementById('modal-result').classList.contains('show'), '显示结算结果弹窗');
  // 供托收入体现（测试4立直了P东，本局荣和应把1000供托并入赢家）
  const kResultEl = document.getElementById('result-kyotaku');
  assert(kResultEl.style.display !== 'none', '结算结果弹窗显示供托收入行');
  const kResultText = kResultEl.textContent;
  assert(kResultText.includes('1000') && kResultText.includes('P南'), '供托行显示P南收取1000点供托: ' + kResultText);
  // 赢家P南的delta应含荣和2000+供托1000=+3000（供托并入后不再只显示+2000）
  const ronResultText = document.getElementById('result-players').textContent;
  const ronSouthSeg = ronResultText.slice(ronResultText.indexOf('P南'), ronResultText.indexOf('P南') + 40);
  assert(ronSouthSeg.includes('+3000'), '赢家P南delta含供托+荣和(+3000): ' + ronSouthSeg.replace(/\n/g, ' | '));
  // 检查分数：P东 -2000, 收分人 +2000
  document.getElementById('btn-result-close').click();
  const ptsAfter = Array.from(document.querySelectorAll('#table-seats .pts')).map(e=>e.textContent);
  console.log('    结算后分数:', ptsAfter);
  // 验证局数推进（闲家和牌换庄，本场0）
  // 收分人是第2个玩家（南），是闲家，庄换到下家

  console.log('\n== 测试5b: 自摸流程（简化：庄自摸填一次自动复制到各闲家） ==\n');
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-tsumo').click();
  assert(document.getElementById('modal-tsumo').classList.contains('show'), '自摸→选自摸者弹窗');
  const tsumoPicks = document.querySelectorAll('#tsumo-pick .p');
  // 上一局闲家(南=P南)和牌换庄，现庄家=P南=players[1]。选庄家自摸：只需填一个"每位闲家应付"。
  tsumoPicks[1].click();
  assert(document.getElementById('modal-tsumo-amounts').classList.contains('show'), '自摸→输入应付额弹窗');
  assert(document.querySelectorAll('.tsumo-shared').length === 1, '庄家自摸只出现一个"每位闲家应付"输入框');
  assert(document.querySelectorAll('.tsumo-koha').length === 0 && document.querySelectorAll('.tsumo-oya').length === 0,
    '庄家自摸不出现闲家/庄家两个输入框');
  // 填一次 1000，程序自动复制给其余各闲家，点「确认结算」直接入账（核对明细弹窗已移除）
  document.querySelector('.tsumo-shared').value = '1000';
  document.getElementById('btn-tsumo-confirm').click();
  assert(document.getElementById('modal-tsumo-review') === null, '核对明细弹窗已从DOM移除');
  assert(document.getElementById('modal-tsumo-amounts').classList.contains('show') === false, '确认结算后填额弹窗关闭');
  assert(document.getElementById('modal-result').classList.contains('show'), '点"确认结算"直接显示结算结果');
  // 验证自摸者(庄)多笔转移净变化累加：其余2闲家各1000 → 显示 +2000
  const tsumoResultText = document.getElementById('result-players').textContent;
  assert(tsumoResultText.includes('+2000'), '庄家自摸者结果弹窗显示多笔转移累加(+2000)');
  document.getElementById('btn-result-close').click();

  console.log('\n== 测试6: 撤回（需二次确认） ==\n');
  // 记录撤回前分数
  const beforeUndo = Array.from(document.querySelectorAll('#table-seats .pts')).map(e=>e.textContent);
  // 点撤回应弹出确认弹窗而非直接执行
  document.getElementById('btn-undo').click();
  assert(document.getElementById('modal-confirm').classList.contains('show'), '点撤回先弹二次确认弹窗');
  // 取消：不撤回，分数不变
  document.getElementById('btn-confirm-cancel').click();
  assert(document.getElementById('modal-confirm').classList.contains('show') === false, '取消后确认弹窗关闭');
  const afterCancelUndo = Array.from(document.querySelectorAll('#table-seats .pts')).map(e=>e.textContent);
  assert(JSON.stringify(beforeUndo) === JSON.stringify(afterCancelUndo), '取消撤回分数不变');
  // 再次点撤回并点确定才真正执行撤回
  document.getElementById('btn-undo').click();
  assert(document.getElementById('modal-confirm').classList.contains('show'), '再次点撤回仍弹确认弹窗');
  document.getElementById('btn-confirm-ok').click();
  const afterUndo = Array.from(document.querySelectorAll('#table-seats .pts')).map(e=>e.textContent);
  assert(JSON.stringify(beforeUndo) !== JSON.stringify(afterUndo), '确认撤回后分数变化');

  console.log('\n== 测试7: 流局（荒牌） ==\n');
  document.getElementById('btn-flow').click();
  assert(document.getElementById('modal-flow').classList.contains('show'), '流局弹窗打开');
  document.getElementById('flow-koei').click();
  assert(document.getElementById('modal-flow-koei').classList.contains('show'), '荒牌流局弹窗');
  // 记录流局前分数
  const ptsBeforeFlow = Array.from(document.querySelectorAll('#table-seats .seat')).map((s) => ({
    name: s.querySelector('.name').textContent,
    pts: parseInt(s.querySelector('.pts').textContent, 10),
  }));
  // 勾选第一个玩家听牌
  const tanyouPicks = document.querySelectorAll('#tanyou-pick .p');
  const tanyouName0 = tanyouPicks[0].querySelector('.name').textContent;
  tanyouPicks[0].classList.add('selected');
  document.getElementById('btn-koei-confirm').click();
  assert(document.getElementById('modal-flow-koei').classList.contains('show') === false, '荒牌流局确认后关闭');
  // 荒牌流局结果弹窗：显示转移明细
  assert(document.getElementById('modal-result').classList.contains('show'), '荒牌流局显示结算结果弹窗');
  // 验证转移：听牌者(唯一) +2000，其余两家各 -1000（三人局总转移 2000）
  const ptsAfterFlow = Array.from(document.querySelectorAll('#table-seats .seat')).map((s) => ({
    name: s.querySelector('.name').textContent,
    pts: parseInt(s.querySelector('.pts').textContent, 10),
  }));
  const deltaByName = {};
  ptsAfterFlow.forEach((a) => {
    const b = ptsBeforeFlow.find((x) => x.name === a.name);
    deltaByName[a.name] = a.pts - b.pts;
  });
  assert(deltaByName[tanyouName0] === 2000, `荒牌流局：听牌者 ${tanyouName0} +2000（实际 ${deltaByName[tanyouName0]}）`);
  const others = ptsBeforeFlow.filter((x) => x.name !== tanyouName0);
  assert(others.every((x) => deltaByName[x.name] === -1000),
    '荒牌流局：其余两家各 -1000（三人局总转移 2000）');
  // 关闭结果弹窗
  document.getElementById('btn-result-close').click();
  assert(document.getElementById('modal-result').classList.contains('show') === false, '关闭流局结果弹窗');

  console.log('\n== 测试8: 结束对局保存历史 ==\n');
  document.getElementById('btn-end').click();
  assert(document.getElementById('modal-end').classList.contains('show'), '结束弹窗打开');
  document.getElementById('btn-end-confirm').click();
  assert(document.getElementById('page-history').classList.contains('active'), '结束进入历史页');
  const histItems = document.querySelectorAll('#history-list .list-item');
  assert(histItems.length >= 1, '历史列表有记录');
  // localStorage 持久化检查
  assert(window.localStorage.getItem('riichi_finished') !== null, '已完成对局已持久化');

  console.log('\n== 测试8b: 历史详情删除记录 ==\n');
  // 打开第一条历史详情
  const histBefore = document.querySelectorAll('#history-list .list-item').length;
  document.querySelectorAll('#history-list .list-item')[0].click();
  assert(document.getElementById('modal-detail').classList.contains('show'), '历史详情弹窗打开');
  assert(document.getElementById('detail-title').textContent.includes('麻将'), '详情标题显示麻将模式');
  assert(document.getElementById('btn-detail-delete'), '详情弹窗有删除按钮');
  // 点删除 → 弹出确认
  document.getElementById('btn-detail-delete').click();
  assert(document.getElementById('modal-confirm').classList.contains('show'), '删除弹出确认弹窗');
  // 先取消，记录不应删除
  document.getElementById('btn-confirm-cancel').click();
  assert(document.getElementById('modal-confirm').classList.contains('show') === false, '取消后确认弹窗关闭');
  assert(document.getElementById('modal-detail').classList.contains('show'), '取消后详情弹窗仍打开');
  assert(document.querySelectorAll('#history-list .list-item').length === histBefore, '取消后历史记录未删除');
  // 再点删除并确认
  document.getElementById('btn-detail-delete').click();
  document.getElementById('btn-confirm-ok').click();
  assert(document.getElementById('modal-detail').classList.contains('show') === false, '删除确认后详情弹窗关闭');
  assert(document.querySelectorAll('#history-list .list-item').length === histBefore - 1, '删除后历史记录减少一条');
  assert(window.localStorage.getItem('riichi_finished') !== null, '删除后 localStorage 仍保留其余记录');

  console.log('\n== 测试9: 对局中返回按钮（保留对局） ==\n');
  // 重新建立一个进行中的对局（四人），验证返回按钮
  document.getElementById('btn-new-game-history').click();
  assert(document.getElementById('page-mode').classList.contains('active'), '历史页点开新局回模式选择');
  // 选四人
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  const nameInputs4 = document.querySelectorAll('.setup-name');
  nameInputs4.forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '建立四人局进入主界面');
  // 当前对局已持久化
  assert(window.localStorage.getItem('riichi_active_game') !== null, '进行中对局已持久化');

  // 非首次建房：再进 setup 页，用户名输入框应为空
  document.getElementById('btn-back-main').click();
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  const setupNamesEmpty = Array.from(document.querySelectorAll('.setup-name')).every((inp) => inp.value === '');
  assert(setupNamesEmpty, '非首次建房时所有用户名输入框为空');
  // 填名并建局
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '非首次建房进入主界面');

  // 测试返回按钮：应回到模式选择页，且对局保留（不清 active）
  document.getElementById('btn-back-main').click();
  assert(document.getElementById('page-mode').classList.contains('active'), '返回按钮回到模式选择页');
  assert(window.localStorage.getItem('riichi_active_game') !== null, '返回后进行中对局仍保留');

  // 测试新对局按钮：弹出确认弹窗，取消不动作，确定才清空
  // 先重新进入主界面（对局仍保留在内存 game 变量）
  // 通过 showMain 全局函数回主界面
  window.showMain();
  assert(document.getElementById('page-main').classList.contains('active'), '再次进入主界面');
  document.getElementById('btn-new-game').click();
  assert(document.getElementById('modal-confirm').classList.contains('show'), '新对局弹出确认弹窗');
  // 先点取消
  document.getElementById('btn-confirm-cancel').click();
  assert(document.getElementById('modal-confirm').classList.contains('show') === false, '取消后确认弹窗关闭');
  assert(window.localStorage.getItem('riichi_active_game') !== null, '取消后对局仍保留');
  assert(document.getElementById('page-main').classList.contains('active'), '取消后仍在主界面');
  // 再点新对局并确认
  document.getElementById('btn-new-game').click();
  assert(document.getElementById('modal-confirm').classList.contains('show'), '再次弹出确认弹窗');
  document.getElementById('btn-confirm-ok').click();
  assert(document.getElementById('modal-confirm').classList.contains('show') === false, '确认后弹窗关闭');
  assert(window.localStorage.getItem('riichi_active_game') === null, '确认后对局已清空');
  assert(document.getElementById('page-mode').classList.contains('active'), '确认后回到模式选择页');

  console.log('\n== 测试10: 实际方位与游戏内方位 ==\n');
  // 建四人局，起庄选"实际南"，验证：P南 开局为游戏内东（庄），界面用实际方位定位且无"庄"标记
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('setup-dealer').value = '南'; // 起庄者=实际南座
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '四人局进入主界面');
  // 收集界面四个槽位的 (实际方位seat定位 → 显示风牌wind)
  const seatData = Array.from(document.querySelectorAll('#table-seats .seat')).map((s) => {
    return { cls: s.className, wind: s.querySelector('.wind').textContent, name: s.querySelector('.name').textContent };
  });
  // 找到 P南（起庄者），其显示风牌应为"东"
  const pnan = seatData.find((s) => s.name === 'P南');
  assert(pnan && pnan.wind === '东', '起庄者(实际南)开局游戏内方位为东');
  // 四个槽位 class 应各含 seat-east/south/west/north 之一（实际方位定位）
  const clsSet = new Set(seatData.map((s) => s.cls));
  ['seat-east', 'seat-south', 'seat-west', 'seat-north'].forEach((c) => {
    assert(Array.from(clsSet).some((cls) => cls.includes(c)), '界面包含实际方位槽位 ' + c);
  });
  // 界面不应有"庄"字徽章
  assert(!document.querySelector('#table-seats .dealer-badge'), '界面无庄字徽章');
  assert(!document.querySelector('#table-seats .seat-dealer'), '界面无庄家高亮样式');

  // 完成一局：P东（闲家）和牌 → 换庄 → 庄家顺移到 P东（实际东），P东游戏内方位变"东"
  // 用一个简单结算：P西付分给 P东
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  // 选付分人 P西
  Array.from(document.querySelectorAll('#pay-pick .p')).find((p) => p.textContent.includes('P西')).click();
  // 选收分对象 P东
  Array.from(document.querySelectorAll('#recv-pick .p')).find((p) => p.textContent.includes('P东')).click();
  document.getElementById('settle-amount').value = '1000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-result').classList.contains('show'), '显示结算结果');
  // 关闭结果弹窗
  document.getElementById('btn-result-close').click();
  // 换庄后：新庄家=原庄P南的下家=P西（实际西）→ 游戏内东；P南（原庄）→ 游戏内北
  const seatData2 = Array.from(document.querySelectorAll('#table-seats .seat')).map((s) => {
    return { wind: s.querySelector('.wind').textContent, name: s.querySelector('.name').textContent };
  });
  const pXi2 = seatData2.find((s) => s.name === 'P西');
  assert(pXi2 && pXi2.wind === '东', '换庄后新庄家(实际西)游戏内方位为东');
  const pNan2 = seatData2.find((s) => s.name === 'P南');
  assert(pNan2 && pNan2.wind === '北', '原庄家(实际南)换庄后游戏内方位为北');

  console.log('\n== 测试11: 本场加算（荣和/自摸，每多1本场和牌者多收300） ==\n');
  // 建立一个四人局
  window.showMode();
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  // 制造本场数：庄家和牌 → 连庄 → 本场+1。
  // 起庄默认实际东=游戏内东（庄）。让庄(P东)和牌：P西付分给P东。
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  Array.from(document.querySelectorAll('#pay-pick .p')).find((p) => p.textContent.includes('P西')).click();
  Array.from(document.querySelectorAll('#recv-pick .p')).find((p) => p.textContent.includes('P东')).click();
  document.getElementById('settle-amount').value = '1000';
  document.getElementById('btn-settle-confirm').click();
  document.getElementById('btn-result-close').click();
  const honbaNow = document.getElementById('center-honba').textContent;
  assert(honbaNow.includes('1') || honbaNow.includes('2'), '庄家连庄后本场数增加，当前: ' + honbaNow);
  const N = parseInt(honbaNow.replace(/[^0-9]/g, ''), 10) || 0;
  assert(N >= 1, '本场数 >= 1，用于后续加算验证');

  // —— 荣和本场加算验证 ——
  // 当前庄=游戏内东。取庄家姓名和另一个闲家。
  const windMap4 = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    windMap4[s.querySelector('.wind').textContent] = s.querySelector('.name').textContent;
  });
  const dealer4 = windMap4['东'];
  const other4 = windMap4['南']; // 一个非庄闲家
  // 记录结算前分数
  const ptsPre = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    ptsPre[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  // 荣和：other4 付 1000 给 dealer4，含本场加算(300×N)
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  Array.from(document.querySelectorAll('#pay-pick .p')).find((p) => p.textContent.includes(other4)).click();
  Array.from(document.querySelectorAll('#recv-pick .p')).find((p) => p.textContent.includes(dealer4)).click();
  document.getElementById('settle-amount').value = '1000';
  document.getElementById('btn-settle-confirm').click();
  document.getElementById('btn-result-close').click();
  const ptsAfterRon = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    ptsAfterRon[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  assert(ptsAfterRon[dealer4] - ptsPre[dealer4] === 1000 + 300 * N,
    `荣和：和牌者(庄)多收含本场加算。Δ=${ptsAfterRon[dealer4]-ptsPre[dealer4]}，期望 ${1000+300*N}`);
  assert(ptsPre[other4] - ptsAfterRon[other4] === 1000 + 300 * N,
    `荣和：放铳者多付含本场加算。Δ=${ptsPre[other4]-ptsAfterRon[other4]}，期望 ${1000+300*N}`);

  // —— 自摸本场加算验证 ——
  // 庄家连庄后本场又+1，重新读取本场数
  const honba2 = parseInt(document.getElementById('center-honba').textContent.replace(/[^0-9]/g, ''), 10) || N;
  // 记录分数
  const ptsPre2 = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    ptsPre2[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  // 自摸：dealer4(庄)自摸，只需填一个"每位闲家应付"=1000，程序自动复制给其他三家（含本场加算均摊 300×honba2/3）
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-tsumo').click();
  Array.from(document.querySelectorAll('#tsumo-pick .p')).find((p) => p.textContent.includes(dealer4)).click();
  assert(document.querySelectorAll('.tsumo-shared').length === 1, '四人局庄家自摸只出现一个"每位闲家应付"输入框');
  document.querySelector('.tsumo-shared').value = '1000';
  document.getElementById('btn-tsumo-confirm').click();
  document.getElementById('btn-result-close').click();
  const ptsAfterTsumo = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    ptsAfterTsumo[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  // 自摸者多收：3×1000 + 300×honba2
  const expectedTsumoDelta = 3 * 1000 + 300 * honba2;
  assert(ptsAfterTsumo[dealer4] - ptsPre2[dealer4] === expectedTsumoDelta,
    `自摸：自摸者多收含本场加算。Δ=${ptsAfterTsumo[dealer4]-ptsPre2[dealer4]}，期望 ${expectedTsumoDelta}`);
  // 每个非自摸者：-1000 - 100×honba2
  ['南', '西', '北'].forEach((w) => {
    const nm = windMap4[w];
    if (!nm || nm === dealer4) return;
    const expected = -1000 - 100 * honba2;
    assert(ptsAfterTsumo[nm] - ptsPre2[nm] === expected,
      `自摸：${nm} 应付含本场加算。Δ=${ptsAfterTsumo[nm]-ptsPre2[nm]}，期望 ${expected}`);
  });

  // 西入阈值规则级验证：三人40000，四人30000（通过 window.eval 访问 Rules）
  console.log('\n== 测试12: 西入阈值（三人40000 / 四人30000） ==\n');
  function westCase(mode, westRule, points, wind, num) {
    // 返回该局结算后是否结束
    return window.eval(`(function(){
      const g = Rules.createGame(${mode}, { westRule: ${westRule} });
      g.players.forEach((p,i)=>{ p.name=p.seat; p.points=[${points.join(',')}][i]; });
      g.round = { wind:'${wind}', num:${num} };
      Rules.applyRoundResult(g, { type:'ryukyoku', winners:[], transfers:[], kyotakuTo:null, tanyou:[] });
      return g.over;
    })()`);
  }
  // 三人（南场最后局=南三，num=3；阈值40000）
  assert(westCase(3, true, [35000,30000,25000], '南', 3) === false, '三人·南三最高35000(<40000)→进西场(未结束)');
  assert(westCase(3, true, [40000,30000,25000], '南', 3) === true, '三人·南三最高40000(>=40000)→结束');
  assert(westCase(3, true, [45000,30000,25000], '南', 3) === true, '三人·南三最高45000(>=40000)→结束');
  assert(westCase(3, true, [35000,30000,25000], '西', 2) === false, '三人·西入中最高35000(<40000)→继续');
  assert(westCase(3, true, [41000,30000,25000], '西', 2) === true, '三人·西入中最高41000(>=40000)→结束');
  // 四人（阈值不变仍30000）
  assert(westCase(4, true, [30000,25000,25000,25000], '南', 4) === true, '四人·南四最高30000(>=30000)→结束(阈值仍30000)');
  assert(westCase(4, true, [25000,25000,25000,25000], '南', 4) === false, '四人·南四最高25000(<30000)→进西场');
  assert(westCase(4, true, [29999,25000,25000,25000], '西', 2) === false, '四人·西入中最高29999(<30000)→继续');
  assert(westCase(4, true, [30000,25000,25000,25000], '西', 2) === true, '四人·西入中最高30000(>=30000)→结束');

  // ---- 轮转顺序与每场局数（三人3局/四人4局）----
  // 连续让非庄家(下家)和牌换庄推进，返回推进后的局序列
  function roundSeq(mode, steps, westRule) {
    return window.eval(`(function(){
      const g = Rules.createGame(${mode}, { westRule: ${westRule} });
      g.players.forEach((p)=>{ p.name=p.seat; p.points=${mode===3?'30000':'25000'}; });
      const out = [];
      for (let k=0; k<${steps}; k++) {
        const nextIdx = (g.dealerIndex + 1) % ${mode};
        const winner = g.players[nextIdx].name;
        Rules.applyRoundResult(g, { type:'ron', winners:[winner], transfers:[], kyotakuTo:null });
        if (g.over) break;
        out.push(g.round.wind + g.round.num);
      }
      return { seq: out, round: g.round.wind+g.round.num, over: g.over, reason: g.endReason };
    })()`);
  }
  // 三人轮转：东1-3→南1-3→西1-3，无东4/南4/西4
  const seq3 = roundSeq(3, 8, true).seq;
  assert(seq3.join(',') === '东2,东3,南1,南2,南3,西1,西2,西3', '三人轮转顺序为 东1-3→南1-3→西1-3(无东4/南4/西4)');
  // 三人开西入：推进并结算西三(最后局)→结束
  const end3w = roundSeq(3, 9, true);
  assert(end3w.over === true && end3w.reason.includes('西三'), '三人开西入·西三(最后局)结算后结束');
  // 三人不开西入：推进并结算南三(最后局)→结束
  const end3n = roundSeq(3, 7, false);
  assert(end3n.over === true && end3n.reason.includes('南三'), '三人不开西入·南三(最后局)结算后结束');
  // 四人轮转：东1-4→南1-4→西1…保持4局/场
  const seq4r = roundSeq(4, 8, true).seq;
  assert(seq4r.join(',') === '东2,东3,东4,南1,南2,南3,南4,西1', '四人轮转顺序保持4局/场(东1-4→南1-4→西1)');
  // 四人开西入：推进并结算西四(最后局)→结束
  const end4w = roundSeq(4, 12, true);
  assert(end4w.over === true && end4w.reason.includes('西四'), '四人开西入·西四(最后局)结算后结束');

  console.log('\n== 测试13: 场上总分合理性校验 ==\n');
  const tb = () => document.getElementById('total-check-banner');
  // 建四人局：总分应=25000×4=100000，无警告横幅
  document.getElementById('btn-new-game-history').click();
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'T' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  const sum4 = Array.from(document.querySelectorAll('#table-seats .pts')).reduce((a, e) => a + parseInt(e.textContent, 10), 0);
  assert(sum4 === 100000, '四人初始总分100000');
  assert(tb().style.display === 'none', '四人建局总分正确，无警告横幅');
  // 立直：1000入供托池，玩家总分99000+供托1000=100000，应守恒不误报
  document.getElementById('btn-riichi').click();
  document.querySelectorAll('#riichi-pick .p')[0].click();
  const playerSumAfterRiichi = Array.from(document.querySelectorAll('#table-seats .pts')).reduce((a, e) => a + parseInt(e.textContent, 10), 0);
  assert(playerSumAfterRiichi + 1000 === 100000, '立直后玩家总分99000+供托1000=100000守恒');
  // 手动修正弄乱总分 → 横幅出现
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-score').click(); // 进入「修正分数」
  document.querySelectorAll('#adjust-pick .p')[0].click();
  document.getElementById('adjust-delta').value = '100';
  document.getElementById('btn-adjust-confirm').click();
  assert(tb().style.display !== 'none', '手动修正弄乱总分后警告横幅出现');
  const tbText = tb().textContent;
  assert(tbText.includes('100100') && tbText.includes('100000'), '横幅显示当前分100100/应100000');
  assert(tbText.includes('100'), '横幅显示差额100点');
  // 手动修正改回 → 横幅消失
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-score').click(); // 进入「修正分数」
  document.querySelectorAll('#adjust-pick .p')[0].click();
  document.getElementById('adjust-delta').value = '-100';
  document.getElementById('btn-adjust-confirm').click();
  assert(tb().style.display === 'none', '修正回正确总分后警告横幅消失');

  console.log('\n== 测试14: 开启多响·荣和第一笔付分后仍询问 ==\n');
  // 建开启多响的四人局：确认第一笔付分后应询问"是否还有其他付分"
  document.getElementById('btn-new-game-history').click();
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'M' + inp.dataset.wind; });
  document.getElementById('switch-multiron').classList.add('on'); // 开启多响
  document.getElementById('btn-create-game').click();
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  Array.from(document.querySelectorAll('#pay-pick .p')).find((p) => p.textContent.includes('M东')).click();
  Array.from(document.querySelectorAll('#recv-pick .p')).find((p) => p.textContent.includes('M南')).click();
  document.getElementById('settle-amount').value = '2000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-settle-more').classList.contains('show'), '开启多响时询问是否还有其它和牌者');
  assert(document.getElementById('modal-result').classList.contains('show') === false, '尚未完成结算(无结果弹窗)');
  assert(document.getElementById('settle-queue-count').textContent === '本局已有 1 位和牌者收分（放铳者：M东）', '询问框显示"已有 1 位和牌者收分（放铳者：M东）"');
  document.getElementById('btn-settle-more-done').click();
  assert(document.getElementById('modal-result').classList.contains('show'), '完成后显示结算结果弹窗');

  console.log('\n== 测试15: 用户名查重（阻止重名建局） ==\n');
  // 回到设置页，填入两个相同用户名，验证无法建局并被提示修改
  document.getElementById('btn-new-game-history').click();
  assert(document.getElementById('page-mode').classList.contains('active'), '历史页点开新局回模式选择');
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  assert(document.getElementById('page-setup').classList.contains('active'), '进入开局设置页');
  const nameInputsDup = Array.from(document.querySelectorAll('.setup-name'));
  assert(nameInputsDup.length === 4, '四人模式有4个座位用户名输入框');
  // 先清空持久化的进行中对局，确保断言"重名未持久化"有意义
  window.localStorage.removeItem('riichi_active_game');
  // 两个座位填相同名字（如东座与南座都叫"a"）
  nameInputsDup.forEach((inp) => {
    const w = inp.dataset.wind;
    inp.value = (w === '东' || w === '南') ? 'a' : 'P' + w;
  });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-setup').classList.contains('active'), '存在重名时点击建局仍停留在设置页（未进入对局）');
  assert(document.getElementById('page-main').classList.contains('active') === false, '重名时未进入主界面');
  assert(window.localStorage.getItem('riichi_active_game') === null, '重名时未持久化任何对局');
  // toast 应提示用户名重复（检查 toast 文案）
  const dupToast = document.getElementById('toast').textContent;
  assert(dupToast.includes('用户名重复'), 'toast 提示用户名重复: ' + dupToast);

  // 修正重名后应能成功建局
  nameInputsDup.forEach((inp) => {
    if (inp.value === 'a') inp.value = 'P' + inp.dataset.wind;
  });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '改掉重名后可正常建局进入主界面');
  assert(window.localStorage.getItem('riichi_active_game') !== null, '改掉重名后对局已持久化');

  console.log('\n== 测试16: 骰子按钮与摇一摇 ==\n');
  const diceBtn = document.getElementById('btn-dice');
  assert(!!diceBtn, '主界面右下角存在骰子按钮');
  // 打开骰子弹窗
  diceBtn.click();
  assert(document.getElementById('modal-dice').classList.contains('show'), '点击骰子按钮后弹窗打开');
  // 弹窗内含两个骰子
  const diceEls = document.querySelectorAll('#dice-row .die');
  assert(diceEls.length === 2, '弹窗内显示两个骰子');
  // 初始展示默认点数（无动画，且点数为1→仅中心1个pip可见）
  assert(diceEls[0].querySelectorAll('.pip[style*="block"]').length === 1, '初始骰子显示1点(1个pip)');
  // 摇一摇：动画过程中添加 shaking 类，动画结束后显示1~6随机点数
  document.getElementById('btn-dice-shake').click();
  assert(diceEls[0].classList.contains('shaking') === false || diceEls[0].querySelectorAll('.pip[style*="block"]').length >= 1, '摇一摇后骰子仍在(动画中或已显示点数)');
  // 等待摇动结束（约 0.7s+余量）后校验点数在 1~6 且动画类移除
  await new Promise((r) => setTimeout(r, 850));
  const shownVals = Array.from(document.querySelectorAll('#dice-row .die')).map((el) => {
    return el.querySelectorAll('.pip[style*="block"]').length;
  });
  assert(shownVals.length === 2 && shownVals.every((v) => v >= 1 && v <= 6), '摇动结束后两个骰子点数均在1~6: ' + shownVals.join(','));
  assert(!diceEls[0].classList.contains('shaking'), '摇动结束后移除 shaking 动画类');
  // 关闭按钮关闭弹窗
  document.getElementById('btn-dice-close').click();
  assert(document.getElementById('modal-dice').classList.contains('show') === false, '点击关闭按钮后弹窗关闭');
  // 番符表计算器按钮（左下角，与骰子对称）存在且可打开弹窗
  const calcBtn = document.getElementById('btn-calc');
  assert(!!calcBtn, '主界面左下角存在番符计算器按钮');
  calcBtn.click();
  assert(document.getElementById('modal-calc').classList.contains('show'), '点击计算器按钮后弹窗打开');
  assert(!!document.getElementById('calc-han') && !!document.getElementById('calc-fu'), '番数表含番数/符数下拉');
  assert(!!document.getElementById('calc-ron') && !!document.getElementById('calc-tsumo'), '番数表含荣和/自摸结果显示区');
  document.getElementById('btn-calc-close').click();
  assert(document.getElementById('modal-calc').classList.contains('show') === false, '点击关闭后计算器弹窗关闭');

  console.log('\n== 测试17: 手动修正扩展 —— 类型面板 ==\n');
  // 建四人局
  window.showMode();
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  // 打开手动修正 → 类型面板含 4 个类型按钮，且不直接显示玩家列表
  document.getElementById('btn-adjust').click();
  assert(document.getElementById('modal-adjust').classList.contains('show'), '点手动修正先弹「修正类型」面板');
  assert(!!document.getElementById('btn-adjust-type-score'), '类型面板含「修正分数」按钮');
  assert(!!document.getElementById('btn-adjust-type-round'), '类型面板含「修正所在局」按钮');
  assert(!!document.getElementById('btn-adjust-type-honba'), '类型面板含「修正本场数」按钮');
  assert(!!document.getElementById('btn-adjust-type-kyotaku'), '类型面板含「修正供托点」按钮');
  // 进入「修正分数」→ 选人弹窗打开
  document.getElementById('btn-adjust-type-score').click();
  assert(document.getElementById('modal-adjust').classList.contains('show') === false, '选类型后类型面板关闭');
  assert(document.getElementById('modal-adjust-score').classList.contains('show'), '「修正分数」打开选人弹窗');
  // 返回路径：直接关掉弹窗（关闭按钮由 close-x 触发）
  document.querySelector('#modal-adjust-score .close-x').click();
  assert(document.getElementById('modal-adjust-score').classList.contains('show') === false, '关闭修正分数选人弹窗');

  console.log('\n== 测试18: 修正所在局 —— 庄家联动推导 ==\n');
  // 用规则引擎直接验证：任意目标局，庄家 = 起庄玩家顺时针走「全半庄位次 mod n」步
  function roundDealer(mode, startSeat, targetWind, targetNum) {
    return window.eval(`(function(){
      const g = Rules.createGame(${mode}, { dealerName: '${startSeat}' });
      g.players.forEach((p) => { p.name = p.seat; });
      // 让起庄者开局为庄：把起庄者排到 dealerIndex
      g.dealerIndex = g.players.findIndex((p) => p.name === '${startSeat}');
      Rules.recalcWinds ? null : null;
      // 直接用导出函数推导庄家
      const idx = Rules.dealerIndexForRound(g, '${targetWind}', ${targetNum});
      const d = g.players[idx];
      return d.seat;
    })()`);
  }
  // 四人局：起庄者=实际东。东1→东；东2→南；东3→西；东4→北；南1→东（轮转一圈）
  assert(roundDealer(4, '东', '东', 1) === '东', '四人·起东：东1庄=东');
  assert(roundDealer(4, '东', '东', 2) === '南', '四人·起东：东2庄=南');
  assert(roundDealer(4, '东', '东', 3) === '西', '四人·起东：东3庄=西');
  assert(roundDealer(4, '东', '东', 4) === '北', '四人·起东：东4庄=北');
  assert(roundDealer(4, '东', '南', 1) === '东', '四人·起东：南1庄=东（轮转一圈）');
  assert(roundDealer(4, '东', '南', 4) === '北', '四人·起东：南4庄=北');
  assert(roundDealer(4, '东', '西', 2) === '南', '四人·起东：西2庄=南');
  // 三人局：起庄者=实际南。东1→南；东2→西；东3→东；南1→南
  assert(roundDealer(3, '南', '东', 1) === '南', '三人·起南：东1庄=南');
  assert(roundDealer(3, '南', '东', 2) === '西', '三人·起南：东2庄=西');
  assert(roundDealer(3, '南', '东', 3) === '东', '三人·起南：东3庄=东');
  assert(roundDealer(3, '南', '南', 1) === '南', '三人·起南：南1庄=南（轮转一圈）');
  assert(roundDealer(3, '南', '西', 2) === '西', '三人·起南：西2庄=西');

  // 端到端：DOM 改局 → 中心局数更新，各玩家方位随庄家重排，分数不变
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-round').click();
  assert(document.getElementById('modal-adjust-round').classList.contains('show'), '「修正所在局」弹窗打开');
  // 记录改局前各玩家分数与总分
  const scoreBefore = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    scoreBefore[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  // 起庄默认实际东 → 东1庄=P东。改到「东3局」（庄应=P西，且本场数保留）
  const cells = Array.from(document.querySelectorAll('#round-pick-grid .round-cell'));
  const targetCell = cells.find((c) => c.textContent === '东3局');
  assert(!!targetCell, '局数九宫格包含「东3局」选项');
  targetCell.click();
  assert(document.getElementById('btn-round-confirm').disabled === false, '选中目标局后确认按钮可用');
  const previewText = document.getElementById('adjust-round-preview').textContent;
  assert(previewText.includes('P西') && previewText.includes('庄家'), '预览显示目标局庄家为 P西: ' + previewText.replace(/\n/g, ' | '));
  document.getElementById('btn-round-confirm').click();
  assert(document.getElementById('modal-adjust-round').classList.contains('show') === false, '确认后所在局弹窗关闭');
  assert(document.getElementById('center-round').textContent === '东3局', '中心局数更新为东3局');
  // 庄家(游戏内东)应是 P西
  const windMapAfter = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    windMapAfter[s.querySelector('.wind').textContent] = s.querySelector('.name').textContent;
  });
  assert(windMapAfter['东'] === 'P西', '改东3局后庄家(游戏内东)=P西');
  assert(windMapAfter['南'] === 'P北', '改东3局后P北(游戏内南)');
  // 分数完全不变（守恒且不触碰分数）
  const scoreAfter = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    scoreAfter[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  assert(JSON.stringify(scoreBefore) === JSON.stringify(scoreAfter), '所在局修正不改动任何玩家分数');

  console.log('\n== 测试19: 修正所在局 —— over 状态下解除结束 ==\n');
  const overUnlock = window.eval(`(function(){
    const g = Rules.createGame(4, { dealerName: '东' });
    g.players.forEach((p) => { p.name = p.seat; });
    g.over = true; g.endReason = '误判结束';
    const r = Rules.adjustRound(g, '南', 2);
    return { ok: r.ok, over: g.over, endReason: g.endReason, round: g.round.wind + g.round.num, dealerSeat: g.players[g.dealerIndex].seat };
  })()`);
  assert(overUnlock.ok === true && overUnlock.over === false && overUnlock.endReason === '', 'over=true 时改局自动解除结束');
  assert(overUnlock.round === '南2', 'over 解除后局数已改为南2');
  assert(overUnlock.dealerSeat === '南', '南2局庄家=P南（起东四人，offset 5 mod4=1→南）');

  console.log('\n== 测试20: 修正本场数（含二次确认） ==\n');
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-honba').click();
  assert(document.getElementById('modal-adjust-honba').classList.contains('show'), '「修正本场数」弹窗打开');
  document.getElementById('adjust-honba-value').value = '3';
  document.getElementById('btn-honba-confirm').click();
  assert(document.getElementById('modal-confirm').classList.contains('show'), '本场数修改需二次确认弹窗');
  const confirmMsg = document.getElementById('confirm-msg').textContent;
  assert(confirmMsg.includes('300') && confirmMsg.includes('3'), '二次确认提示本场加算影响(300/本): ' + confirmMsg.replace(/\n/g, ' '));
  document.getElementById('btn-confirm-ok').click();
  assert(document.getElementById('center-honba').textContent.includes('3'), '确认后本场数更新为3: ' + document.getElementById('center-honba').textContent);
  // 越界拦截：负值或超 20 应被拒
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-honba').click();
  document.getElementById('adjust-honba-value').value = '99';
  document.getElementById('btn-honba-confirm').click();
  assert(document.getElementById('modal-confirm').classList.contains('show') === false, '超出范围(99)不弹二次确认(被拦截)');
  // 清理：关闭残留在屏幕上方的本场弹窗，避免干扰后续测试
  document.querySelector('#modal-adjust-honba .close-x').click();

  console.log('\n== 测试21: 修正供托点 —— 守恒联动 ==\n');
  // 规则级：当前供托 0，增到 3000，指定 P东 承担 → P东扣3000，供托3000，总分守恒
  const kRes = window.eval(`(function(){
    const g = Rules.createGame(4, { dealerName: '东' });
    g.players.forEach((p, i) => { p.name = p.seat; p.points = 25000 + i; }); // 东25000/南25001/西25002/北25003，总100006
    const sum0 = g.players.reduce((s, p) => s + p.points, 0) + g.kyotaku;
    const r = Rules.adjustKyotaku(g, 3000, '东');
    const sum1 = g.players.reduce((s, p) => s + p.points, 0) + g.kyotaku;
    const east = g.players.find((p) => p.name === '东');
    return { ok: r.ok, kyotaku: g.kyotaku, east: east.points, conserve: sum0 === sum1 };
  })()`);
  assert(kRes.ok === true && kRes.kyotaku === 3000, '供托增加至3000成功');
  assert(kRes.east === 22000, '增加供托：P东(初25000)补缴3000 → 22000');
  assert(kRes.conserve === true, '增加供托后场上总分守恒(仍100006)');
  // 减少供托：先增至3000，再从3000减到0，P南 取回 3000
  const kRes2 = window.eval(`(function(){
    const g = Rules.createGame(4, { dealerName: '东' });
    g.players.forEach((p, i) => { p.name = p.seat; p.points = 25000 + i; }); // 总100006
    Rules.adjustKyotaku(g, 3000, '东');   // 东25000→22000，供托3000
    const sumBefore = g.players.reduce((s, p) => s + p.points, 0) + g.kyotaku;
    const r = Rules.adjustKyotaku(g, 0, '南'); // 南25001→28001，供托0
    const sumAfter = g.players.reduce((s, p) => s + p.points, 0) + g.kyotaku;
    const nan = g.players.find((p) => p.name === '南');
    return { ok: r.ok, kyotaku: g.kyotaku, nan: nan.points, conserve: sumBefore === sumAfter && sumAfter === 100006 };
  })()`);
  assert(kRes2.kyotaku === 0, '供托减少至0成功');
  assert(kRes2.nan === 28001, '减少供托：P南(初25001)取回3000 → 28001');
  assert(kRes2.conserve === true, '减少供托后场上总分仍守恒(100006)');

  // DOM 端到端：当前对局改供托
  // 先制造供托：P东 立直(1000入池)
  document.getElementById('btn-riichi').click();
  document.querySelectorAll('#riichi-pick .p')[0].click();
  const kyotakuBefore = parseInt(document.getElementById('center-kyotaku').textContent.replace(/[^0-9]/g, ''), 10);
  assert(kyotakuBefore === 1000, '立直后供托=1000');
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-kyotaku').click();
  assert(document.getElementById('modal-adjust-kyotaku').classList.contains('show'), '「修正供托点」弹窗打开');
  assert(document.getElementById('adjust-kyotaku-payer').options.length >= 3, '供托面板含玩家下拉(承担差额)');
  // 快速 +1000 按钮：1000→2000
  document.getElementById('btn-kyotaku-plus').click();
  assert(document.getElementById('adjust-kyotaku-value').value === '2000', '点 +1000 快捷按钮：1000→2000（实际=' + document.getElementById('adjust-kyotaku-value').value + '）');
  // 直接填 2500
  document.getElementById('adjust-kyotaku-value').value = '2500';
  // 记录承担玩家(当前第0项)改前分数
  const payerName0 = document.getElementById('adjust-kyotaku-payer').value;
  const payerPtBefore = parseInt(document.getElementById('adjust-kyotaku-payer').selectedOptions[0].textContent.match(/\d+/)[0], 10);
  document.getElementById('btn-kyotaku-confirm').click();
  assert(document.getElementById('modal-adjust-kyotaku').classList.contains('show') === false, '确认后供托弹窗关闭');
  assert(document.getElementById('center-kyotaku').textContent.includes('2500'), '供托更新为2500: ' + document.getElementById('center-kyotaku').textContent);
  // 承担玩家分数应减少 1500（2500-1000），守恒
  const payerAfterSeat = Array.from(document.querySelectorAll('#table-seats .seat')).find((s) => s.querySelector('.name').textContent === payerName0);
  const payerPtAfter = parseInt(payerAfterSeat.querySelector('.pts').textContent, 10);
  assert(payerPtAfter === payerPtBefore - 1500, `供托+1500：承担玩家${payerName0}扣1500分（${payerPtBefore}→${payerPtAfter}）`);

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
