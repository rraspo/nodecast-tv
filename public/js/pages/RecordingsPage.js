/**
 * Recordings Page Controller
 * Lists all recordings with status, allows stopping active ones.
 */

function _recEsc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _fmtTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function _fmtCountdown(stopAtMs, nowMs) {
    const rem = Math.max(0, stopAtMs - nowMs);
    const totalSec = Math.round(rem / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function _fmtElapsed(elapsedMs) {
    const totalSec = Math.floor(Math.max(0, elapsedMs) / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Parses a recorded-at timestamp string to epoch ms.
 * Handles both ISO strings (from ended_at, which include T/Z) and SQLite
 * CURRENT_TIMESTAMP strings ("YYYY-MM-DD HH:MM:SS", stored as UTC with no Z).
 */
function _parseRecTime(s) {
    if (!s) return NaN;
    return (s.includes('T') || s.includes('Z'))
        ? new Date(s).getTime()
        : new Date(s.replace(' ', 'T') + 'Z').getTime();
}

// Resolve a HH:MM clock time to the next future epoch ms (today or tomorrow).
function resolveClockToMs(hh, mm, now) {
    const nowMs = now !== undefined ? now : Date.now();
    const d = new Date(nowMs);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.getTime();
}

class RecordingsPage {
    constructor(app) {
        this.app = app;
        this.list = document.getElementById('recordings-list');
        this.pollInterval = null;
        this._countdownInterval = null;
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
        this._countdownInterval = setInterval(() => this._updateCountdowns(), 1000);
    }

    hide() {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
        // Close any open stop-schedule menu
        document.querySelector('.stop-schedule-menu')?.remove();
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

    // Update only the countdown and elapsed text elements — avoids a full re-render every second.
    _updateCountdowns() {
        if (!this.list) return;
        const now = Date.now();
        this.list.querySelectorAll('.rec-countdown').forEach(el => {
            const stopAt = parseInt(el.dataset.stopAt, 10);
            if (!stopAt) return;
            if (stopAt <= now) {
                el.textContent = 'stopping...';
            } else {
                el.textContent = `Stopping at ${_fmtTime(stopAt)} (in ${_fmtCountdown(stopAt, now)})`;
            }
        });
        this.list.querySelectorAll('.rec-elapsed').forEach(el => {
            const startMs = parseInt(el.dataset.startMs, 10);
            if (!startMs) return;
            el.textContent = `● ${_fmtElapsed(now - startMs)}`;
        });
    }

    _openStopMenu(btn, id) {
        document.querySelector('.stop-schedule-menu')?.remove();

        const menu = document.createElement('div');
        menu.className = 'record-menu stop-schedule-menu';
        menu.innerHTML = `
            <button class="sched-stop-now">Stop now</button>
            <button class="sched-stop-min" data-min="15">Stop in 15 min</button>
            <button class="sched-stop-min" data-min="30">Stop in 30 min</button>
            <button class="sched-stop-min" data-min="60">Stop in 60 min</button>
            <div class="sched-custom-row">Stop in <input class="sched-min-input" type="number" min="1" max="1440" placeholder="N" style="width:4em"> min <button class="sched-go-min">Go</button></div>
            <div class="sched-at-row">Stop at <input class="sched-time-input" type="time"> <button class="sched-go-time">Go</button></div>
        `;

        const rect = btn.getBoundingClientRect();
        menu.style.position = 'fixed';
        const host = document.fullscreenElement || document.body;
        host.appendChild(menu);

        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        const top = (rect.bottom + mh > window.innerHeight)
            ? Math.max(8, rect.top - mh)
            : rect.bottom;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8));
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;

        const close = () => menu.remove();

        menu.querySelector('.sched-stop-now').addEventListener('click', async () => {
            close();
            try {
                await API.record.stop(id);
                window.dispatchEvent(new CustomEvent('recordings-changed'));
            } catch (e) { alert(e.message || 'Failed to stop recording'); }
        });

        menu.querySelectorAll('.sched-stop-min').forEach(b => b.addEventListener('click', async () => {
            close();
            const stopAtMs = Date.now() + parseInt(b.dataset.min, 10) * 60000;
            try {
                await API.record.scheduleStop(id, stopAtMs);
                window.dispatchEvent(new CustomEvent('recordings-changed'));
            } catch (e) { alert(e.message || 'Failed to schedule stop'); }
        }));

        menu.querySelector('.sched-go-min').addEventListener('click', async () => {
            const val = parseInt(menu.querySelector('.sched-min-input').value, 10);
            if (!val || val < 1) return;
            close();
            const stopAtMs = Date.now() + val * 60000;
            try {
                await API.record.scheduleStop(id, stopAtMs);
                window.dispatchEvent(new CustomEvent('recordings-changed'));
            } catch (e) { alert(e.message || 'Failed to schedule stop'); }
        });

        menu.querySelector('.sched-go-time').addEventListener('click', async () => {
            const timeVal = menu.querySelector('.sched-time-input').value;
            if (!timeVal) return;
            const [hh, mm] = timeVal.split(':').map(Number);
            close();
            const stopAtMs = resolveClockToMs(hh, mm);
            try {
                await API.record.scheduleStop(id, stopAtMs);
                window.dispatchEvent(new CustomEvent('recordings-changed'));
            } catch (e) { alert(e.message || 'Failed to schedule stop'); }
        });

        // Close on click outside (deferred so the toggle click that opened the menu doesn't immediately close it).
        setTimeout(() => document.addEventListener('click', (e) => {
            if (!menu.contains(e.target)) close();
        }, { once: true }), 0);
    }

    _render(rows) {
        if (!this.list) return;

        const ACTIVE = ['recording', 'moving', 'pending-move'];
        const inProgress = rows.filter(r => ACTIVE.includes(r.status));
        const finished = rows.filter(r => r.status === 'done' && String(r.save_path || '').endsWith('.mkv'));
        const unremuxed = rows.filter(r => r.status === 'done' && String(r.save_path || '').endsWith('.ts'));
        const failed = rows.filter(r => r.status === 'error');

        if (rows.length === 0) {
            this.list.innerHTML = '<div class="empty-state"><p>No recordings yet.</p></div>';
            return;
        }

        const now = Date.now();

        // Shared cell builders.
        const nameOf = (r) => _recEsc(r.programme_title || r.channel_name || 'Unknown');
        const createdOf = (r) => {
            const ms = _parseRecTime(r.created_at);
            return !isNaN(ms) ? `<span class="rec-time">${_recEsc(new Date(ms).toLocaleString())}</span>` : '';
        };
        const lengthOf = (r) => r.duration_ms
            ? `<span class="rec-length">&#9201; ${_fmtElapsed(r.duration_ms)}</span>` : '';
        const modeOf = (r) => r.mode ? `<span class="rec-mode">${_recEsc(r.mode)}</span>` : '';
        const chan = (r) => {
            const hasChannel = !!(r.source_type && r.channel_id);
            return hasChannel
                ? { cls: ' rec-row-clickable', attrs: ` data-channel-id="${_recEsc(String(r.channel_id))}" data-source-id="${_recEsc(String(r.source_id || ''))}" data-source-type="${_recEsc(r.source_type)}" data-stream-id="${_recEsc(String(r.stream_id || ''))}" title="Open channel"` }
                : { cls: '', attrs: '' };
        };

        // In-progress row: live elapsed/countdown + stop controls.
        const progressRow = (r) => {
            const c = chan(r);
            let elapsedHtml = '';
            if (r.status === 'recording' && r.created_at) {
                const startMs = _parseRecTime(r.created_at);
                if (!isNaN(startMs)) {
                    elapsedHtml = `<span class="rec-elapsed" data-elapsed-for="${_recEsc(String(r.id))}" data-start-ms="${startMs}">● ${_fmtElapsed(now - startMs)}</span>`;
                }
            }
            let stopControl = '';
            if (r.status === 'recording') {
                const scheduledFuture = r.stop_at && r.stop_at > now;
                const scheduleInfo = scheduledFuture
                    ? `<span class="rec-countdown" data-stop-at="${_recEsc(String(r.stop_at))}">Stopping at ${_recEsc(_fmtTime(r.stop_at))} (in ${_fmtCountdown(r.stop_at, now)})</span>
                       <button class="btn btn-sm rec-cancel-sched" data-id="${_recEsc(String(r.id))}">Cancel</button>`
                    : '';
                stopControl = `${scheduleInfo}<button class="btn btn-sm rec-stop-toggle" data-id="${_recEsc(String(r.id))}">Stop &#9660;</button>`;
            }
            return `<div class="rec-row${c.cls}"${c.attrs}>
                <span class="rec-name">${nameOf(r)}</span>
                <span class="rec-badge rec-${_recEsc(r.status)}">${_recEsc(r.status)}</span>
                ${elapsedHtml}${lengthOf(r)}${modeOf(r)}${createdOf(r)}${stopControl}
            </div>`;
        };

        // Final recording row (.mkv).
        const finalRow = (r) => {
            const c = chan(r);
            return `<div class="rec-row${c.cls}"${c.attrs}>
                <span class="rec-name">${nameOf(r)}</span>
                ${lengthOf(r)}${modeOf(r)}${createdOf(r)}
            </div>`;
        };

        // Unremuxed (.ts) row, with a per-row remux control.
        const unremuxedRow = (r) => {
            const c = chan(r);
            const id = _recEsc(String(r.id));
            const remuxCtl = r.remuxing
                ? `<span class="rec-remuxing">Remuxing…</span>`
                : `<button class="btn btn-sm rec-remux" data-id="${id}">Remux</button>`;
            return `<div class="rec-row${c.cls}"${c.attrs}>
                <span class="rec-name">${nameOf(r)}</span>
                <span class="rec-badge rec-ts">.ts</span>
                ${lengthOf(r)}${modeOf(r)}${createdOf(r)}${remuxCtl}
            </div>`;
        };

        // Failed row, with an expandable error detail.
        const failedRow = (r) => {
            const id = _recEsc(String(r.id));
            const hasError = !!r.error;
            const detail = hasError
                ? `<button class="btn btn-sm rec-error-toggle" data-id="${id}">Details &#9660;</button>
                   <pre class="rec-error-detail" id="rec-err-${id}" style="display:none">${_recEsc(r.error)}</pre>`
                : '';
            return `<div class="rec-row rec-row-failed">
                <span class="rec-name">${nameOf(r)}</span>
                <span class="rec-badge rec-error">error</span>
                ${modeOf(r)}${createdOf(r)}${detail}
            </div>`;
        };

        const section = (title, items, rowFn, headerExtra = '') => {
            if (!items.length) return '';
            return `<div class="rec-section">
                <h4 class="rec-section-title">${title} <span class="rec-section-count">${items.length}</span>${headerExtra}</h4>
                <div class="rec-list-inner">${items.map(rowFn).join('')}</div>
            </div>`;
        };

        const remuxAllBtn = unremuxed.some(r => !r.remuxing)
            ? `<button class="btn btn-sm rec-remux-all">Remux all</button>` : '';

        this.list.innerHTML = `
            <p class="rec-page-note">Each recording uses one of your IPTV provider's connections.</p>
            ${section('In progress', inProgress, progressRow)}
            ${section('Recordings', finished, finalRow)}
            ${section('Unremuxed (.ts)', unremuxed, unremuxedRow, remuxAllBtn)}
            ${section('Failed', failed, failedRow)}`;

        this.list.querySelectorAll('.rec-remux').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                btn.disabled = true;
                btn.textContent = 'Remuxing…';
                try {
                    await API.record.remux(btn.dataset.id);
                    window.dispatchEvent(new CustomEvent('recordings-changed'));
                } catch (err) {
                    alert(err.message || 'Failed to remux');
                    btn.disabled = false;
                    btn.textContent = 'Remux';
                }
            });
        });

        const remuxAll = this.list.querySelector('.rec-remux-all');
        if (remuxAll) {
            remuxAll.addEventListener('click', async (e) => {
                e.stopPropagation();
                remuxAll.disabled = true;
                remuxAll.textContent = 'Remuxing…';
                try {
                    await API.record.remuxAll();
                    window.dispatchEvent(new CustomEvent('recordings-changed'));
                } catch (err) {
                    alert(err.message || 'Failed to remux');
                    remuxAll.disabled = false;
                    remuxAll.textContent = 'Remux all';
                }
            });
        }

        this.list.querySelectorAll('.rec-error-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pre = document.getElementById(`rec-err-${btn.dataset.id}`);
                if (pre) pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
            });
        });

        this.list.querySelectorAll('.rec-stop-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openStopMenu(btn, btn.dataset.id);
            });
        });

        this.list.querySelectorAll('.rec-cancel-sched').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                btn.disabled = true;
                try {
                    await API.record.scheduleStop(btn.dataset.id, null);
                    window.dispatchEvent(new CustomEvent('recordings-changed'));
                } catch (err) {
                    alert(err.message || 'Failed to cancel schedule');
                    btn.disabled = false;
                }
            });
        });

        this.list.querySelectorAll('.rec-row-clickable').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.rec-stop-toggle, .rec-cancel-sched, .rec-remux, .rec-remux-all, .rec-error-toggle')) return;
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
