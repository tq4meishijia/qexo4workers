-- Qexo-Workers schema. Everything Qexo kept in Django models maps 1:1 here.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_staff      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  name       TEXT PRIMARY KEY,
  content    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_fields (
  name       TEXT PRIMARY KEY,
  content    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Unified index for posts / drafts / pages / config files.
CREATE TABLE IF NOT EXISTS content_index (
  kind         TEXT NOT NULL,            -- post | draft | page | config
  path         TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  filename     TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  status       INTEGER NOT NULL DEFAULT 1,
  date         REAL NOT NULL DEFAULT 0,
  title        TEXT NOT NULL DEFAULT '',
  front_matter TEXT NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, path)
);
CREATE INDEX IF NOT EXISTS idx_content_kind_date ON content_index(kind, date DESC);
CREATE INDEX IF NOT EXISTS idx_content_kind_status ON content_index(kind, status);

CREATE TABLE IF NOT EXISTS images (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  size          TEXT NOT NULL DEFAULT '0',
  date          REAL NOT NULL,
  type          TEXT NOT NULL DEFAULT '',
  delete_config TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_images_date ON images(date DESC);

CREATE TABLE IF NOT EXISTS friends (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  image_url   TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  time        REAL NOT NULL,
  status      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_friends_time ON friends(time);

CREATE TABLE IF NOT EXISTS talks (
  id      TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  tags    TEXT NOT NULL DEFAULT '[]',
  time    REAL NOT NULL,
  likes   TEXT NOT NULL DEFAULT '[]',
  values_ TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_talks_time ON talks(time DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id      TEXT PRIMARY KEY,
  time    REAL NOT NULL,
  label   TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notifications_time ON notifications(time DESC);

CREATE TABLE IF NOT EXISTS stat_uv (
  ip         TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stat_pv (
  url    TEXT PRIMARY KEY,
  number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cache (
  name       TEXT PRIMARY KEY,
  content    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deploy_logs (
  id      TEXT PRIMARY KEY,
  time    REAL NOT NULL,
  target  TEXT NOT NULL DEFAULT '',
  status  INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deploy_time ON deploy_logs(time DESC);
