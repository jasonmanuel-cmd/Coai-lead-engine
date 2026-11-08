// lib/cron-auth.js — shared auth for the scheduled orchestrator jobs.
// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
// Manual triggers may pass the bare secret or `?secret=`. Fails closed if unset.

const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const q = (req.query && req.query.secret) || '';
  return (header && safeEqual(header, secret)) || (q && safeEqual(q, secret));
}

module.exports = { isCronAuthorized, safeEqual };
