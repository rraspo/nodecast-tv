/* Active-recording count badge on the Recordings nav link. */
(function () {
  const ACTIVE = ['recording', 'moving', 'pending-move'];

  let badge = null;

  function getBadge() {
    if (badge) return badge;
    const navLink = document.querySelector('.nav-link[data-page="recordings"]');
    if (!navLink) return null;
    badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.style.display = 'none';
    navLink.appendChild(badge);
    return badge;
  }

  async function refresh() {
    let rows = [];
    try { rows = await window.API.record.list(); } catch { rows = []; }
    const active = rows.filter(r => ACTIVE.includes(r.status));
    const b = getBadge();
    if (!b) return;
    if (active.length > 0) {
      b.textContent = active.length;
      b.style.display = '';
    } else {
      b.style.display = 'none';
    }
  }

  window.addEventListener('recordings-changed', refresh);
  document.addEventListener('DOMContentLoaded', () => { refresh(); setInterval(refresh, 10000); });
})();
