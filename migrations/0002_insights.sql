-- Richer scan data, action-plan support, change log, checklist and schedules.
ALTER TABLE points ADD COLUMN ranks TEXT; -- JSON array of listing keys in rank order (top 20)

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
