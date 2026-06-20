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
const chat = require('./chat');
const QRCode = require('qrcode');

// 把展商輸入的單一語言字串包成多語結構(暫以同值填四語,日後可翻譯)
const mono = v => { const s = (v == null ? '' : String(v)); return { tc: s, sc: s, ja: s, en: s }; };
const csvCell = v => { const s = (v == null ? '' : String(v)).replace(/"/g, '""'); return `"${s}"`; };

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
    `SELECT id, exhibitor_id, name, consumer, b2b, admin_meta, reviewed, open_l1, open_l2, status, submitted_by, field_note
       FROM products ORDER BY (status='pending') DESC, id`);
  const out = [];
  for (const row of r.rows) {
    const g = await db.query(`SELECT client_id FROM grants WHERE product_id=$1 ORDER BY client_id`, [row.id]);
    out.push(S.productAdmin(row, g.rows.map(x => x.client_id)));
  }
  res.json(out);
});

// ---------- 管理人:審核展商送出的商品(核可 / 退回 + 現場備註) ----------
app.post('/api/admin/products/:id/:action', A.requireAuth('admin'), async (req, res) => {
  const { id, action } = req.params;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'bad_action' });
  const note = (req.body && req.body.fieldNote) || null;
  if (action === 'approve') {
    await db.query(`UPDATE products SET status='approved', reviewed=true, open_l1=true, open_l2=true, field_note=$2 WHERE id=$1`,
      [id, note ? JSON.stringify(note) : null]);
  } else {
    await db.query(`UPDATE products SET status='rejected', reviewed=false, open_l1=false, open_l2=false, field_note=$2 WHERE id=$1`,
      [id, note ? JSON.stringify(note) : null]);
  }
  await audit(req.auth.uid, 'product_' + action, id, {});
  res.json({ ok: true, status: action === 'approve' ? 'approved' : 'rejected' });
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

// ---------- 機器人問答(依身份權限隔離) ----------
// optionalAuth:有 token 用其身份過濾;無 token 視為匿名(只 L1)。
app.post('/api/chat', A.optionalAuth, async (req, res) => {
  try {
    const { message, lang } = req.body || {};
    const out = await chat.answer(message, req.auth, lang);
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'chat_error' }); }
});

// ---------- 展商:上傳/檢視自己的商品(只見自己,送出後 pending) ----------
app.get('/api/exhibitor/products', A.requireAuth('exhibitor'), async (req, res) => {
  const r = await db.query(
    `SELECT id, name, consumer, b2b, status, field_note FROM products WHERE submitted_by=$1 ORDER BY id DESC`,
    [req.auth.uid]);
  res.json(r.rows.map(S.productExhibitor));
});

app.post('/api/exhibitor/products', A.requireAuth('exhibitor'), async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name_required' });
  // 確保此展商有一筆 exhibitors 紀錄(以使用者 id 衍生)
  const exId = 'u' + req.auth.uid;
  const exists = await db.query(`SELECT 1 FROM exhibitors WHERE id=$1`, [exId]);
  if (!exists.rowCount) {
    const u = await db.query(`SELECT display_name,email FROM users WHERE id=$1`, [req.auth.uid]);
    const nm = (u.rows[0] && (u.rows[0].display_name || u.rows[0].email)) || ('Exhibitor ' + req.auth.uid);
    await db.query(`INSERT INTO exhibitors(id,name,booth,category,reviewed,status) VALUES($1,$2,$3,$4,false,'pending')`,
      [exId, JSON.stringify(mono(nm)), b.booth || '', JSON.stringify(mono(b.category || ''))]);
  }
  const pid = 'p' + Date.now().toString(36);
  const consumer = { image: b.image || '📦', story: mono(b.story), feature: mono(b.feature), origin: mono(b.origin), usage: mono(b.usage), price: mono(b.price), buy: mono(b.buy || '') };
  const b2b = { moq: mono(b.moq), wholesale: mono(b.wholesale), sample: mono(b.sample), exportT: mono(b.exportT), oem: mono(b.oem), adminNote: mono(''), recommend: 0, fit_tw: false, fit_cn: false, follow: false };
  const admin_meta = { verbal: mono(''), attitude: mono(''), risk: mono(''), interested: [] };
  // 送出即 pending,未審核前不對外公開(open_l1/open_l2 = false)
  await db.query(
    `INSERT INTO products(id,exhibitor_id,name,consumer,b2b,admin_meta,reviewed,open_l1,open_l2,status,submitted_by)
     VALUES($1,$2,$3,$4,$5,$6,false,false,false,'pending',$7)`,
    [pid, exId, JSON.stringify(mono(b.name)), JSON.stringify(consumer), JSON.stringify(b2b), JSON.stringify(admin_meta), req.auth.uid]);
  await audit(req.auth.uid, 'product_submit', pid, { exhibitor: exId });
  res.json({ ok: true, id: pid, status: 'pending' });
});

