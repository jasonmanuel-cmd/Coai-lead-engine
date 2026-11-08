// api/cron-audit.js — hourly website audit + contact-email enrichment
const { query, initSchema } = require('../lib/db');
const { isCronAuthorized } = require('../lib/cron-auth');

function baseUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const v = process.env.VERCEL_URL;
  if (v) return /^https?:\/\//.test(v) ? v : `https://${v}`;
  return 'http://localhost:3000';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await initSchema();
    const leads = (await query(
      `SELECT id, website, email FROM leads
       WHERE pipeline_stage = 'discovered' AND website IS NOT NULL AND audit_score IS NULL
       ORDER BY created_at ASC LIMIT 5`
    )).rows;

    let audited = 0;
    let emails = 0;
    for (const lead of leads) {
      try {
        const auditRes = await fetch(
          `${baseUrl()}/api/audit?url=${encodeURIComponent(lead.website)}`,
          { headers: { Authorization: process.env.APP_PASSWORD || '' } }
        );
        const auditData = await auditRes.json();
        if (auditData.status === 'OK' || auditData.status === 'FAILED') {
          // FAILED = unreachable site (score 0) — still a valid, high-opportunity lead.
          await query(
            'UPDATE leads SET audit_score = $1, last_audited = NOW() WHERE id = $2',
            [auditData.score || 0, lead.id]
          );
          audited++;
        }
      } catch (err) {
        console.error(`Audit failed for lead ${lead.id}:`, err.message);
      }

      // Outreach needs an email, which Places never returns — scrape it (HTTP level only: fast).
      if (!lead.email) {
        try {
          const { escalate } = require('./scrape/pipeline/escalation');
          const r = await escalate(lead.website, { respectRobots: true, skipLevels: [2, 3] });
          const found = r.ok && r.data && r.data.email;
          if (found) {
            await query('UPDATE leads SET email = $1 WHERE id = $2', [found, lead.id]);
            emails++;
          }
        } catch (err) {
          console.error(`Email scrape failed for lead ${lead.id}:`, err.message);
        }
      }
    }

    res.status(200).json({ status: 'OK', audited, emailsFound: emails });
  } catch (error) {
    console.error('cron-audit error:', error);
    res.status(500).json({ error: 'Audit failed.' });
  }
};
