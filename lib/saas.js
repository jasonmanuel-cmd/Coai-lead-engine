// lib/saas.js — COAI Lead Engine SaaS core
// User accounts, sessions, subscriptions, usage metering, Stripe helpers.
// No external deps: uses Node built-in crypto (scrypt) + fetch for Stripe.

const crypto = require('crypto');
const { query } = require('./db');

// ─── PLANS ───────────────────────────────────────────────────────────
const PLANS = {
  starter: { key: 'starter', name: 'Starter', price: 49,  quota: 1500, priceEnv: 'STRIPE_PRICE_STARTER' },
  pro:     { key: 'pro',     name: 'Pro',     price: 99,  quota: 5000, priceEnv: 'STRIPE_PRICE_PRO' },
};
const FREE_QUOTA = 100; // free monthly calls for accounts without an active paid plan

// ─── SCHEMA ──────────────────────────────────────────────────────────
async function initSaaSSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      stripe_customer_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      plan TEXT NOT NULL DEFAULT 'starter',
      status TEXT NOT NULL DEFAULT 'free',
      current_period_end TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id)
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'google_places',
      amount INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
  `);
}

// ─── PASSWORDS (scrypt — Node built-in, no deps) ─────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const candidate = crypto.scryptSync(String(password), salt, 64);
    return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ─── SESSIONS ────────────────────────────────────────────────────────
const SESSION_DAYS = 30;

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expires]);
  return token;
}

async function destroySession(token) {
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
}

function sessionCookie(token) {
  return `coai_session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_DAYS * 86400}`;
}
function clearSessionCookie() {
  return 'coai_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

module.exports = {
  PLANS, FREE_QUOTA, initSaaSSchema, hashPassword, verifyPassword,
  createSession, destroySession, sessionCookie, clearSessionCookie, parseCookies,
};

// ─── ACCOUNT LOOKUP (also exports below are appended) ────────────────
const saas = module.exports;

// Resolves who is calling. Three possibilities:
//   1. Admin/owner — Authorization header matches APP_PASSWORD (master key)
//   2. Logged-in customer — valid coai_session cookie
//   3. Nobody — returns null
saas.resolveCaller = async function (req) {
  const authHeader = req.headers.authorization || '';
  const master = process.env.APP_PASSWORD;

  if (master && authHeader && authHeader === master) {
    return { admin: true, id: 0, email: 'owner', name: 'Owner', plan: 'admin', status: 'admin', quota: Infinity, usage: 0, periodEnd: null };
  }

  const token = saas.parseCookies(req).coai_session;
  if (!token) return null;

  const r = await query(`
    SELECT u.id, u.email, u.name, u.stripe_customer_id,
           s.token
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = $1 AND s.expires_at > NOW()
  `, [token]);
  const row = r.rows[0];
  if (!row) return null;

  // subscription + usage
  const subRes = await query(
    'SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = $1',
    [row.id]
  );
  const sub = subRes.rows[0] || { plan: null, status: 'free', current_period_end: null };

  const usageRes = await query(
    `SELECT COALESCE(SUM(amount), 0) AS used FROM usage_events
     WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [row.id]
  );
  const usage = parseInt(usageRes.rows[0].used, 10) || 0;

  const activeSub = ['active', 'trialing'].includes(sub.status) &&
    (!sub.current_period_end || new Date(sub.current_period_end) > new Date());

  const plan = activeSub && PLANS[sub.plan] ? PLANS[sub.plan] : null;
  const quota = plan ? plan.quota : FREE_QUOTA;

  return {
    admin: false,
    id: row.id,
    email: row.email,
    name: row.name,
    stripeCustomerId: row.stripe_customer_id,
    sessionToken: token,
    plan: plan ? plan.key : 'free',
    planName: plan ? plan.name : 'Free Trial',
    status: activeSub ? sub.status : 'free',
    quota, usage,
    periodEnd: sub.current_period_end,
  };
};

// Gate + meter a metered API call. Returns { ok } or throws {statusCode, body}.
saas.requireMeteredCaller = async function (req) {
  const caller = await saas.resolveCaller(req);
  if (!caller) {
    const err = new Error('Unauthorized: please sign in.');
    err.statusCode = 401;
    throw err;
  }
  if (!caller.admin && caller.usage >= caller.quota) {
    const err = new Error(`Monthly quota reached (${caller.usage}/${caller.quota}). Upgrade your plan to keep scanning.`);
    err.statusCode = 402;
    err.upgrade = true;
    throw err;
  }
  return caller;
};

saas.recordUsage = async function (userId, amount = 1, kind = 'google_places') {
  if (!userId) return;
  await query('INSERT INTO usage_events (user_id, kind, amount) VALUES ($1, $2, $3)', [userId, kind, amount]);
};

// ─── STRIPE (raw REST via fetch — no SDK dependency) ──────────────────
saas.stripeApi = async function (path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { const e = new Error('STRIPE_SECRET_KEY not configured.'); e.statusCode = 500; throw e; }
  const body = new URLSearchParams();
  const flatten = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const keyName = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === 'object' && !Array.isArray(v)) flatten(v, keyName);
      else body.append(keyName, String(v));
    }
  };
  flatten(params || {});
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const data = await resp.json();
  if (data.error) {
    const e = new Error(data.error.message || 'Stripe error');
    e.statusCode = 502;
    throw e;
  }
  return data;
};

// Verifies Stripe's webhook signature when the raw body is available.
saas.verifyStripeSignature = function (rawBody, sigHeader, secret) {
  try {
    if (!sigHeader || !secret || typeof rawBody !== 'string') return false;
    const parts = Object.fromEntries(String(sigHeader).split(',').map(p => p.split('=')));
    if (!parts.t || !parts.v1) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    // Both sides must be decoded as hex (32 bytes each) for timingSafeEqual.
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(parts.v1, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
};
