// api/billing.js — COAI Lead Engine billing (Stripe AND Square)
//   POST { action: 'checkout', plan } → hosted checkout URL for the plan
//   POST { action: 'portal' }          → Stripe billing portal URL, or Square cancel-able info
//   POST { action: 'cancel' }          → cancel the caller's Square subscription
//
// Provider is chosen automatically per plan: Stripe price ID if set, else Square plan variation.
//
// Stripe env vars:  STRIPE_SECRET_KEY, STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO
// Square env vars:  SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID,
//                   SQUARE_PLAN_VARIATION_STARTER, SQUARE_PLAN_VARIATION_PRO

const crypto = require('crypto');
const { resolveCaller, PLANS, stripeApi, squareApi, resolvePlanProvider } = require('../lib/saas');

function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'coaihq.online';
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || 'https://coaihq.online');
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

      const providerInfo = resolvePlanProvider(plan);
      if (!providerInfo) {
        return res.status(500).json({
          error: `No payment provider configured for the "${planDef.name}" plan. Set STRIPE_PRICE_${plan.toUpperCase()} (Stripe) or SQUARE_PLAN_VARIATION_${plan.toUpperCase()} (Square) in Vercel env vars.`
        });
      }

      // ── Stripe path ──
      if (providerInfo.provider === 'stripe') {
        const session = await stripeApi('checkout/sessions', {
          mode: 'subscription',
          'line_items[0][price]': providerInfo.ref,
          'line_items[0][quantity]': 1,
          client_reference_id: String(caller.id),
          customer_email: caller.stripeCustomerId ? undefined : caller.email,
          customer: caller.stripeCustomerId || undefined,
          'subscription_data[metadata][user_id]': String(caller.id),
          'subscription_data[metadata][plan]': planDef.key,
          success_url: `${base}/app?upgraded=1`,
          cancel_url: `${base}/app?canceled=1`,
          allow_promotion_codes: 'true',
        });
        return res.status(200).json({ url: session.url, provider: 'stripe' });
      }

      // ── Square path (subscription plan variation → hosted payment link) ──
      const locationId = process.env.SQUARE_LOCATION_ID;
      if (!locationId) {
        return res.status(500).json({ error: 'SQUARE_LOCATION_ID not configured in Vercel env vars.' });
      }
      const link = await squareApi('POST', 'online-checkout/payment-links', {
        idempotency_key: crypto.randomUUID(),
        description: `COAI Lead Engine ${planDef.name} ($${planDef.price}/mo) — ${planDef.quota} scans/mo`,
        order: {
          location_id: locationId,
          line_items: [{ catalog_object_id: providerInfo.ref, quantity: '1' }],
        },
        checkout_options: { ask_for_shipping_address: false },
        pre_populated_data: { email: caller.email },
        payment_note: `COAI ${planDef.name} subscription for ${caller.email}`,
      });
      const url = link.payment_link && link.payment_link.url;
      if (!url) return res.status(502).json({ error: 'Square did not return a checkout URL.' });
      return res.status(200).json({ url, provider: 'square' });
    }

    if (action === 'portal') {
      // Stripe: real self-serve billing portal
      if (caller.subscriptionProvider !== 'square' && caller.stripeCustomerId) {
        const portal = await stripeApi('billing_portal/sessions', {
          customer: caller.stripeCustomerId,
          return_url: base,
        });
        return res.status(200).json({ url: portal.url, provider: 'stripe' });
      }
      // Square: no self-serve portal — offer in-app cancellation instead
      return res.status(200).json({
        provider: 'square',
        message: 'Square billing: you can cancel your subscription below, or contact support.',
        can_cancel: Boolean(caller.subscriptionId && caller.subscriptionProvider === 'square'),
      });
    }

    if (action === 'cancel') {
      if (!caller.subscriptionId || caller.subscriptionProvider !== 'square') {
        return res.status(400).json({ error: 'No Square subscription to cancel (or it is managed by Stripe).' });
      }
      await squareApi('POST', `subscriptions/${encodeURIComponent(caller.subscriptionId)}/cancel`);
      await require('../lib/db').query(
        "UPDATE subscriptions SET status = 'canceled', updated_at = NOW() WHERE user_id = $1",
        [caller.id]
      );
      return res.status(200).json({ ok: true, message: 'Subscription canceled. Your plan stays active until the end of the paid period.' });
    }

    return res.status(400).json({ error: 'Unknown action. Use checkout, portal, or cancel.' });
  } catch (error) {
    console.error('billing error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Billing error.' });
  }
};
