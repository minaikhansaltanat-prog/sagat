CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  pid TEXT,
  title TEXT,
  price INTEGER,
  lang TEXT,
  name TEXT,
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS leads_status ON leads (status, id DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
