// Level 2: TLS-fingerprinted HTTP through residential proxy
// Uses Smartproxy rotating proxies with sticky sessions per domain

const { HttpsProxyAgent } = require('https-proxy-agent');

function getProxyAgent() {
  const username = process.env.PROXY_USERNAME;
  const password = process.env.PROXY_PASSWORD;
  const host = process.env.PROXY_HOST || 'residential.smartproxy.com';
  const port = process.env.PROXY_PORT || '10000';
  if (!username || !password) return null;
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  return new HttpsProxyAgent(proxyUrl);
}

async function fetchViaProxy(url, agent) {
  return fetch(url, {
    agent,
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
}

const PAGES_TO_CHECK = [
  (base) => base,
  (base) => base.replace(/\/$/, '') + '/contact',
  (base) => base.replace(/\/$/, '') + '/contact-us',
  (base) => base.replace(/\/$/, '') + '/about',
  (base) => base.replace(/\/$/, '') + '/about-us',
];

const IGNORE_EMAIL_DOMAINS = [
  'sentry.io','googleapis.com','gstatic.com','facebook.com',
  'twitter.com','instagram.com','tiktok.com','youtube.com',
  'example.com','schema.org','w3.org','cloudflare.com',
  'jquery.com','wordpress.com','wix.com','squarespace.com',
];

const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

async function scrape(url) {
  const agent = getProxyAgent();
  if (!agent) {
    return { ok: false, error: 'proxy not configured', level: 2 };
  }

  const result = {
    email: null,
    phone: null,
    emails: [],
    phones: [],
    phone_records: [],
    pages_scanned: [],
    extraction_notes: [],
  };

  const seenEmails = new Set();
  const seenPhones = new Set();

  let targetUrl = url;
  if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
  const base = targetUrl.replace(/\/$/, '');

  for (const buildUrl of PAGES_TO_CHECK) {
    const pageUrl = buildUrl(base);

    try {
      const resp = await fetchViaProxy(pageUrl, agent);

      if (!resp.ok) continue;

      const html = await resp.text();
      if (!html || html.length < 100) continue;

      result.pages_scanned.push(pageUrl);
      const textOnly = htmlToText(html);

      extractEmails(html, textOnly, result, seenEmails);
      extractPhones(html, textOnly, result, seenPhones);

    } catch {
      continue;
    }
  }

  if (result.pages_scanned.length === 0) {
    return { ok: false, error: 'all pages failed via proxy', level: 2 };
  }

  return { ok: true, data: result, level: 2 };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEmails(html, textOnly, result, seen) {
  const mailto = html.match(/mailto:([^"'?\s>]+)/gi) || [];
  for (const m of mailto) {
    const email = m.replace(/^mailto:/i, '').split('?')[0].toLowerCase();
    if (isValidEmail(email) && !seen.has(email)) {
      seen.add(email);
      result.emails.push(email);
      if (!result.email) result.email = email;
    }
  }

  const found = textOnly.match(emailRegex) || [];
  for (const e of found) {
    const lower = e.toLowerCase();
    if (isValidEmail(lower) && !seen.has(lower)) {
      seen.add(lower);
      result.emails.push(lower);
      if (!result.email) result.email = lower;
    }
  }

  const obfuscated = decodeObfuscated(textOnly);
  for (const email of obfuscated) {
    if (isValidEmail(email) && !seen.has(email)) {
      seen.add(email);
      result.emails.push(email);
      if (!result.email) result.email = email;
    }
  }
}

function extractPhones(html, textOnly, result, seen) {
  const tel = html.match(/tel:([+\d\s()\-\.]+)/gi) || [];
  for (const m of tel) {
    const raw = m.replace(/^tel:/i, '').trim();
    const p = normalizePhone(raw);
    if (p && !seen.has(p.key)) {
      seen.add(p.key);
      result.phones.push(p.display);
      result.phone_records.push(p);
      if (!result.phone) result.phone = p.display;
    }
  }
}

function isValidEmail(email) {
  if (!email || !email.includes('@')) return false;
  if (email.includes('noreply')) return false;
  return !IGNORE_EMAIL_DOMAINS.some(d => email.endsWith(d));
}

function decodeObfuscated(text) {
  const c = new Set();
  const norm = text
    .replace(/\s*\[(at|@)\]\s*/gi, '@').replace(/\s*\((at|@)\)\s*/gi, '@')
    .replace(/\s+\bat\b\s+/gi, '@')
    .replace(/\s*\[(dot|\.)\]\s*/gi, '.').replace(/\s*\((dot|\.)\)\s*/gi, '.')
    .replace(/\s+\bdot\b\s+/gi, '.')
    .replace(/\s*\{at\}\s*/gi, '@').replace(/\s*\{dot\}\s*/gi, '.');
  const emails = norm.match(emailRegex) || [];
  for (const e of emails) c.add(e.toLowerCase());
  return [...c];
}

function normalizePhone(raw) {
  try {
    const lib = require('libphonenumber-js/max');
    const parsed = lib.parsePhoneNumberFromString(raw, 'US');
    if (parsed && parsed.isValid()) {
      return { key: parsed.number, display: parsed.formatInternational(), raw, e164: parsed.number, national: parsed.formatNational() };
    }
  } catch {}
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return { key: digits, display: raw, raw, e164: '+' + digits, national: digits };
}

module.exports = { scrape };
