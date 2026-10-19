// api/square-webhook.js — keeps the subscriptions table in sync with Square.
//
// Configure in Square Developer Console → Webhooks → Subscriptions:
//   Notification URL: https://coaihq.online/api/square-webhook?secret=<SQUARE_WEBHOOK_URL_SECRET>
//   Events: subscription.created, subscription.updated (canceled/paused arrive as updates)
//
// Auth: verifies Square's x-square-hmacsha256-signature header (HMAC-SHA256 over
// notificationUrl + rawBody with the signature key) when the raw body is available;
// otherwise falls back to the ?secret= shared-secret URL.

const { query } = require('../lib/db');
const { verifySquareSignature, squareApi } = require('../lib/saas');
const { safeEqual } = require('../lib/cron-auth');

const PLAN_VARIATION_ENV = {
  SQUARE_PLAN_VARIATION_STARTER: 'starter',
  SQUARE_PLAN_VARIATION_PRO: 'pro',
};

function planFromVariation(variationId) {
  if (!variationId) return null;
  for (const [envName, planKey] of Object.entries(PLAN_VARIATION_ENV)) {
    if (process.env[envName] === variationId) return planKey;
  }
  return null;
}

function mapStatus(squareStatus) {
  switch (String(squareStatus || '').toUpperCase()) {
    case 'ACTIVE': return 'active';
    case 'PENDING': return 'trialing';
    default: return 'canceled'; // CANCELED, PAUSED, DEACTIVATED → no active plan
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const rawBody = typeof req.body === 'string' ? req.body : null;
    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const urlSecret = process.env.SQUARE_WEBHOOK_URL_SECRET;
    const querySecret = (req.query && req.query.secret) || '';
    const signatureOk = verifySquareSignature(
      rawBody, req.headers['x-square-hmacsha256-signature'], process.env.SQUARE_SIGNATURE_KEY
    );
    const urlSecretOk = Boolean(urlSecret && querySecret && safeEqual(querySecret, urlSecret));

    if (!signatureOk && !urlSecretOk) {
      console.error('square-webhook: auth failed (signatureOk=%s urlSecretOk=%s)', signatureOk, urlSecretOk);
      return res.status(400).json({ error: 'Webhook authentication failed.' });
    }

    const type = event && event.type;
    const data = event && event.data;
    const sub = data && data.object && (data.object.subscription || data.object);

    if (type && String(type).startsWith('subscription.') && sub && sub.id) {
      const status = mapStatus(sub.status);
      const plan = planFromVariation(sub.plan_variation_id) || 'starter';
      const customerId = sub.customer_id;

      // Resolve the local user by Square customer email (accounts are email-keyed)
      let user = null;
      if (customerId) {
        try {
          const cust = await squareApi('GET', `customers/${encodeURIComponent(customerId)}`);
          if (cust.customer && cust.customer.email_address) {
            const found = await query('SELECT id FROM users WHERE email = $1', [cust.customer.email_address.toLowerCase()]);
            user = found.rows[0] || null;
          }
        } catch (e) {
          console.error('square-webhook: customer lookup failed:', e.message);
        }
      }

      if (user) {
        await query(
          `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end)
           VALUES ($1, $2, $3, $4, $5, NOW() + interval '1 month')
           ON CONFLICT (user_id) DO UPDATE SET
             stripe_customer_id = $2, stripe_subscription_id = $3,
             plan = $4, status = $5, current_period_end = NOW() + interval '1 month', updated_at = NOW()`,
          [user.id, customerId, sub.id, plan, status]
        );
        await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
      } else {
        // Still record by subscription id in case the user row shows up later
        await query(
          `UPDATE subscriptions SET status = $1, plan = $2,
             stripe_customer_id = COALESCE($3, stripe_customer_id),
             current_period_end = NOW() + interval '1 month', updated_at = NOW()
           WHERE stripe_subscription_id = $4`,
          [status, plan, customerId, sub.id]
        );
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('square-webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
};
