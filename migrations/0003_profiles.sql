-- Profile comparison: tracked Google profiles (yours and rivals) with daily snapshots.
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
