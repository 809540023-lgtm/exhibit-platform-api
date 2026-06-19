// ============================================================
// 展覽平台後端 — API + 靜態前端
// 權限隔離雙層:① 查詢層不 SELECT 敏感欄位  ② 序列化器白名單
// ============================================================
const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { seed } = require('./seed');
const A = require('./auth');
const S = require('./serializers');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

async function audit(actor, action, target, detail) {
  try { await db.query(`INSERT INTO audit_log(actor,action,target,detail) VALUES($1,$2,$3,$4)`,
    [actor || null, action, target || null, JSON.stringify(detail || {})]); } catch {}
}

// ---------- 公開:展覽 / 展商(非敏感) ----------
app.get('/api/exhibition', async (req, res) => {
  const r = await db.query(`SELECT id,name,date,venue,organizer,scale,status FROM exhibitions LIMIT 1`);
  res.json(r.rows[0] || null);
});

app.get('/api/exhibitors', A.optionalAuth, async (req, res) => {
  const isAdmin = req.auth && req.auth.role === 'admin';
  // 非管理人只拿已核可展商的非敏感欄位
  const r = isAdmin
    ? await db.query(`SELECT id,name,booth,category,reviewed,status FROM exhibitors ORDER BY id`)
    : await db.query(`SELECT id,name,booth,category FROM exhibitors WHERE status='approved' ORDER BY id`);
  res.json(r.rows);
});

// ---------- L1 公開商品(消費者 / 匿名) ----------
// ★ 只 SELECT consumer 區塊;b2b / admin_meta 根本不離開 DB
app.get('/api/products', A.optionalAuth, async (req, res) => {
  const r = await db.query(
    `SELECT id, exhibitor_id, name, consumer FROM products WHERE open_l1 = true ORDER BY id`);
  res.json(r.rows.map(S.productL1));
});

// ---------- L2 B2B 商品(已核可採購商,且僅其被授權 client) ----------
// ★ 只 SELECT 到 b2b;admin_meta 不離開 DB。L4:以 grants 過濾。
app.get('/api/buyer/products', A.requireAuth('buyer'), async (req, res) => {
  const clientId = req.auth.client_id;
  if (!clientId) return res.json([]);
  const r = await db.query(
    `SELECT p.id, p.exhibitor_id, p.name, p.consumer, p.b2b
       FROM products p
       JOIN grants g ON g.product_id = p.id
      WHERE g.client_id = $1 AND p.open_l2 = true
      ORDER BY p.id`, [clientId]);
  res.json(r.rows.map(S.productL2));
});

// ---------- L3 管理人:全部資料 ----------
app.get('/api/admin/products', A.requireAuth('admin'), async (req, res) => {
  const r = await db.query(
    `SELECT id, exhibitor_id, name, consumer, b2b, admin_meta, reviewed, open_l1, open_l2
       FROM products ORDER BY id`);
  const out = [];
  for (const row of r.rows) {
    const g = await db.query(`SELECT client_id FROM grants WHERE product_id=$1 ORDER BY client_id`, [row.id]);
    out.push(S.productAdmin(row, g.rows.map(x => x.client_id)));
  }
  res.json(out);
});

// ---------- 身份驗證 ----------
app.post('/api/auth/register', async (req, res) => {
  const { email, password, role, client_id, display_name, lang } = req.body || {};
  if (!email || !password || !['buyer', 'exhibitor'].includes(role))
    return res.status(400).json({ error: 'invalid_input' });   // admin 不可自助註冊
  if (String(password).length < 8) return res.status(400).json({ error: 'weak_password' });
  const dup = await db.query(`SELECT 1 FROM users WHERE email=$1`, [email]);
  if (dup.rowCount) return res.status(409).json({ error: 'email_taken' });
  const hash = await A.hashPassword(password);
  const r = await db.query(
    `INSERT INTO users(email,password_hash,role,status,client_id,display_name,lang)
     VALUES($1,$2,$3,'pending',$4,$5,$6) RETURNING id`,
    [email, hash, role, client_id || null, display_name || null, lang || 'tc']);
  await audit(null, 'register', 'user:' + r.rows[0].id, { email, role });
  res.json({ status: 'pending', message: '註冊已送出,等待管理人審核核可後即可登入。' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const r = await db.query(`SELECT * FROM users WHERE email=$1`, [email]);
  if (!r.rowCount) return res.status(401).json({ error: 'invalid_credentials' });
  const u = r.rows[0];
  if (!(await A.verifyPassword(password || '', u.password_hash)))
    return res.status(401).json({ error: 'invalid_credentials' });
  if (u.status === 'pending') return res.status(403).json({ error: 'account_not_approved' });
  if (u.status === 'rejected') return res.status(403).json({ error: 'account_rejected' });
  res.json({ token: A.signToken(u), user: S.user(u) });
});

app.get('/api/me', A.requireAuth(), async (req, res) => {
  const r = await db.query(`SELECT * FROM users WHERE id=$1`, [req.auth.uid]);
  res.json(r.rowCount ? S.user(r.rows[0]) : null);
});

// ---------- 管理人:帳號審核 ----------
app.get('/api/admin/users', A.requireAuth('admin'), async (req, res) => {
  const r = await db.query(`SELECT * FROM users ORDER BY created_at DESC`);
  res.json(r.rows.map(S.user));
});
app.post('/api/admin/users/:id/:action', A.requireAuth('admin'), async (req, res) => {
  const { id, action } = req.params;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'bad_action' });
  const status = action === 'approve' ? 'approved' : 'rejected';
  await db.query(`UPDATE users SET status=$1, approved_at=now(), approved_by=$2 WHERE id=$3`,
    [status, req.auth.uid, id]);
  await audit(req.auth.uid, 'user_' + action, 'user:' + id, {});
  res.json({ ok: true, status });
});

// ---------- 管理人:L4 授權開關 ----------
app.post('/api/admin/grants', A.requireAuth('admin'), async (req, res) => {
  const { client_id, product_id, action } = req.body || {};
  if (!client_id || !product_id || !['add', 'remove'].includes(action))
    return res.status(400).json({ error: 'invalid_input' });
  if (action === 'add')
    await db.query(`INSERT INTO grants(client_id,product_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [client_id, product_id, req.auth.uid]);
  else
    await db.query(`DELETE FROM grants WHERE client_id=$1 AND product_id=$2`, [client_id, product_id]);
  await audit(req.auth.uid, 'grant_' + action, product_id, { client_id });
  res.json({ ok: true });
});

// ---------- 管理人:稽核軌跡 ----------
app.get('/api/admin/audit', A.requireAuth('admin'), async (req, res) => {
  const r = await db.query(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200`);
  res.json(r.rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- 靜態前端(僅前端檔,不暴露後端原始碼) ----------
app.get('/i18n.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n.js')));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
  await db.migrate();
  await seed();
  const port = process.env.PORT || 3000;
  return new Promise(resolve => {
    const srv = app.listen(port, () => { console.log('listening on', port); resolve(srv); });
  });
}

module.exports = { app, start };
if (require.main === module) start();
