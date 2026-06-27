/* Compact REC pill that shows active recording count and navigates to the Recordings page. */
(function () {
  const ACTIVE = ['recording', 'moving', 'pending-move'];

  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }

  const pill = el(`<button id="rec-indicator" class="rec-indicator" style="display:none" title="View Recordings">
    ${window.Icons?.record || '●'} <span class="rec-count">0</span></button>`);
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(pill));

  pill.addEventListener('click', () => {
    if (window.app && window.app.navigateTo) {
      window.app.navigateTo('recordings');
    }
  });

  async function refresh() {
    let rows = [];
    try { rows = await window.API.record.list(); } catch { rows = []; }
    const active = rows.filter(r => ACTIVE.includes(r.status));
    pill.style.display = active.length ? 'inline-flex' : 'none';
    pill.querySelector('.rec-count').textContent = active.length;
  }

  window.addEventListener('recordings-changed', refresh);
  document.addEventListener('DOMContentLoaded', () => { refresh(); setInterval(refresh, 10000); });
})();
