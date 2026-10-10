/* 计时器频率探针 · 启动/重置：每 100ms 自增一次，记录起点 */
(function () {
  if (window.__probe && window.__probe.id) clearInterval(window.__probe.id);
  window.__probe = { t0: Date.now(), n: 0, id: null };
  window.__probe.id = setInterval(function () { window.__probe.n++; }, 100);
  return 'probe started';
})()
