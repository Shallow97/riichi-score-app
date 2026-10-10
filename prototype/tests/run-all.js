/**
 * run-all.js — 批量跑 prototype/tests/ 下的回归测试
 *
 * 用法：
 *   npm test              跑不需要服务器的测试
 *   npm test -- --server  连同需要本地服务器的测试一起跑（会自己拉起 serve.js）
 *
 * 为什么要分两类：
 *   部分测试会真的连 http://127.0.0.1:8765 的 WebSocket。若此时端口没起服务，
 *   客户端会反复重连、进程永不退出，很容易被误判成"定时器泄漏"。
 *   所以默认把它们跳过并明确告知，而不是让 npm test 卡死。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TESTS_DIR = __dirname;
const ROOT = path.resolve(__dirname, '..');
const WITH_SERVER = process.argv.includes('--server');

/** 需要本地 8765 服务在跑的测试 */
const NEEDS_SERVER = new Set([
  'eink-scan-upsert-test.js',
  'host-keepalive-test.js',
  'join-room-test.js',
  'net-integration.js',
  'net-reconnect-lock-test.js',
  'net-test.js',
  'op-lease-test.js',
  'push-qr-test.js',
  'qr-scan-test.js',
  'qrcode-host-test.js',
  'tagpush-image-test.js',
]);

const files = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('-test.js') || f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('tests/ 下没有找到测试脚本');
  process.exit(1);
}

let server = null;

function startServer() {
  return new Promise((resolve) => {
    server = spawn(process.execPath, [path.join(ROOT, 'serve.js')], {
      cwd: ROOT, stdio: 'ignore', detached: false,
    });
    // 留出启动时间；serve.js 监听 8765 是同步的，1s 足够
    setTimeout(() => resolve(server), 1000);
  });
}

function stopServer() {
  if (server && !server.killed) {
    try { server.kill(); } catch (e) { /* 已退出 */ }
  }
}

/**
 * 跑单个测试脚本，收集输出。
 * 用 spawn 而非 spawnSync：部分环境（如 Windows 沙箱）下 cmd.exe 会被占成 EBUSY，
 * shell:true 走不通；spawn 直接 exec node 没有这个问题。
 */
function runTest(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TESTS_DIR, file)], {
      cwd: ROOT, env: process.env,
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); }, 120000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ out, code }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ out: String(e), code: -1 }); });
  });
}

(async () => {
  const skipped = [];
  const ran = [];
  const failed = [];
  let totalPass = 0;

  // 先起服务，再跑需要它的测试（顺序不能反）
  if (WITH_SERVER) { await startServer(); }

  for (const f of files) {
    if (NEEDS_SERVER.has(f) && !WITH_SERVER) { skipped.push(f); continue; }
    process.stdout.write(`\n[36m▶ ${f}[0m\n`);
    const r = await runTest(f);
    const out = r.out || '';
    // 各测试脚本结尾格式不统一，兼容 "54 通过，0 失败" / "N 通过, M 失败" 两种
    const m = out.match(/(\d+)\s*通过\s*[,，]\s*(\d+)\s*失败/);
    const pass = m ? Number(m[1]) : 0;
    const fail = m ? Number(m[2]) : (r.code === 0 ? 0 : 1);
    if (fail > 0 || r.code !== 0) {
      failed.push(f);
      console.log(out.trim().split('\n').slice(-25).join('\n'));
    } else {
      ran.push(f);
      totalPass += pass;
      console.log(`[32m  ✓ ${pass} 通过[0m`);
    }
  }

  console.log('\n' + '='.repeat(52));
  console.log(`总计 ${files.length} 个脚本：[32m${ran.length} 通过[0m` +
    (failed.length ? `，[31m${failed.length} 失败[0m` : '') +
    (skipped.length ? `，[33m${skipped.length} 跳过（需服务器）[0m` : '') +
    `，共 ${totalPass} 条断言通过`);
  if (failed.length) {
    console.log('失败：\n  - ' + failed.join('\n  - '));
    console.log('\n提示：net 系列需先起服务，可试 npm test -- --server');
  }
  if (skipped.length && !WITH_SERVER) {
    console.log('跳过（需本地 8765 服务）：\n  - ' + skipped.join('\n  - '));
  }
  console.log('='.repeat(52));

  if (WITH_SERVER) stopServer();
  process.exit(failed.length ? 1 : 0);
})();
