-- Uploaded images and videos. The file itself lives in R2 under r2_key.
CREATE TABLE media (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  duration_s  REAL,
  created_at  INTEGER NOT NULL
);

-- An ordered list of things to show. items is a JSON array; see src/validate.js.
CREATE TABLE playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  items       TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);

-- A screen split into zones, each playing one playlist. zones is a JSON array.
CREATE TABLE layouts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  zones       TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);

-- A TV. Created unclaimed when the player first registers, then claimed from the
-- dashboard by typing the pairing code it shows.
CREATE TABLE screens (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL DEFAULT '',
  token_hash         TEXT NOT NULL UNIQUE,
  pair_code          TEXT UNIQUE,
  claimed            INTEGER NOT NULL DEFAULT 0,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  default_layout_id  TEXT,
  schedule           TEXT NOT NULL DEFAULT '[]',
  reload_nonce       INTEGER NOT NULL DEFAULT 0,
  last_seen          INTEGER,
  player_info        TEXT,
  created_at         INTEGER NOT NULL
);
