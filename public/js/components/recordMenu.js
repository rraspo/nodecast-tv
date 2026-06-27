/**
 * Shared record-menu helper
 * Exposes window.RecordMenu = { open(anchorEl, ctx), start(payload) }
 *
 * ctx shape:
 *   channelName   {string}          - display name for the recording
 *   epgEndMs      {number|null}     - EPG program end time as ms timestamp, or null
 *   programmeTitle {string|null}    - current programme title, or null
 *   resolveUrl    {async function}  - returns the real stream URL (handles Xtream resolution)
 *   channelId     {string|null}     - composite channel ID (e.g. "xtream_3_456")
 *   sourceId      {string|null}     - source ID
 *   sourceType    {string|null}     - "xtream" | "m3u"
 *   streamId      {string|null}     - raw stream ID from provider
 */
window.RecordMenu = {
    /**
     * Build and show the record dropdown anchored to anchorEl.
     * resolveUrl() is called only when the user clicks a menu item, so Xtream URL
     * resolution is deferred and never fires unless the user actually picks an option.
     */
    open(anchorEl, ctx) {
        document.querySelector('.record-menu')?.remove();

        const { channelName, epgEndMs, programmeTitle, resolveUrl, channelId, sourceId, sourceType, streamId } = ctx;

        const menu = document.createElement('div');
        menu.className = 'record-menu';

        const opts = [];
        if (epgEndMs) opts.push('<button data-mode="program">Record this program</button>');
        opts.push('<button data-mode="duration" data-min="60">Record 60 min</button>');
        opts.push('<button data-mode="duration" data-min="120">Record 120 min</button>');
        opts.push('<button data-mode="manual">Record now (manual stop)</button>');
        menu.innerHTML = opts.join('');

        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        // Append to the fullscreen host so menu is visible in fullscreen mode.
        const host = document.fullscreenElement || document.body;
        host.appendChild(menu);

        // Clamp to viewport after measuring rendered size.
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        const top = (rect.bottom + mh > window.innerHeight)
            ? Math.max(8, rect.top - mh)
            : rect.bottom;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8));
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;

        menu.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
            menu.remove();
            let url;
            try {
                url = await resolveUrl();
            } catch (err) {
                alert('Could not resolve stream URL: ' + (err.message || err));
                return;
            }
            if (!url) { alert('No stream URL for this channel'); return; }
            await RecordMenu.start({
                url,
                channelName,
                mode: b.dataset.mode,
                durationMin: b.dataset.min ? parseInt(b.dataset.min, 10) : undefined,
                epgEndMs: b.dataset.mode === 'program' ? epgEndMs : undefined,
                programmeTitle: b.dataset.mode === 'program' ? programmeTitle : undefined,
                channelId: channelId || undefined,
                sourceId: sourceId || undefined,
                sourceType: sourceType || undefined,
                streamId: streamId || undefined,
            });
        }));

        setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    },

    async start(payload) {
        try {
            await API.record.start(payload);
            window.dispatchEvent(new CustomEvent('recordings-changed'));
        } catch (err) {
            alert(err.message || 'Failed to start recording');
        }
    }
};