// ---------- 管理人:產生展商專屬 QR Code(SVG + 深連結) ----------
app.get('/api/admin/qr/:exhibitorId', A.requireAuth('admin'), async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}/?role=exhibitor&exh=${encodeURIComponent(req.params.exhibitorId)}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 });
    res.json({ url, svg });
  } catch (e) { res.status(500).json({ error: 'qr_failed' }); }
});

// ---------- 匯出:依身份輸出 CSV(Excel 可開) ----------
function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')); // BOM 讓 Excel 正確顯示中文
}
app.get('/api/admin/export.csv', A.requireAuth('admin'), async (req, res) => {
  const lang = ['tc', 'sc', 'ja', 'en'].includes(req.query.lang) ? req.query.lang : 'tc';
  const r = await db.query(`SELECT id,name,consumer,b2b,admin_meta,status,field_note FROM products ORDER BY id`);
  const head = ['ID', '商品', '狀態', '批發', 'MOQ', '出口', 'OEM', '口頭(L3)', '態度(L3)', '風險(L3)', '有興趣客戶(L3)', '現場備註(L3)'];
  const out = [head];
  for (const p of r.rows) {
    const c = p.b2b || {}, a = p.admin_meta || {}, fn = p.field_note;
    out.push([p.id, (p.name && p.name[lang]) || '', p.status || '', (c.wholesale && c.wholesale[lang]) || '', (c.moq && c.moq[lang]) || '',
      (c.exportT && c.exportT[lang]) || '', (c.oem && c.oem[lang]) || '',
      (a.verbal && a.verbal[lang]) || '', (a.attitude && a.attitude[lang]) || '', (a.risk && a.risk[lang]) || '', (a.interested || []).join(','), (fn && fn[lang]) || '']);
  }
  sendCsv(res, 'admin_products.csv', out);
});
app.get('/api/buyer/export.csv', A.requireAuth('buyer'), async (req, res) => {
  const lang = ['tc', 'sc', 'ja', 'en'].includes(req.query.lang) ? req.query.lang : 'tc';
  const clientId = req.auth.client_id;
  // 只匯出被授權(L4)且已開放(L2)的商品;不含任何 L3 欄位
  const r = await db.query(
    `SELECT p.id,p.name,p.consumer,p.b2b FROM products p JOIN grants g ON g.product_id=p.id
     WHERE g.client_id=$1 AND p.open_l2=true ORDER BY p.id`, [clientId]);
  const head = ['ID', '商品', '批發', 'MOQ', '出口', 'OEM', '樣品', '管理者備註'];
  const out = [head];
  for (const p of r.rows) {
    const c = p.b2b || {};
    out.push([p.id, (p.name && p.name[lang]) || '', (c.wholesale && c.wholesale[lang]) || '', (c.moq && c.moq[lang]) || '',
      (c.exportT && c.exportT[lang]) || '', (c.oem && c.oem[lang]) || '', (c.sample && c.sample[lang]) || '', (c.adminNote && c.adminNote[lang]) || '']);
  }
  sendCsv(res, 'my_products.csv', out);
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
