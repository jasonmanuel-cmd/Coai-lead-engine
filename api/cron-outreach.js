// api/cron-outreach.js — hourly email outreach orchestrator
const { query, initSchema } = require('../lib/db');
const { sendEmail, emailConfigured } = require('../lib/email');
const { isCronAuthorized } = require('../lib/cron-auth');

// CAN-SPAM: identify the sender, give a working opt-out, include a postal address.
function footer() {
  const addr = process.env.OUTREACH_POSTAL_ADDRESS || '';
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || '';
  return `\n\n--\nChaotically Organized AI, LLC${addr ? `\n${addr}` : ''}\nNot interested? Reply "unsubscribe" to ${from} and we will not contact you again.`;
}

const templates = {
  initial: (name, city) =>
    `Hi ${name},\n\nWe specialize in helping local businesses like yours improve their online presence and attract more customers. We've been working with shops in ${city} and would love to discuss how we can help.\n\nWould you be open to a quick 15-minute call?\n\nBest regards`,
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!emailConfigured()) return res.status(500).json({ error: 'EMAIL_USER/EMAIL_PASS not configured.' });

  try {
    await initSchema();
    // Never re-contact anyone who has asked out (outreach_log.status = 'unsubscribed').
    const leads = (await query(
      `SELECT id, name, email, city FROM leads l
       WHERE pipeline_stage = 'qualified' AND email IS NOT NULL AND last_messaged IS NULL
         AND NOT EXISTS (SELECT 1 FROM outreach_log o WHERE lower(o.email) = lower(l.email) AND o.status = 'unsubscribed')
       ORDER BY score DESC LIMIT 10`
    )).rows;

    let sent = 0;
    for (const lead of leads) {
      try {
        await sendEmail({
          to: lead.email,
          subject: `Quick question for ${lead.name}`,
          text: templates.initial(lead.name, lead.city || 'your area') + footer(),
        });
        await query(
          'INSERT INTO outreach_log (lead_id, email, template_name, status) VALUES ($1, $2, $3, $4)',
          [lead.id, lead.email, 'initial', 'sent']
        );
        await query(
          "UPDATE leads SET last_messaged = NOW(), pipeline_stage = 'messaged', updated_at = NOW() WHERE id = $1",
          [lead.id]
        );
        sent++;
      } catch (err) {
        console.error(`Outreach failed for lead ${lead.id}:`, err.message);
      }
    }

    res.status(200).json({ status: 'OK', sent });
  } catch (error) {
    console.error('cron-outreach error:', error);
    res.status(500).json({ error: 'Outreach failed.' });
  }
};
