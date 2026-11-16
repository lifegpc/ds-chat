CREATE TABLE IF NOT EXISTS session_deepseek_file_refs (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, file_id)
) WITHOUT ROWID;

-- A DeepSeek file can be referenced by sessions belonging to different Access identities
-- when they use the same DeepSeek account, so orphan checks are global by file_id.
CREATE INDEX IF NOT EXISTS session_deepseek_file_refs_by_file
  ON session_deepseek_file_refs (file_id, user_id, session_id);

CREATE TABLE IF NOT EXISTS deepseek_file_cleanup (
  user_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS deepseek_file_cleanup_by_user_created
  ON deepseek_file_cleanup (user_id, created_at, file_id);

-- Backfill file ids from existing sessions once; normal runtime checks use the index above.
INSERT OR IGNORE INTO session_deepseek_file_refs (user_id, session_id, file_id)
SELECT DISTINCT s.user_id, s.id, CAST(json_extract(f.value, '$.serverId') AS TEXT)
FROM sessions s
JOIN json_each(s.data_json, '$.messages') m
JOIN json_each(m.value, '$.files') f
WHERE json_extract(m.value, '$.role') = 'user'
  AND json_type(f.value, '$.serverId') = 'text'
  AND length(json_extract(f.value, '$.serverId')) > 0;
