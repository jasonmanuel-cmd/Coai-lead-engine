// api/cron-nightops.js — nightly lead harvest for Night Ops.
//
// Vercel Cron calls this at 08:30 UTC (12:30 AM PST / 1:30 AM PDT), ahead of the
// Night Ops routine at 1:43 AM Pacific. It pulls tonight's rotation group from
// Google Maps and writes it to the Night Ops database, where the routine reads
// it over its database connector. No key ever goes in the routine's prompt.
//
// Auth: Vercel's CRON_SECRET pattern (lib/cron-auth.js). Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; unset secret = every call refused.
// Manual run: same header, optional ?group=trades|beauty|pro|food to override.
//
// Env: CRON_SECRET, GOOGLE_PLACES_API_KEY, NIGHTOPS_DATABASE_URL,
//      NIGHTOPS_MAX_DETAILS (optional; can only lower the 250 ceiling).

const { isCronAuthorized } = require('../lib/cron-auth');
const N = require('../lib/nightops');

const MAX_DURATION_S = 300;
const TIME_BUDGET_MS = 240 * 1000; // stop paying for details with a minute to spare

module.exports = async function handler(req, res) {
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing GOOGLE_PLACES_API_KEY' });
  if (!process.env.NIGHTOPS_DATABASE_URL) {
    return res.status(500).json({ error: 'Missing NIGHTOPS_DATABASE_URL' });
  }

  const started = Date.now();
  const nightDate = N.pacificDate(new Date(started));
  const override = req.query && req.query.group;
  if (override && !N.ROTATION.includes(override)) {
    return res.status(400).json({ error: `group must be one of ${N.ROTATION.join(', ')}` });
  }
  const group = override || N.groupForNight(nightDate);

  try {
    const summary = await N.runNight(
      {
        fetchJson: N.fetchJson,
        query: N.nightopsQuery,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
      },
      {
        apiKey,
        nightDate,
        group,
        maxDetails: N.maxDetails(),
        deadlineMs: started + TIME_BUDGET_MS,
      }
    );
    const code = summary.status === 'failed' ? 502 : 200;
    return res.status(code).json(summary);
  } catch (err) {
    console.error('cron-nightops error:', err);
    return res.status(500).json({ error: 'Night Ops harvest failed.', night_date: nightDate, group });
  }
};

module.exports.config = { maxDuration: MAX_DURATION_S };
