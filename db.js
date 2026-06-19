// ============================================================
// 資料層:正式環境用真 Postgres(DATABASE_URL);
// 本地測試用 pg-mem(記憶體 Postgres),介面相容,跑同一份 SQL。
// ============================================================
const fs = require('fs');
const path = require('path');

let pool;

async function init() {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
    });
  } else {
    // 本地測試:pg-mem
    const { newDb } = require('pg-mem');
    const mem = newDb();
    mem.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
    const pg = mem.adapters.createPg();
    pool = new pg.Pool();
  }
  return pool;
}

async function query(text, params) {
  const p = await init();
  return p.query(text, params);
}

async function migrate() {
  const raw = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const p = await init();
  // 移除行內/整行註解(-- 之後到行尾),再依分號切句逐句執行(pg-mem 不支援多語句一次送)
  const sql = raw.split('\n').map(line => {
    const i = line.indexOf('--');
    return i >= 0 ? line.slice(0, i) : line;
  }).join('\n');
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try { await p.query(stmt); }
    catch (e) { if (!/already exists/i.test(e.message)) throw e; }
  }
}

module.exports = { init, query, migrate };
