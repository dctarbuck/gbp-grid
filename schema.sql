CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  place_id TEXT,
  cid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  size INTEGER NOT NULL,
  spacing_km REAL NOT NULL,
  zoom INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'demo')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  cost REAL NOT NULL DEFAULT 0,
  share_token TEXT UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS scans_location ON scans (location_id, created_at);

CREATE TABLE IF NOT EXISTS points (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  rank INTEGER,
  top TEXT,
  error TEXT,
  ranks TEXT,
  PRIMARY KEY (scan_id, idx)
);
CREATE INDEX IF NOT EXISTS points_task ON points (task_id);

CREATE TABLE IF NOT EXISTS listings (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  place_id TEXT,
  cid TEXT,
  title TEXT NOT NULL,
  category TEXT,
  categories TEXT,
  rating REAL,
  reviews INTEGER,
  photos INTEGER,
  claimed INTEGER,
  has_hours INTEGER,
  website TEXT,
  phone TEXT,
  lat REAL,
  lng REAL,
  address TEXT,
  PRIMARY KEY (scan_id, key)
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  happened_on TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS changes_location ON changes (location_id, happened_on);

CREATE TABLE IF NOT EXISTS checklist (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (location_id, item)
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  size INTEGER NOT NULL,
  spacing_km REAL NOT NULL,
  zoom INTEGER NOT NULL,
  every_days INTEGER NOT NULL DEFAULT 7,
  next_run TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (next_run);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  place_id TEXT,
  cid TEXT,
  grp TEXT NOT NULL DEFAULT 'Other',
  category TEXT,
  categories TEXT,
  rating REAL,
  reviews INTEGER,
  photos INTEGER,
  claimed INTEGER,
  has_hours INTEGER,
  website TEXT,
  phone TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  desc_len INTEGER,
  source TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS profiles_place ON profiles (place_id);
CREATE INDEX IF NOT EXISTS profiles_cid ON profiles (cid);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  rating REAL,
  reviews INTEGER,
  photos INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  source TEXT,
  PRIMARY KEY (profile_id, day)
);
