CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

-- Covers the session list without reading the session JSON rows.
CREATE INDEX IF NOT EXISTS sessions_by_user_updated
  ON sessions (user_id, updated_at DESC, id DESC, title, created_at);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  api_key_cipher TEXT,
  migration_complete INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS file_objects (
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  deleting INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (content_hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS user_files (
  user_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  PRIMARY KEY (user_id, file_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pending_files (
  user_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS pending_files_by_user_created
  ON pending_files (user_id, created_at, file_id, content_hash, session_id);
CREATE INDEX IF NOT EXISTS pending_files_by_hash
  ON pending_files (content_hash, user_id, file_id);
CREATE INDEX IF NOT EXISTS pending_files_by_session
  ON pending_files (user_id, session_id, file_id, content_hash);

CREATE TABLE IF NOT EXISTS session_file_refs (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, file_id)
) WITHOUT ROWID;

-- Covers lookups for one session, file id, or hash and the orphan reference count.
CREATE INDEX IF NOT EXISTS session_file_refs_by_file
  ON session_file_refs (user_id, file_id, session_id, content_hash);
CREATE INDEX IF NOT EXISTS session_file_refs_by_session
  ON session_file_refs (user_id, session_id, file_id, content_hash);
CREATE INDEX IF NOT EXISTS session_file_refs_by_user_hash
  ON session_file_refs (user_id, content_hash);
CREATE INDEX IF NOT EXISTS session_file_refs_by_hash
  ON session_file_refs (content_hash, user_id, session_id, file_id);

-- The leading hash makes global deduplication and orphan checks covering lookups.
CREATE INDEX IF NOT EXISTS user_files_by_hash
  ON user_files (content_hash, user_id, file_id);
CREATE INDEX IF NOT EXISTS user_files_by_user_hash
  ON user_files (user_id, content_hash);

CREATE TABLE IF NOT EXISTS import_sessions (
  user_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (user_id, import_id, session_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS imports (
  user_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, import_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS imports_by_user_created
  ON imports (user_id, created_at, import_id);

CREATE TABLE IF NOT EXISTS import_file_refs (
  user_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  PRIMARY KEY (user_id, import_id, file_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS import_file_refs_by_hash
  ON import_file_refs (content_hash, user_id, import_id, file_id);
CREATE INDEX IF NOT EXISTS import_file_refs_by_import
  ON import_file_refs (user_id, import_id, file_id, content_hash, mime_type);
