// api/stripe-webhook.js — keeps the subscriptions table in sync with Stripe.
//
// Configure in Stripe Dashboard → Developers → Webhooks →
//   URL:      https://coaihq.online/api/stripe-webhook?secret=<STRIPE_WEBHOOK_URL_SECRET>
//   Events:   checkout.session.completed, customer.subscription.updated,
//             customer.subscription.deleted, invoice.payment_failed
//
// Auth: verifies the Stripe signature when the raw body is available;
// otherwise falls back to the ?secret= shared-secret URL (TLS-protected).

const crypto = require('crypto');
const { query } = require('../lib/db');
const { verifyStripeSignature } = require('../lib/saas');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const rawBody = typeof req.body === 'string' ? req.body : null;
    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const urlSecret = process.env.STRIPE_WEBHOOK_URL_SECRET;
    const querySecret = (req.query && req.query.secret) || '';
    const signatureOk = verifyStripeSignature(
      rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
    const urlSecretOk = Boolean(urlSecret && querySecret && querySecret === urlSecret);

    if (!signatureOk && !urlSecretOk) {
      console.error('stripe-webhook: auth failed (signatureOk=%s urlSecretOk=%s). Configure STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_URL_SECRET.',
        signatureOk, urlSecretOk);
      return res.status(400).json({ error: 'Webhook authentication failed.' });
    }

    const type = event && event.type;
    const data = event && event.data && event.data.object;

    if (type === 'checkout.session.completed' && data) {
      let userId = parseInt(data.client_reference_id, 10);
      // Payment-link purchases (buy.stripe.com) have no client_reference_id —
      // fall back to matching the buyer's email to a COAI account.
      const buyerEmail = (data.customer_details && data.customer_details.email) || data.customer_email || null;
      if (!userId && buyerEmail) {
        const byEmail = await query(
          'SELECT id FROM users WHERE email = $1', [String(buyerEmail).trim().toLowerCase()]
        );
        if (byEmail.rows.length) userId = byEmail.rows[0].id;
        else console.warn('stripe-webhook: paid via payment link but no COAI account matches email', buyerEmail);
      }
      if (userId) {
        const plan = (data.metadata && data.metadata.plan) || 'starter';
        await query(
          `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end)
           VALUES ($1, $2, $3, $4, $5, NOW() + interval '1 month')
           ON CONFLICT (user_id) DO UPDATE SET
             stripe_customer_id = $2, stripe_subscription_id = $3,
             plan = $4, status = $5, current_period_end = NOW() + interval '1 month', updated_at = NOW()`,
          [userId, data.customer, data.subscription, plan, 'active']
        );
        await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [data.customer, userId]);
      }
    }

    if ((type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') && data) {
      const status = type === 'customer.subscription.deleted' ? 'canceled' : data.status;
      const plan = (data.metadata && data.metadata.plan) || null;
      const periodEnd = data.current_period_end ? new Date(data.current_period_end * 1000) : null;
      await query(
        `UPDATE subscriptions SET status = $1,
             plan = COALESCE($2, plan),
             current_period_end = COALESCE($3, current_period_end),
             stripe_customer_id = COALESCE($4, stripe_customer_id),
             updated_at = NOW()
         WHERE stripe_subscription_id = $5
            OR (stripe_subscription_id IS NULL AND user_id = $6)`,
        [status, plan, periodEnd, data.customer, data.id,
         parseInt(data.metadata && data.metadata.user_id, 10) || 0]
      );
    }

    if (type === 'invoice.payment_failed' && data) {
      await query(
        `UPDATE subscriptions SET status = 'past_due', updated_at = NOW()
         WHERE stripe_customer_id = $1`,
        [data.customer]
      );
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('stripe-webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
};
