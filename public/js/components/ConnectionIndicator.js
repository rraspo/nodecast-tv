/* Active provider-connection badge in the navbar brand: "⇄ 1/3". */
(function () {
  let badge = null;

  function getBadge() {
    if (badge) return badge;
    const brand = document.querySelector('.navbar-brand');
    if (!brand) return null;
    badge = document.createElement('span');
    badge.className = 'conn-badge';
    badge.style.display = 'none';
    brand.appendChild(badge);
    return badge;
  }

  async function isEnabled() {
    try {
      const s = await window.API.settings.get();
      return s.showConnectionBadge !== false;
    } catch {
      return true; // default on if settings unavailable
    }
  }

  async function refresh() {
    const b = getBadge();
    if (!b) return;

    if (!(await isEnabled())) {
      b.style.display = 'none';
      return;
    }

    let data;
    try { data = await window.API.sources.connections(); } catch { return; }

    const sources = (data && data.sources) || [];
    const shown = sources.filter(s => s.max != null || s.error);
    // Connection limits are per-provider, so show each source separately rather
    // than a meaningless cross-provider sum.
    if (!shown.length) {
      b.style.display = 'none';
      return;
    }

    b.style.display = '';
    b.innerHTML = '⇄ ' + shown.map(s => {
      if (s.error) return `<span class="conn-part conn-part--full" title="error">${esc(s.name)} !</span>`;
      const cls = s.active >= s.max ? ' conn-part--full' : (s.active === s.max - 1 ? ' conn-part--warn' : '');
      return `<span class="conn-part${cls}">${esc(s.name)} ${s.active}/${s.max}</span>`;
    }).join('<span class="conn-sep">·</span>');

    b.title = shown.map(s => {
      if (s.error) return `${s.name}: error (${s.error})`;
      return `${s.name}: ${s.active}/${s.max}` + (s.own ? ` (this box: ${s.own})` : '');
    }).join('\n');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Re-check when recordings change (start/stop alters connection count),
  // and poll on an interval to catch playback/external changes.
  window.addEventListener('recordings-changed', refresh);
  window.addEventListener('settings-changed', refresh);
  document.addEventListener('DOMContentLoaded', () => { refresh(); setInterval(refresh, 15000); });
})();
