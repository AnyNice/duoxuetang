// 账号：注册 / 登录 / 会话。密码用 Node 自带 crypto 的 scrypt 加盐哈希，不引新依赖、不存明文。
// 会话是随机令牌 + httpOnly cookie + 服务端 auth_sessions 表（可过期、可吊销）。
// 过渡口径：库里还没有任何用户时，应用照常可用（待认领状态）；第一个注册的用户认领全部无主科目。
const crypto = require('crypto');
const { db, now } = require('./db');

const COOKIE_NAME = 'lsw_session';
const SESSION_DAYS = 30;

// ---------- 密码哈希（scrypt，格式：scrypt$盐hex$哈希hex） ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- 会话令牌 ----------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    token,
    userId,
    now(),
    expires
  );
  return token;
}
function userByToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.id, u.username, u.created_at, u.avatar FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
    )
    .get(token, now());
  if (!row) {
    // 过期令牌顺手清掉
    db.prepare('DELETE FROM auth_sessions WHERE token=? AND expires_at<=?').run(token, now());
    return null;
  }
  return row;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(token);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax`
  );
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function userCount() {
  return db.prepare('SELECT COUNT(*) c FROM users').get().c;
}

// 中间件：把当前登录用户挂到 req.user（没登录就是 null），顺带记下库里有没有用户。
function attachUser(req, res, next) {
  req.user = userByToken(parseCookies(req)[COOKIE_NAME]);
  req.hasUsers = userCount() > 0;
  next();
}

// 中间件：数据接口的门禁。还没人注册（待认领）时放行；一旦有用户，未登录一律 401。
function requireAuth(req, res, next) {
  if (!req.hasUsers || req.user) return next();
  return res.status(401).json({ error: '请先登录。' });
}

// 注册第一个用户时认领全部无主数据（user_id 为空的科目归他，其下实体跟着科目走）。
function claimOrphanSubjects(userId) {
  db.prepare('UPDATE subjects SET user_id=? WHERE user_id IS NULL').run(userId);
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  userCount,
  attachUser,
  requireAuth,
  claimOrphanSubjects,
};
