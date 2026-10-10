/* 计时器频率探针 · 读数：返回 已过秒数 / 触发次数 / 实测频率（理想 = 10.0/s） */
(function () {
  var p = window.__probe;
  if (!p) return 'probe not started';
  var sec = (Date.now() - p.t0) / 1000;
  return JSON.stringify({
    sec: Math.round(sec),
    ticks: p.n,
    rate: +(p.n / sec).toFixed(2),
    ideal: 10,
    ratio: Math.round((p.n / sec) / 10 * 100) + '%'
  });
})()
