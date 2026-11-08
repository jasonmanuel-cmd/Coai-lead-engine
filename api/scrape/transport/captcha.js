// Level 4: CAPTCHA solver via Capsolver
// Used as last resort when a target presents Turnstile, reCAPTCHA, or DataDome

let capsolver;

function loadSolver() {
  if (capsolver) return true;
  try {
    capsolver = require('capsolver');
    return true;
  } catch {
    return false;
  }
}

async function solveTurnstile(pageUrl, siteKey) {
  if (!loadSolver()) {
    return { ok: false, error: 'capsolver not available' };
  }

  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'CAPSOLVER_API_KEY not configured' };
  }

  try {
    capsolver.apiKey = apiKey;

    const token = await capsolver.solve({
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: pageUrl,
      websiteKey: siteKey,
    });

    if (!token) {
      return { ok: false, error: 'capsolver returned no token' };
    }

    return { ok: true, token };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function solveRecaptchaV2(pageUrl, siteKey) {
  if (!loadSolver()) {
    return { ok: false, error: 'capsolver not available' };
  }

  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'CAPSOLVER_API_KEY not configured' };
  }

  try {
    capsolver.apiKey = apiKey;

    const token = await capsolver.solve({
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: pageUrl,
      websiteKey: siteKey,
      isInvisible: false,
    });

    if (!token) {
      return { ok: false, error: 'capsolver returned no token' };
    }

    return { ok: true, token };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function detectCaptcha(html) {
  const results = [];

  if (/cf-turnstile/i.test(html) || /turnstile\.render/i.test(html)) {
    const match = html.match(/data-sitekey=["']([^"']+)["']/);
    results.push({ type: 'turnstile', siteKey: match ? match[1] : null });
  }

  if (/g-recaptcha/i.test(html) || /recaptcha\/api\.js/i.test(html)) {
    const match = html.match(/data-sitekey=["']([^"']+)["']/);
    results.push({ type: 'recaptcha_v2', siteKey: match ? match[1] : null });
  }

  if (/dd\.(io|services)|datadome/i.test(html)) {
    results.push({ type: 'datadome' });
  }

  return results;
}

module.exports = { solveTurnstile, solveRecaptchaV2, detectCaptcha };
