-- ============================================================
-- 展覽現場資料蒐集與採購媒合平台 — 資料庫 Schema
-- 多語欄位以 JSONB 儲存 {tc,sc,ja,en}
-- 敏感層級(L3/L4)獨立欄位/表,非管理人查詢不 SELECT
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('exhibitor','buyer','admin')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  client_id     TEXT,            -- 採購商對應的客戶代碼(A/B/C);展商可對應 exhibitor_id
  display_name  TEXT,
  lang          TEXT DEFAULT 'tc',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at   TIMESTAMPTZ,
  approved_by   INTEGER
);

CREATE TABLE IF NOT EXISTS exhibitions (
  id         TEXT PRIMARY KEY,
  name       JSONB NOT NULL,
  date       TEXT,
  venue      JSONB,
  organizer  TEXT,
  scale      JSONB,
  status     JSONB
);

CREATE TABLE IF NOT EXISTS exhibitors (
  id         TEXT PRIMARY KEY,
  name       JSONB NOT NULL,
  booth      TEXT,
  category   JSONB,
  reviewed   BOOLEAN DEFAULT false,
  status     TEXT DEFAULT 'approved'  -- pending / approved / rejected
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  exhibitor_id TEXT REFERENCES exhibitors(id),
  name         JSONB NOT NULL,
  consumer     JSONB NOT NULL,   -- L1 公開(image, story, feature, origin, usage, price, buy)
  b2b          JSONB NOT NULL,   -- L2 B2B(moq, wholesale, sample, exportT, oem, adminNote, recommend, fit_tw, fit_cn, follow, unreviewed)
  admin_meta   JSONB NOT NULL,   -- L3 內部(verbal, attitude, risk, interested_buyers)
  reviewed     BOOLEAN DEFAULT false,
  open_l1      BOOLEAN DEFAULT true,   -- 是否開放給消費者
  open_l2      BOOLEAN DEFAULT true    -- 是否開放給 B2B(未審核者預設關)
);

-- L4 指定客戶專屬:哪個客戶(client_id)可看哪個商品
CREATE TABLE IF NOT EXISTS grants (
  client_id  TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  granted_by INTEGER,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, product_id)
);

-- 稽核軌跡:誰在何時對誰開放/關閉了哪筆
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  actor      INTEGER,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grants_client ON grants(client_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Phase③ 擴充:商品送審狀態、送出者、管理人現場備註(L3)
-- 既有 Postgres 第一次 ALTER 會新增,之後重跑會丟「already exists」由 migrate 忽略
ALTER TABLE products ADD COLUMN status TEXT DEFAULT 'approved';
ALTER TABLE products ADD COLUMN submitted_by INTEGER;
ALTER TABLE products ADD COLUMN field_note JSONB;
