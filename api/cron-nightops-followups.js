// api/cron-nightops-followups.js — draft follow-ups that are due.
//
// Vercel Cron: 08:40 UTC (12:40 AM PST / 1:40 AM PDT), before the Night Ops
// routine at 1:43 AM Pacific, so its summary can show the drafts. Writes DRAFT
// rows only; nothing here sends email. Auth: CRON_SECRET or NIGHTOPS_RUN_SECRET.

const N = require('../lib/nightops');
const F = require('../lib/nightops-followups');

module.exports = async function handler(req, res) {
  if (!N.isNightopsAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.NIGHTOPS_DATABASE_URL) {
    return res.status(500).json({ error: 'Missing NIGHTOPS_DATABASE_URL' });
  }
  try {
    for (const stmt of N.schemaStatements()) await N.nightopsQuery(stmt);
    return res.status(200).json(await F.runFollowups({ query: N.nightopsQuery }));
  } catch (err) {
    console.error('cron-nightops-followups error:', err);
    return res.status(500).json({ error: 'Follow-up drafting failed.' });
  }
};

module.exports.config = { maxDuration: 60 };
