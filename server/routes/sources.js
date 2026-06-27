const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('../services/xtreamApi');
const syncService = require('../services/syncService');
const m3uParser = require('../services/m3uParser');

// Get all sources
router.get('/', async (req, res) => {
    try {
        const allSources = await sources.getAll();
        // Don't expose passwords in list view
        const sanitized = allSources.map(s => ({
            ...s,
            password: s.password ? '••••••••' : null
        }));
        res.json(sanitized);
    } catch (err) {
        console.error('Error getting sources:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get sync status for all sources
router.get('/status', async (req, res) => {
    try {
        const { getDb } = require('../db/sqlite');
        const db = getDb();
        const statuses = db.prepare('SELECT * FROM sync_status').all();
        res.json(statuses);
    } catch (err) {
        console.error('Error getting sync status:', err);
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// Active provider connections per Xtream source. The provider's active_cons is the
// global truth (sees all devices) but lags; we merge nodecast's OWN in-flight usage
// (active recordings + transcoded playback) so this box's activity shows immediately
// on the correct source. Note: a direct browser->provider playback has no server
// session, so only the provider counter sees it.
const connCache = new Map();
const CONN_TTL_MS = 8000;

function hostOf(u) { try { return new URL(u).host; } catch { return null; } }

// Count connections nodecast itself holds, keyed by source id (as string).
function ownUsageBySource(allSources) {
    const dbSqlite = require('../db/sqlite');
    const transcodeSession = require('../services/transcodeSession');
    const counts = new Map();
    const bump = (id) => counts.set(String(id), (counts.get(String(id)) || 0) + 1);

    const ACTIVE = ['recording', 'moving', 'pending-move'];
    for (const r of dbSqlite.recordings.list()) {
        if (ACTIVE.includes(r.status) && r.source_id != null) bump(r.source_id);
    }
    const sessions = transcodeSession.getAllSessions ? transcodeSession.getAllSessions() : [];
    for (const sess of sessions) {
        const h = hostOf(sess.url);
        if (!h) continue;
        const src = allSources.find(s => hostOf(s.url) === h);
        if (src) bump(src.id);
    }
    return counts;
}

router.get('/connections', async (req, res) => {
    try {
        const all = await sources.getAll();
        const xtreamSources = all.filter(s => s.type === 'xtream' && s.enabled);
        const own = ownUsageBySource(all);

        const results = await Promise.all(xtreamSources.map(async (s) => {
            let cached = connCache.get(s.id);
            if (!cached || Date.now() - cached.ts >= CONN_TTL_MS) {
                let prov;
                try {
                    const auth = await xtreamApi.authenticate(s.url, s.username, s.password);
                    const info = xtreamApi.parseConnectionInfo(auth);
                    prov = { active: info.active, max: info.max };
                } catch (err) {
                    prov = { active: null, max: null, error: err.message };
                }
                cached = { ts: Date.now(), prov };
                connCache.set(s.id, cached);
            }
            const ownN = own.get(String(s.id)) || 0;
            const providerActive = cached.prov.active;
            // Merge: never show fewer than what this box is actually using.
            const active = Math.max(providerActive || 0, ownN);
            return { id: s.id, name: s.name, active, max: cached.prov.max, providerActive, own: ownN, error: cached.prov.error };
        }));

        res.json({ sources: results });
    } catch (err) {
        console.error('Error getting connections:', err);
        res.status(500).json({ error: 'Failed to get connections' });
    }
});

// Get sources by type
router.get('/type/:type', async (req, res) => {
    try {
        const typeSources = await sources.getByType(req.params.type);
        res.json(typeSources);
    } catch (err) {
        console.error('Error getting sources by type:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get single source
router.get('/:id', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }
        res.json(source);
    } catch (err) {
        console.error('Error getting source:', err);
        res.status(500).json({ error: 'Failed to get source' });
    }
});

// Create source
router.post('/', async (req, res) => {
    try {
        const { type, name, url, username, password } = req.body;

        if (!type || !name || !url) {
            return res.status(400).json({ error: 'Type, name, and URL are required' });
        }

        if (!['xtream', 'm3u', 'epg'].includes(type)) {
            return res.status(400).json({ error: 'Invalid source type' });
        }

        const source = await sources.create({ type, name, url, username, password });
        // Trigger Sync
        syncService.syncSource(source.id).catch(console.error);
        res.status(201).json(source);
    } catch (err) {
        console.error('Error creating source:', err);
        res.status(500).json({ error: 'Failed to create source' });
    }
});

// Update source
router.put('/:id', async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        const { name, url, username, password } = req.body;
        const updated = await sources.update(req.params.id, {
            name: name || existing.name,
            url: url || existing.url,
            username: username !== undefined ? username : existing.username,
            password: password !== undefined ? password : existing.password
        });
        // Trigger Sync (if critical fields changed? safely just trigger it)
        syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        res.json(updated);
    } catch (err) {
        console.error('Error updating source:', err);
        res.status(500).json({ error: 'Failed to update source' });
    }
});

// Delete source
router.delete('/:id', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.id);
        const existing = await sources.getById(sourceId);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Cascade delete: Clean up SQLite data for this source
        const db = getDb();
        const deleteCategories = db.prepare('DELETE FROM categories WHERE source_id = ?');
        const deleteItems = db.prepare('DELETE FROM playlist_items WHERE source_id = ?');
        const deleteEpg = db.prepare('DELETE FROM epg_programs WHERE source_id = ?');
        const deleteSyncStatus = db.prepare('DELETE FROM sync_status WHERE source_id = ?');

        const catResult = deleteCategories.run(sourceId);
        const itemResult = deleteItems.run(sourceId);
        const epgResult = deleteEpg.run(sourceId);
        deleteSyncStatus.run(sourceId);

        console.log(`[Source] Cascade delete for source ${sourceId}: ${catResult.changes} categories, ${itemResult.changes} items, ${epgResult.changes} EPG programs`);

        // Delete source config and related hidden items (favorites handled by db.js)
        await sources.delete(sourceId);

        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting source:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// Toggle source enabled/disabled
router.post('/:id/toggle', async (req, res) => {
    try {
        const updated = await sources.toggleEnabled(req.params.id);
        if (!updated) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // If enabled, trigger sync
        if (updated.enabled) {
            syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        }

        res.json(updated);
    } catch (err) {
        console.error('Error toggling source:', err);
        res.status(500).json({ error: 'Failed to toggle source' });
    }
});

// Manual Sync
router.post('/:id/sync', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const source = await sources.getById(id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        // Trigger sync (async)
        syncService.syncSource(id).catch(console.error);

        res.json({ success: true, message: 'Sync started' });
    } catch (err) {
        console.error('Error starting sync:', err);
        res.status(500).json({ error: 'Failed to start sync' });
    }
});

// Test source connection
router.post('/:id/test', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (source.type === 'xtream') {
            const result = await xtreamApi.authenticate(source.url, source.username, source.password);
            res.json({ success: true, data: result });
        } else if (source.type === 'm3u') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('#EXTM3U');
            res.json({ success: isValid, message: isValid ? 'Valid M3U playlist' : 'Invalid M3U format' });
        } else if (source.type === 'epg') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('<tv') || text.includes('<?xml');
            res.json({ success: isValid, message: isValid ? 'Valid EPG XML' : 'Invalid EPG format' });
        }
    } catch (err) {
        console.error('Error testing source:', err);
        res.json({ success: false, error: err.message });
    }
});

// Estimate M3U playlist size (for large playlist warning)
const M3U_LARGE_THRESHOLD = 50000;

// Estimate by URL (for new sources before creation)
router.post('/estimate', async (req, res) => {
    try {
        const { url, type } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Only M3U sources need estimation
        if (type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for URL...`);
        const count = await m3uParser.countEntries(url);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Estimate by source ID (for existing sources)
router.get('/:id/estimate', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Only M3U sources need estimation
        if (source.type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for ${source.name}...`);
        const count = await m3uParser.countEntries(source.url);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Global Sync - sync all enabled sources
router.post('/sync-all', async (req, res) => {
    try {
        // Trigger global sync (async - don't wait for completion)
        syncService.syncAll().catch(console.error);
        res.json({ success: true, message: 'Global sync started' });
    } catch (err) {
        console.error('Error starting global sync:', err);
        res.status(500).json({ error: 'Failed to start global sync' });
    }
});

module.exports = router;

