/* Self-injecting recording indicator + management panel. */
(function () {
  const ACTIVE = ['recording', 'moving', 'pending-move'];
  let panelOpen = false;

  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  const pill = el(`<button id="rec-indicator" class="rec-indicator" style="display:none" title="Recordings">
    ${window.Icons?.record || '●'} <span class="rec-count">0</span></button>`);
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(pill));

  const panel = el(`<div id="rec-panel" class="rec-panel" style="display:none"></div>`);
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(panel));

  pill.addEventListener('click', () => { panelOpen = !panelOpen; render(); });

  async function refresh() {
    let rows = [];
    try { rows = await window.API.record.list(); } catch { rows = []; }
    const active = rows.filter(r => ACTIVE.includes(r.status));
    pill.style.display = active.length ? 'inline-flex' : 'none';
    pill.querySelector('.rec-count').textContent = active.length;
    window.__recRows = rows;
    if (panelOpen) render(rows);
  }

  function render(rows = window.__recRows || []) {
    panel.style.display = panelOpen ? 'block' : 'none';
    if (!panelOpen) return;
    const item = (r) => `<div class="rec-row">
      <span class="rec-name">${esc(r.programme_title || r.channel_name)}</span>
      <span class="rec-status rec-${r.status}">${r.status}</span>
      ${r.status === 'recording' ? `<button data-stop="${r.id}">Stop</button>` : ''}
    </div>`;
    panel.innerHTML = `<div class="rec-panel-head">Recordings<br>
      <small>Each recording uses one of your IPTV provider's connections.</small></div>
      ${rows.length ? rows.map(item).join('') : '<div class="rec-empty">No recordings</div>'}`;
    panel.querySelectorAll('[data-stop]').forEach(b => b.addEventListener('click', async () => {
      try { await window.API.record.stop(b.dataset.stop); } catch (e) { alert(e.message); }
      refresh();
    }));
  }

  window.addEventListener('recordings-changed', refresh);
  document.addEventListener('DOMContentLoaded', () => { refresh(); setInterval(refresh, 10000); });
})();
