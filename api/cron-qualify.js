// api/cron-qualify.js — hourly lead qualification orchestrator
const { query, initSchema } = require('../lib/db');
const { isCronAuthorized } = require('../lib/cron-auth');

// A lower audit score means a weaker site, i.e. a better prospect for our services.
// Leads with no website at all are the best prospects and skip the audit step.
function scoreLead(lead) {
  let score = 0;
  if (!lead.website) score += 40;
  else if (lead.audit_score !== null) score += Math.min(42, Math.max(0, 100 - lead.audit_score) * 0.42);
  if (lead.phone) score += 12;
  if (lead.website || lead.email) score += 10;
  if (lead.rating && Number(lead.rating) >= 4.5) score += 8;
  if (lead.reviews_count && lead.reviews_count >= 10) score += 10;
  return Math.round(score);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await initSchema();
    const leads = (await query(
      `SELECT id, audit_score, rating, reviews_count, phone, website, email, business_status
       FROM leads
       WHERE pipeline_stage = 'discovered' AND (audit_score IS NOT NULL OR website IS NULL)
       ORDER BY created_at ASC LIMIT 20`
    )).rows;

    let qualified = 0;
    for (const lead of leads) {
      const score = scoreLead(lead);
      const ok = score >= 50 && (lead.phone || lead.email) && lead.business_status === 'OPERATIONAL';
      // Non-qualifying leads move to 'audited' so they are not re-scored every hour.
      await query(
        'UPDATE leads SET score = $1, pipeline_stage = $2, updated_at = NOW() WHERE id = $3',
        [score, ok ? 'qualified' : 'audited', lead.id]
      );
      if (ok) qualified++;
    }

    res.status(200).json({ status: 'OK', scored: leads.length, qualified });
  } catch (error) {
    console.error('cron-qualify error:', error);
    res.status(500).json({ error: 'Qualification failed.' });
  }
};
