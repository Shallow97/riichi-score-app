/**
 * local-name-test.js — 回归测试：本机用户名（修复 A / C）
 *
 * 背景（真机冒烟实测）：
 *   A. app.js 建局时执行 `profile = { name: names['南'] || ... }` + Storage.saveProfile，
 *      把"南座那格填的名字"当成本机用户名**永久落盘**：实测把用户已设的「高琦」
 *      改成了牌桌上别人的名字「小明」。这是在悄悄篡改用户资料。
 *   C. 本机名只在建局时 `Net.setName` 一次且不落盘 → 刷新/重开 App 后服务器上
 *      conn.name 变 null，别人被拒时提示退化成"暂时无法操作"（而不是"XXX 正在操作"）。
 *
 * 修复后的口径：
 *   ① 建局**只**负责对局数据，绝不写本机资料（不再出现"高琦→小明"）；
 *   ② 本机名只由用户显式动作产生：「设置名字」按钮、视角锁定（"我就是这家"）；
 *   ③ 一旦产生就落盘 + 每次建立连接自动补报（init 补报 + net.js onopen 重发）。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tests/local-name-test.js
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE_KEY = 'riichi_profile';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}

/** 最小 mock Net：记录 setName 调用，其余按"房主端在线"返回，便于走通建局流程 */
function makeNet() {
  const calls = { setName: [] };
  return {
    __calls: calls,
    init() {}, install() {},
    isOnline: () => true,
    isInRoom: () => true,
    isHost: () => true,
    hasJoined: () => true,
    isLocked: () => false,
    phase: () => 'online',
    amOperator: () => true,
    operatorName: () => null,
    memberName: () => null,
    memberCount: () => 1,
    serverSeq: () => 0,
    lastSyncedState: () => null,
    isHostOffline: () => false,
    setName: (n) => calls.setName.push(n),
    requestAction: (n, cb) => cb(null, true),
    releaseAction() {},
    leaveRoom() {},
    commit: () => Promise.resolve({ ok: true, seq: 1 }),
    endGame: () => true,
    onState() {}, onStatus() {}, onOperator() {}, onGameEnd() {},
  };
}

/** 载入真实 index.html + rules/storage/app.js，并按需预置已保存的本机资料 */
function makeApp(profileName) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (profileName != null) w.localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: profileName }));
  w.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  const net = makeNet();
  w.Net = net;                     // 必须在 app.js 之前挂上（app.js 初始化时会读 window.Net）
  w.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  return { dom, w, doc: w.document, net };
}

/** 走完"模式页 → 开局设置 → 建立对局"，返回本局南座填的名字 */
function createGame(doc, southName) {
  doc.getElementById('mode-4').click();
  doc.getElementById('btn-next-setup').click();
  doc.querySelectorAll('.setup-name').forEach((inp) => {
    // 南座故意填一个"看起来像本机名"的值，用来证明它不会再被写成本机资料
    inp.value = inp.dataset.wind === '南' ? southName : ('P' + inp.dataset.wind);
  });
  doc.getElementById('btn-create-game').click();
}

function storedProfile(w) {
  const raw = w.localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function main() {
  // ---------- 用例 1：建局不再篡改已有本机资料（A 核心） ----------
  console.log('\n== 用例 1: 已有本机名「高琦」时建局，资料不被改写 ==');
  {
    const { w, doc, net } = makeApp('高琦');
    assert(net.__calls.setName.indexOf('高琦') >= 0,
      'init() 把已保存的本机名补报给联网层（修复 C：重开 App 后服务器仍拿得到名字）');
    const before = JSON.stringify(storedProfile(w));

    createGame(doc, '小明');   // 南座填「小明」——旧版会把它写成"我"
    await new Promise((r) => setTimeout(r, 30));

    assert(doc.getElementById('page-main').classList.contains('active'), '建局成功进入对局主界面');
    assert(JSON.stringify(storedProfile(w)) === before,
      '建局后本机资料未被改写（仍是 ' + (storedProfile(w) || {}).name + '）；旧版此处变成「小明」');
    assert(storedProfile(w).name === '高琦', '本机名保持「高琦」');
    assert(net.__calls.setName.indexOf('小明') < 0,
      '建局不再把"南座填的名字"当成本机名上报（旧版上报的是「小明」）');
    assert(net.__calls.setName.length === 1,
      '建局全程只在 init 补报过一次名字，没有额外的静默写入');
  }

  // ---------- 用例 2：从未设过名字时，建局也不凭空写一个（A 边界） ----------
  console.log('\n== 用例 2: 从未设置过名字 → 建局不凭空发明一个本机名 ==');
  {
    const { w, doc, net } = makeApp(null);
    assert(storedProfile(w) === null, '初始无本机资料');
    createGame(doc, '小明');
    await new Promise((r) => setTimeout(r, 30));
    assert(doc.getElementById('page-main').classList.contains('active'), '建局成功');
    assert(storedProfile(w) === null,
      '建局后仍未写本机资料（旧版会写入 {name:"小明"} ——把牌桌上别人的名字当成"我"）');
    assert(net.__calls.setName.length === 0, '未设置过名字时不上报任何猜测出来的名字');
  }

  // ---------- 用例 3：「设置名字」= 显式动作 → 立即上报 + 落盘（C 持久化） ----------
  console.log('\n== 用例 3: 「设置名字」显式设置 → 上报并落盘（供重连/重启补报） ==');
  {
    const { w, doc, net } = makeApp(null);
    const input = doc.getElementById('net-name');
    const btn = doc.getElementById('btn-set-name');
    assert(!!input && !!btn, '存在名字输入框与设置按钮');
    input.value = '小红';
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert(net.__calls.setName.indexOf('小红') >= 0, '设置后立即上报联网层 setName("小红")');
    assert((storedProfile(w) || {}).name === '小红', '同时落盘为「本机用户资料」（重启后能补报）');

    // 落盘后的名字在"重开 App"时必须被补报 —— 直接再建一个实例验证
    const again = makeApp('小红');
    assert(again.net.__calls.setName.indexOf('小红') >= 0, '重开 App 后 init() 自动补报「小红」');
  }

  // ---------- 用例 4：预先填过名字 → 输入框回填，不用重输 ----------
  console.log('\n== 用例 4: 已保存的名字回填到输入框 ==');
  {
    const { doc } = makeApp('高琦');
    assert(doc.getElementById('net-name').value === '高琦', '输入框回填已保存的本机名「高琦」');
  }

  // ---------- 用例 5：视角锁定 = 声明"我就是这家" → 作为本机名上报/落盘 ----------
  console.log('\n== 用例 5: 视角锁定同时声明本机身份（对局内唯一的身份入口） ==');
  {
    const { w, doc, net } = makeApp(null);
    createGame(doc, '小明');
    await new Promise((r) => setTimeout(r, 30));
    doc.getElementById('btn-view').click();
    const item = Array.from(doc.querySelectorAll('#view-pick .p'))
      .find((el) => el.querySelector('.name').textContent === '小明');
    assert(!!item, '视角弹窗里能选到「小明」');
    item.click();
    doc.getElementById('btn-view-lock').click();
    await new Promise((r) => setTimeout(r, 10));
    assert(net.__calls.setName.indexOf('小明') >= 0, '视角锁定 → 上报 setName("小明")（别人被挡下会看到是谁在操作）');
    assert((storedProfile(w) || {}).name === '小明', '视角锁定同时落盘本机名');
  }

  console.log('\n====================================');
  console.log('本机用户名（A/C）测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
