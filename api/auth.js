// api/auth.js — COAI Lead Engine account auth
//   GET                       → who am I (session check)
//   POST { action: 'signup', email, password, name } → create account + session
//   POST { action: 'login',  email, password }        → create session
//   POST { action: 'logout' }                          → destroy session
//   POST { action: 'forgot', email }                   → send password-reset email
//   POST { action: 'reset', token, password }          → set new password + session

const crypto = require('crypto');
const { sendEmail, emailConfigured } = require('../lib/email');
const {
  initSaaSSchema, hashPassword, verifyPassword,
  createSession, destroySession, sessionCookie, clearSessionCookie, parseCookies, resolveCaller,
} = require('../lib/saas');
const { query } = require('../lib/db');

// Lightweight in-memory rate limiter for login/signup (per serverless instance).
// Raises the bar against credential-stuffing and mass fake-account creation.
const _attempts = new Map(); // key -> { count, resetAt }
function rateLimited(key, max = 12, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const rec = _attempts.get(key);
  if (!rec || now > rec.resetAt) {
    _attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  rec.count += 1;
  if (_attempts.size > 5000) _attempts.clear(); // memory safety
  return rec.count > max;
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function json(res, code, body, extraHeaders = {}) {
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  return res.status(code).json(body);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || 'https://coaihq.online');
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
      if (rateLimited(`signup:${clientIp(req)}`, 8)) {
        return json(res, 429, { error: 'Too many signups from this network. Please wait a few minutes and try again.' });
      }
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
      if (rateLimited(`login:${clientIp(req)}:${emailNorm}`, 12)) {
        return json(res, 429, { error: 'Too many login attempts. Please wait a few minutes and try again.' });
      }
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

    if (action === 'forgot') {
      if (rateLimited(`forgot:${clientIp(req)}:${emailNorm}`, 5)) {
        return json(res, 429, { error: 'Too many reset requests. Please wait a few minutes and try again.' });
      }
      // Always respond OK — never reveal whether an email has an account.
      const emailOk = emailNorm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
      if (emailOk) {
        try {
          const found = await query('SELECT id FROM users WHERE email = $1', [emailNorm]);
          if (found.rows.length && emailConfigured()) {
            const userId = found.rows[0].id;
            const token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
            await query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
            await query(
              'INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1, $2, $3)',
              [token, userId, expires]
            );
            const proto = req.headers['x-forwarded-proto'] || 'https';
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'coaihq.online';
            const link = `${proto}://${host}/app?reset=${token}`;
            await sendEmail({
              to: emailNorm,
              subject: 'Reset your COAI Lead Engine password',
              text: `Hi there,\n\nSomeone requested a password reset for your COAI Lead Engine account (${emailNorm}).\n\nSet a new password here (expires in 1 hour):\n${link}\n\nIf you didn't ask for this, just ignore this email — your password stays the same.\n\n— COAI Lead Engine`,
              html: `<p>Hi there,</p><p>Someone requested a password reset for your COAI Lead Engine account (<b>${emailNorm}</b>).</p><p><a href="${link}">Click here to set a new password</a> (link expires in 1 hour).</p><p style="color:#666">If you didn't ask for this, just ignore this email — your password stays the same.</p><p>— COAI Lead Engine</p>`,
            });
          } else if (found.rows.length) {
            console.error('auth/forgot: EMAIL_USER/EMAIL_PASS not configured — cannot send reset email.');
          }
        } catch (e) {
          console.error('auth/forgot error:', e.message);
        }
      }
      return json(res, 200, { ok: true });
    }

    if (action === 'reset') {
      const { token, password: newPassword } = req.body || {};
      if (!token || !newPassword || String(newPassword).length < 8) {
        return json(res, 400, { error: 'A valid reset link and a new 8+ character password are required.' });
      }
      const r = await query(
        'SELECT user_id FROM password_resets WHERE token = $1 AND expires_at > NOW()',
        [String(token)]
      );
      if (!r.rows.length) {
        return json(res, 400, { error: 'This reset link is invalid or has expired. Request a new one below.' });
      }
      const userId = r.rows[0].user_id;
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), userId]);
      await query('DELETE FROM password_resets WHERE user_id = $1', [userId]); // single-use
      const token2 = await createSession(userId); // log them straight in
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token2) });
    }

    return json(res, 400, { error: 'Unknown action. Use signup, login, logout, forgot, or reset.' });
  } catch (error) {
    console.error('auth error:', error);
    return json(res, error.statusCode || 500, { error: error.message || 'Auth error.' });
  }
};
