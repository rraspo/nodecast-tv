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

  async function refresh() {
    let data;
    try { data = await window.API.sources.connections(); } catch { return; }

    const b = getBadge();
    if (!b) return;

    const { totalActive, totalMax, sources = [] } = data || {};
    // Nothing to show if there are no Xtream sources reporting a max.
    if (!sources.length || !totalMax) {
      b.style.display = 'none';
      return;
    }

    b.textContent = `⇄ ${totalActive}/${totalMax}`;
    b.style.display = '';
    // Amber when one slot left, red when at/over the limit.
    b.classList.toggle('conn-badge--full', totalActive >= totalMax);
    b.classList.toggle('conn-badge--warn', totalActive === totalMax - 1);

    // Per-source breakdown in the tooltip.
    b.title = sources.map(s => {
      if (s.error) return `${s.name}: error (${s.error})`;
      return `${s.name}: ${s.active ?? '?'}/${s.max ?? '?'}`;
    }).join('\n');
  }

  // Re-check when recordings change (start/stop alters connection count),
  // and poll on an interval to catch playback/external changes.
  window.addEventListener('recordings-changed', refresh);
  document.addEventListener('DOMContentLoaded', () => { refresh(); setInterval(refresh, 15000); });
})();
