// api/cron-nightops-contacts.js — find emails and contact forms for tonight's
// new leads, after the harvest and before the Night Ops routine reads them.
//
// Vercel Cron: 08:30 UTC (12:30 AM PST / 1:30 AM PDT), 15 minutes after the
// harvest. Reads each lead's own website only: no Google calls, no browser,
// nothing submitted. Resumable: a lead is checked once, so a re-run picks up
// whatever the last run didn't reach.
//
// Auth: CRON_SECRET (Vercel Cron) or NIGHTOPS_RUN_SECRET. Manual run options:
// ?night=YYYY-MM-DD (default: tonight, Pacific) and ?limit=N (default 150).

const N = require('../lib/nightops');
const C = require('../lib/nightops-contacts');

const TIME_BUDGET_MS = 240 * 1000;

module.exports = async function handler(req, res) {
  if (!N.isNightopsAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.NIGHTOPS_DATABASE_URL) {
    return res.status(500).json({ error: 'Missing NIGHTOPS_DATABASE_URL' });
  }
  const started = Date.now();
  const q = req.query || {};
  const nightDate = q.night || N.pacificDate(new Date(started));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nightDate)) return res.status(400).json({ error: 'night must be YYYY-MM-DD' });
  const limit = q.limit === undefined ? 150 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 300) {
    return res.status(400).json({ error: 'limit must be 1-300' });
  }

  try {
    for (const stmt of N.schemaStatements()) await N.nightopsQuery(stmt);
    const stats = await C.runContacts(
      { query: N.nightopsQuery, getPage: (u) => C.fetchPage(u), now: () => Date.now() },
      { nightDate, limit, deadlineMs: started + TIME_BUDGET_MS }
    );
    return res.status(200).json(stats);
  } catch (err) {
    console.error('cron-nightops-contacts error:', err);
    return res.status(500).json({ error: 'Contact finding failed.', night_date: nightDate });
  }
};

module.exports.config = { maxDuration: 300 };
