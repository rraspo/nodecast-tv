const RECORDINGS_DDL = `
  CREATE TABLE IF NOT EXISTS recording_sessions (
    id TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    programme_title TEXT,
    mode TEXT NOT NULL,              -- program | duration | manual
    status TEXT NOT NULL,            -- recording | moving | pending-move | done | error
    staging_path TEXT NOT NULL,
    save_path TEXT NOT NULL,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    channel_id TEXT,
    source_id TEXT,
    source_type TEXT,
    stream_id TEXT,
    stop_at INTEGER,                 -- scheduled stop epoch ms (null = no schedule)
    duration_ms INTEGER              -- true media duration from ffprobe (null until probed)
  );
  CREATE INDEX IF NOT EXISTS idx_recordings_status ON recording_sessions(status);
`;

const ACTIVE = ['recording', 'moving', 'pending-move'];

function createRecordingsRepo(db) {
  return {
    create(rec) {
      db.prepare(`INSERT INTO recording_sessions
        (id, channel_name, programme_title, mode, status, staging_path, save_path, channel_id, source_id, source_type, stream_id)
        VALUES (@id, @channel_name, @programme_title, @mode, @status, @staging_path, @save_path, @channel_id, @source_id, @source_type, @stream_id)`)
        .run({ programme_title: null, channel_id: null, source_id: null, source_type: null, stream_id: null, ...rec });
      return this.get(rec.id);
    },
    get(id) {
      return db.prepare('SELECT * FROM recording_sessions WHERE id = ?').get(id);
    },
    list() {
      return db.prepare('SELECT * FROM recording_sessions ORDER BY created_at DESC').all();
    },
    listByState(status) {
      return db.prepare('SELECT * FROM recording_sessions WHERE status = ?').all(status);
    },
    countActive() {
      const marks = ACTIVE.map(() => '?').join(',');
      return db.prepare(`SELECT COUNT(*) c FROM recording_sessions WHERE status IN (${marks})`).get(...ACTIVE).c;
    },
    setState(id, status, fields = {}) {
      const sets = ['status = @status'];
      if ('error' in fields) sets.push('error = @error');
      if ('ended_at' in fields) sets.push('ended_at = @ended_at');
      db.prepare(`UPDATE recording_sessions SET ${sets.join(', ')} WHERE id = @id`)
        .run({ id, status, error: fields.error ?? null, ended_at: fields.ended_at ?? null });
    },
    setPaths(id, { staging_path, save_path } = {}) {
      const sets = [];
      const params = { id };
      if (staging_path !== undefined) { sets.push('staging_path = @staging_path'); params.staging_path = staging_path; }
      if (save_path !== undefined) { sets.push('save_path = @save_path'); params.save_path = save_path; }
      if (sets.length === 0) return;
      db.prepare(`UPDATE recording_sessions SET ${sets.join(', ')} WHERE id = @id`).run(params);
    },
    setStopAt(id, stopAtMs) {
      db.prepare('UPDATE recording_sessions SET stop_at = ? WHERE id = ?').run(stopAtMs ?? null, id);
    },
    setDuration(id, durationMs) {
      db.prepare('UPDATE recording_sessions SET duration_ms = ? WHERE id = ?').run(durationMs, id);
    },
  };
}

module.exports = { RECORDINGS_DDL, createRecordingsRepo };
