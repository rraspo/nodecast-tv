/**
 * Recordings Page Controller
 * Lists all recordings with status, allows stopping active ones.
 */

function _recEsc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

class RecordingsPage {
    constructor(app) {
        this.app = app;
        this.list = document.getElementById('recordings-list');
        this.pollInterval = null;
        this.init();
    }

    init() {
        window.addEventListener('recordings-changed', () => {
            if (this.app.currentPage === 'recordings') {
                this._load();
            }
        });
    }

    show() {
        this._load();
        this.pollInterval = setInterval(() => this._load(), 7000);
    }

    hide() {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
    }

    async _load() {
        try {
            const rows = await API.record.list();
            this._render(rows);
        } catch (err) {
            console.error('[Recordings] Error loading recordings:', err);
            if (this.list) {
                this.list.innerHTML = '<div class="empty-state"><p>Error loading recordings.</p></div>';
            }
        }
    }

    _render(rows) {
        if (!this.list) return;

        const ACTIVE = ['recording', 'moving', 'pending-move'];
        const active = rows.filter(r => ACTIVE.includes(r.status));
        const rest = rows.filter(r => !ACTIVE.includes(r.status));
        const sorted = [...active, ...rest];

        if (sorted.length === 0) {
            this.list.innerHTML = '<div class="empty-state"><p>No recordings yet.</p></div>';
            return;
        }

        const row = (r) => {
            const name = _recEsc(r.programme_title || r.channel_name || 'Unknown');
            const status = _recEsc(r.status || '');
            const mode = _recEsc(r.mode || '');
            const created = r.created_at ? new Date(r.created_at).toLocaleString() : '';
            const stopBtn = r.status === 'recording'
                ? `<button class="btn btn-sm rec-stop-btn" data-id="${_recEsc(String(r.id))}">Stop</button>`
                : '';
            const hasChannel = !!(r.source_type && r.channel_id);
            const channelAttrs = hasChannel
                ? ` data-channel-id="${_recEsc(String(r.channel_id))}" data-source-id="${_recEsc(String(r.source_id || ''))}" data-source-type="${_recEsc(r.source_type)}" data-stream-id="${_recEsc(String(r.stream_id || ''))}" title="Open channel"`
                : '';
            return `<div class="rec-row${hasChannel ? ' rec-row-clickable' : ''}"${channelAttrs}>
                <span class="rec-name">${name}</span>
                <span class="rec-badge rec-${status}">${status}</span>
                ${mode ? `<span class="rec-mode">${mode}</span>` : ''}
                ${created ? `<span class="rec-time">${created}</span>` : ''}
                ${stopBtn}
            </div>`;
        };

        this.list.innerHTML = `
            <p class="rec-page-note">Each recording uses one of your IPTV provider's connections.</p>
            <div class="rec-list-inner">${sorted.map(row).join('')}</div>`;

        this.list.querySelectorAll('.rec-stop-btn').forEach(b => {
            b.addEventListener('click', async () => {
                b.disabled = true;
                try {
                    await API.record.stop(b.dataset.id);
                    window.dispatchEvent(new CustomEvent('recordings-changed'));
                } catch (e) {
                    alert(e.message || 'Failed to stop recording');
                    b.disabled = false;
                }
            });
        });

        this.list.querySelectorAll('.rec-row-clickable').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.rec-stop-btn')) return;
                const { channelId, sourceId, sourceType, streamId } = row.dataset;
                try {
                    window.app.navigateTo('live');
                    const cl = window.app && window.app.channelList;
                    if (cl) {
                        cl.selectChannel({ channelId, sourceId, sourceType, streamId });
                    }
                } catch (err) {
                    console.warn('[RecordingsPage] Could not select channel:', err);
                }
            });
        });
    }
}

window.RecordingsPage = RecordingsPage;
