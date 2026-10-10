/* 对局主界面 UI 快照：当前页 / 关键按钮可用性 / 操作权 / 顶部文案 */
(function () {
  try {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'missing';
      const s = getComputedStyle(el);
      const t = el.closest('.modal-overlay');
      return (s.display !== 'none' && !el.disabled) ? 'on' : 'off';
    };
    const main = document.getElementById('page-main');
    const overlays = Array.from(document.querySelectorAll('.modal-overlay.show')).map((m) => m.id);
    return JSON.stringify({
      page: (document.querySelector('.page.active') || {}).id,
      openModals: overlays,
      ron: vis('btn-tsumo-ron'),
      riichi: vis('btn-riichi'),
      flow: vis('btn-flow'),
      end: vis('btn-end'),
      amOperator: window.Net ? Net.amOperator() : 'noNet',
      operatorName: window.Net ? Net.operatorName() : 'noNet',
      mainText: main ? main.textContent.replace(/\s+/g, ' ').trim().slice(0, 240) : null
    });
  } catch (e) { return 'ERR ' + e.message; }
})()
