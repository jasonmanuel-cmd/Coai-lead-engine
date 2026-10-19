// api/scrape.js — COAI God-Tier Scraper
// Replaces api/enrich.js with 4-level escalation pipeline
//
// Level 1: impit HTTP with Chrome 120 TLS fingerprinting
// Level 2: Residential proxy via Smartproxy
// Level 3: Puppeteer-extra headless browser with stealth plugin
// Level 4: CAPTCHA solver (Capsolver) — triggered on detection
//
// Environment variables:
//   APP_PASSWORD        — shared auth key
//   PROXY_USERNAME      — Smartproxy/Bright Data username
//   PROXY_PASSWORD      — Smartproxy/Bright Data password
//   CAPSOLVER_API_KEY   — Capsolver API key (optional)

const { escalate } = require('./scrape/pipeline/escalation');
const { isAllowed } = require('./scrape/utils/robots');
const { detectCaptcha } = require('./scrape/transport/captcha');
const { resolveCaller } = require('../lib/saas');
const { assertPublicUrl } = require('../lib/ssrf');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || 'https://coaihq.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await resolveCaller(req);
  if (!caller) {
    return res.status(401).json({ error: 'Unauthorized — please sign in.' });
  }

  const { url, skip_levels } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  try {
    await assertPublicUrl(/^https?:\/\//i.test(url) ? url : 'https://' + url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const skipLevels = skip_levels
    ? String(skip_levels).split(',').map(Number).filter(n => n >= 1 && n <= 3)
    : [];

  const result = await escalate(url, {
    respectRobots: true,
    skipLevels,
  });

  if (!result.ok && result.level >= 4) {
    return res.status(200).json({
      email: null,
      phone: null,
      emails: [],
      phones: [],
      phone_records: [],
      pages_scanned: [],
      extraction_notes: ['All extraction methods exhausted. Website may have strong bot protection.'],
      warnings: result.warnings || [],
      transport: 'exhausted',
    });
  }

  return res.status(200).json({
    ...result.data,
    transport: result.transport || 'unknown',
    level: result.level || 0,
    warnings: result.warnings || [],
  });
};
