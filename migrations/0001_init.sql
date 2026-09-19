-- Cartilla Fenologica — esquema inicial
-- Los ids de muestra/rama/brote/terminal los genera el cliente (uid local),
-- para que la captura offline no dependa del servidor y el sync sea idempotente.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,          -- PBKDF2-SHA256, formato: pbkdf2$<iter>$<salt_b64>$<hash_b64>
  role          TEXT NOT NULL DEFAULT 'evaluador',  -- 'evaluador' | 'admin'
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,          -- hash del token, nunca el token en claro
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS samples (
  id         TEXT PRIMARY KEY,          -- uid generado en el dispositivo
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fundo      TEXT NOT NULL DEFAULT '',
  modulo     TEXT NOT NULL DEFAULT '',
  lote       TEXT NOT NULL DEFAULT '',
  valvula    TEXT NOT NULL DEFAULT '',
  variedad   TEXT NOT NULL DEFAULT '',
  evaluador  TEXT NOT NULL DEFAULT '',
  fecha      TEXT NOT NULL DEFAULT '',  -- ISO yyyy-mm-dd
  codigo     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,          -- reloj logico del cliente; gana el mas reciente
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_samples_user    ON samples(user_id);
CREATE INDEX IF NOT EXISTS idx_samples_updated ON samples(user_id, updated_at);

CREATE TABLE IF NOT EXISTS ramas (
  id        TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  pos       INTEGER NOT NULL DEFAULT 0,
  altura    TEXT NOT NULL DEFAULT '',
  diametro  TEXT NOT NULL DEFAULT '',
  flujo     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ramas_sample ON ramas(sample_id, pos);

CREATE TABLE IF NOT EXISTS brotes (
  id       TEXT PRIMARY KEY,
  rama_id  TEXT NOT NULL REFERENCES ramas(id) ON DELETE CASCADE,
  pos      INTEGER NOT NULL DEFAULT 0,
  altura   TEXT NOT NULL DEFAULT '',
  diametro TEXT NOT NULL DEFAULT '',
  axilas   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_brotes_rama ON brotes(rama_id, pos);

CREATE TABLE IF NOT EXISTS terminales (
  id         TEXT PRIMARY KEY,
  brote_id   TEXT NOT NULL REFERENCES brotes(id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL DEFAULT 0,
  altura     TEXT NOT NULL DEFAULT '',
  diametro   TEXT NOT NULL DEFAULT '',
  axilas     TEXT NOT NULL DEFAULT '',
  flores     TEXT NOT NULL DEFAULT '',
  cuajados   TEXT NOT NULL DEFAULT '',
  verdes     TEXT NOT NULL DEFAULT '',
  envero     TEXT NOT NULL DEFAULT '',
  peduncular TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_terminales_brote ON terminales(brote_id, pos);
