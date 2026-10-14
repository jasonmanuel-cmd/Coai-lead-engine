// api/auth.js — COAI Lead Engine account auth
//   GET                       → who am I (session check)
//   POST { action: 'signup', email, password, name } → create account + session
//   POST { action: 'login',  email, password }        → create session
//   POST { action: 'logout' }                          → destroy session

const {
  initSaaSSchema, hashPassword, verifyPassword,
  createSession, destroySession, sessionCookie, clearSessionCookie, parseCookies, resolveCaller,
} = require('../lib/saas');
const { query } = require('../lib/db');

function json(res, code, body, extraHeaders = {}) {
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  return res.status(code).json(body);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initSaaSSchema();

    // GET → current caller (admin key or logged-in user)
    if (req.method === 'GET') {
      const caller = await resolveCaller(req);
      if (!caller) return json(res, 200, { authenticated: false });
      return json(res, 200, {
        authenticated: true,
        admin: caller.admin,
        email: caller.email,
        name: caller.name || null,
        plan: caller.plan,
        planName: caller.planName,
        status: caller.status,
        usage: caller.usage,
        quota: caller.quota === Infinity ? 'unlimited' : caller.quota,
        periodEnd: caller.periodEnd,
      });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

    const { action, email, password, name } = req.body || {};
    const emailNorm = String(email || '').trim().toLowerCase();

    if (action === 'logout') {
      const token = parseCookies(req).coai_session;
      await destroySession(token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    }

    if (action === 'signup') {
      if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
        return json(res, 400, { error: 'A valid email address is required.' });
      }
      if (!password || String(password).length < 8) {
        return json(res, 400, { error: 'Password must be at least 8 characters.' });
      }
      const existing = await query(
        'SELECT id FROM users WHERE email = $1', [emailNorm]
      );
      if (existing.rows.length) {
        return json(res, 409, { error: 'An account with this email already exists. Try logging in.' });
      }
      const inserted = await query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
        [emailNorm, hashPassword(password), String(name || '').trim() || null]
      );
      const user = inserted.rows[0];
      await query(
        `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'free')
         ON CONFLICT (user_id) DO NOTHING`, [user.id]
      );
      const token = await createSession(user.id);
      return json(res, 201, { ok: true, email: user.email }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (action === 'login') {
      if (!emailNorm || !password) return json(res, 400, { error: 'Email and password are required.' });
      const found = await query(
        'SELECT id, email, name, password_hash FROM users WHERE email = $1', [emailNorm]
      );
      const user = found.rows[0];
      if (!user || !verifyPassword(password, user.password_hash)) {
        return json(res, 401, { error: 'Incorrect email or password.' });
      }
      const token = await createSession(user.id);
      return json(res, 200, { ok: true, email: user.email }, { 'Set-Cookie': sessionCookie(token) });
    }

    return json(res, 400, { error: 'Unknown action. Use signup, login, or logout.' });
  } catch (error) {
    console.error('auth error:', error);
    return json(res, error.statusCode || 500, { error: error.message || 'Auth error.' });
  }
};
