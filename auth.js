// ============================================================
// 身份驗證:bcrypt 密碼雜湊 + JWT 權杖 + 角色/狀態中介層
// ============================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = '12h';

async function hashPassword(pw) { return bcrypt.hash(pw, 10); }
async function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }

function signToken(u) {
  // 權杖只放身分必要欄位;敏感資料一律由後端依此 token 過濾
  return jwt.sign(
    { uid: u.id, role: u.role, client_id: u.client_id || null, status: u.status },
    SECRET, { expiresIn: TOKEN_TTL }
  );
}

function readToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try { return jwt.verify(m[1], SECRET); } catch { return null; }
}

// 可選身分:有 token 就解析,沒有就匿名(消費者層)
function optionalAuth(req, res, next) {
  req.auth = readToken(req); // null = 匿名
  next();
}

// 必須登入且已核可
function requireAuth(...roles) {
  return (req, res, next) => {
    const a = readToken(req);
    if (!a) return res.status(401).json({ error: 'unauthorized' });
    if (a.status !== 'approved') return res.status(403).json({ error: 'account_not_approved' });
    if (roles.length && !roles.includes(a.role)) return res.status(403).json({ error: 'forbidden' });
    req.auth = a;
    next();
  };
}

// ---------- 展場免登入上傳 token ----------
// 管理人簽發一張「展場上傳 token」印在 DM 的 QR 上。展商掃碼即可上傳,
// 不需註冊/登入。token 只授權「上傳」,不能讀取任何 L1~L4 資料。
const UPLOAD_TTL = process.env.UPLOAD_TTL || '180d';
function signUpload(meta) {
  return jwt.sign({ purpose: 'upload', scope: (meta && meta.scope) || 'expo' }, SECRET, { expiresIn: UPLOAD_TTL });
}
// 從 header(Bearer)或 body.token 讀取上傳 token,驗證 purpose
function readUpload(req) {
  let tok = null;
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) tok = m[1];
  if (!tok && req.body && req.body.token) tok = req.body.token;
  if (!tok) return null;
  try { const p = jwt.verify(tok, SECRET); return p.purpose === 'upload' ? p : null; } catch { return null; }
}

module.exports = { hashPassword, verifyPassword, signToken, optionalAuth, requireAuth, signUpload, readUpload, SECRET };
