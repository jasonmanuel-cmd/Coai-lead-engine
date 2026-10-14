// api/billing.js — COAI Lead Engine billing
//   POST { action: 'checkout', plan } → Stripe Checkout URL (subscription)
//   POST { action: 'portal' }          → Stripe billing portal URL (cancel/upgrade/card)
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_STARTER  (price_xxx for $49 Starter — 1,500 calls/mo)
//   STRIPE_PRICE_PRO      (price_xxx for $99 Pro — 5,000 calls/mo)

const { resolveCaller, PLANS, stripeApi } = require('../lib/saas');

function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'coaihq.online';
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const caller = await resolveCaller(req);
    if (!caller) return res.status(401).json({ error: 'Please sign in first.' });
    if (caller.admin) return res.status(403).json({ error: 'Owner key has unlimited access — no plan needed.' });

    const { action, plan } = req.body || {};
    const base = origin(req);

    if (action === 'checkout') {
      const planDef = PLANS[plan];
      if (!planDef) return res.status(400).json({ error: 'Unknown plan. Choose starter or pro.' });
      const priceId = process.env[planDef.priceEnv];
      if (!priceId) {
        return res.status(500).json({ error: `${planDef.priceEnv} not configured in Vercel env vars.` });
      }
      const session = await stripeApi('checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': 1,
        client_reference_id: String(caller.id),
        customer_email: caller.stripeCustomerId ? undefined : caller.email,
        customer: caller.stripeCustomerId || undefined,
        'subscription_data[metadata][user_id]': String(caller.id),
        'subscription_data[metadata][plan]': planDef.key,
        success_url: `${base}/?upgraded=1`,
        cancel_url: `${base}/?canceled=1`,
        allow_promotion_codes: 'true',
      });
      return res.status(200).json({ url: session.url });
    }

    if (action === 'portal') {
      if (!caller.stripeCustomerId) {
        return res.status(400).json({ error: 'No billing account yet — subscribe to a plan first.' });
      }
      const portal = await stripeApi('billing_portal/sessions', {
        customer: caller.stripeCustomerId,
        return_url: base,
      });
      return res.status(200).json({ url: portal.url });
    }

    return res.status(400).json({ error: 'Unknown action. Use checkout or portal.' });
  } catch (error) {
    console.error('billing error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Billing error.' });
  }
};
