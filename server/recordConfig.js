/**
 * Recording configuration, env-driven.
 * Fallbacks are generic container paths only — never deployment-specific.
 */
function int(env, name, def) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function loadRecordConfig(env = process.env) {
  return {
    savePath: env.RECORD_SAVE_PATH || '/recordings',
    stagingPath: env.RECORD_STAGING_PATH || '/staging',
    defaultDurationMin: int(env, 'RECORD_DEFAULT_DURATION_MIN', 120),
    epgPrePadMin: int(env, 'RECORD_EPG_PRE_PAD_MIN', 2),
    epgPostPadMin: int(env, 'RECORD_EPG_POST_PAD_MIN', 5),
    maxConcurrent: int(env, 'RECORD_MAX_CONCURRENT', 1),
  };
}

module.exports = { loadRecordConfig, recordConfig: loadRecordConfig() };
