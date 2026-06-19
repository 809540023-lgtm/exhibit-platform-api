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

module.exports = { hashPassword, verifyPassword, signToken, optionalAuth, requireAuth, SECRET };
