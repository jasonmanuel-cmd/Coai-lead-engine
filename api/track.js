// api/track.js — free self-hosted pageview analytics
//   POST { path, ref, utm }       → record a pageview (public, silent, never throws)
//   GET  (owner APP_PASSWORD auth) → analytics summary for the owner, including the
//                                    signup → checkout → upgrade funnel and sources
//
// Admin usage: GET /api/track with header  Authorization: <APP_PASSWORD>

const { query } = require('../lib/db');
const { funnelSummary, cleanUtm } = require('../lib/events');

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS pageviews (
      id BIGSERIAL PRIMARY KEY,
      path TEXT NOT NULL DEFAULT '/',
      ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE pageviews ADD COLUMN IF NOT EXISTS utm_source TEXT;
    ALTER TABLE pageviews ADD COLUMN IF NOT EXISTS utm_medium TEXT;
    ALTER TABLE pageviews ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
  `);
  tableReady = true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || 'https://coaihq.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST — record a pageview (best-effort; never blocks or errors loudly)
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const path = String(body.path || '/').slice(0, 200);
      const ref = String(body.ref || '').slice(0, 500) || null;
      const utm = cleanUtm(body.utm);
      await ensureTable();
      await query(
        'INSERT INTO pageviews (path, ref, utm_source, utm_medium, utm_campaign) VALUES ($1, $2, $3, $4, $5)',
        [path, ref, utm.utm_source || null, utm.utm_medium || null, utm.utm_campaign || null]
      );
      return res.status(204).end();
    } catch (error) {
      console.error('track error:', error.message);
      return res.status(204).end(); // analytics must never break the page
    }
  }

  // GET — owner-only analytics summary
  if (req.method === 'GET') {
    const saas = require('../lib/saas');
    const caller = await saas.resolveCaller(req);
    if (!caller || !caller.admin) {
      return res.status(401).json({ error: 'Owner key required.' });
    }
    try {
      await ensureTable();
      const [today, week, month, total, byPath, byRef, daily, visitsBySource, funnel] = await Promise.all([
        query('SELECT COUNT(*)::int AS n FROM pageviews WHERE created_at >= CURRENT_DATE'),
        query('SELECT COUNT(*)::int AS n FROM pageviews WHERE created_at >= NOW() - interval \'7 days\''),
        query('SELECT COUNT(*)::int AS n FROM pageviews WHERE created_at >= NOW() - interval \'30 days\''),
        query('SELECT COUNT(*)::int AS n FROM pageviews'),
        query('SELECT path, COUNT(*)::int AS n FROM pageviews WHERE created_at >= NOW() - interval \'30 days\' GROUP BY path ORDER BY n DESC LIMIT 10'),
        query('SELECT COALESCE(NULLIF(ref, \'\'), \'(direct)\') AS ref, COUNT(*)::int AS n FROM pageviews WHERE created_at >= NOW() - interval \'30 days\' GROUP BY ref ORDER BY n DESC LIMIT 10'),
        query('SELECT TO_CHAR(DATE(created_at), \'YYYY-MM-DD\') AS d, COUNT(*)::int AS n FROM pageviews WHERE created_at >= NOW() - interval \'14 days\' GROUP BY d ORDER BY d'),
        query('SELECT COALESCE(utm_source, \'(none)\') AS source, COUNT(*)::int AS n FROM pageviews WHERE created_at >= NOW() - interval \'30 days\' GROUP BY 1 ORDER BY n DESC LIMIT 10'),
        funnelSummary(),
      ]);
      // Join visits onto the signup/upgrade rows so each source reads visits → signups → upgrades
      const visits = Object.fromEntries(visitsBySource.rows.map((r) => [r.source, r.n]));
      const sources = new Map(funnel.bySource30d.map((r) => [r.source, { ...r, visits: visits[r.source] || 0 }]));
      for (const [source, n] of Object.entries(visits)) {
        if (!sources.has(source)) sources.set(source, { source, visits: n, signups: 0, upgrades: 0 });
      }
      return res.status(200).json({
        today: today.rows[0].n,
        last7days: week.rows[0].n,
        last30days: month.rows[0].n,
        allTime: total.rows[0].n,
        topPages30d: byPath.rows,
        topReferrers30d: byRef.rows,
        dailyLast14: daily.rows,
        funnel: funnel.funnel,
        sources30d: [...sources.values()]
          .sort((a, b) => b.upgrades - a.upgrades || b.signups - a.signups || b.visits - a.visits)
          .slice(0, 10),
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
