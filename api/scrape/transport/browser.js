// Level 3: Headless browser with full stealth stack
// Uses puppeteer-extra with stealth plugin, @sparticuz/chromium for Vercel

let puppeteerExtra;
let stealthPlugin;
let chromium;

function loadDeps() {
  if (puppeteerExtra) return true;
  try {
    puppeteerExtra = require('puppeteer-extra');
    stealthPlugin = require('puppeteer-extra-plugin-stealth')();
    puppeteerExtra.use(stealthPlugin);
    chromium = require('@sparticuz/chromium');
    return true;
  } catch {
    return false;
  }
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
  if (!loadDeps()) {
    return { ok: false, error: 'browser deps not available', level: 3 };
  }

  const result = {
    email: null,
    phone: null,
    emails: [],
    phones: [],
    phone_records: [],
    pages_scanned: [],
    extraction_notes: [],
    render_used_on: [],
  };

  const seenEmails = new Set();
  const seenPhones = new Set();

  let targetUrl = url;
  if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
  const base = targetUrl.replace(/\/$/, '');

  let browser = null;

  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteerExtra.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 800 },
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    for (const buildUrl of PAGES_TO_CHECK) {
      const pageUrl = buildUrl(base);

      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });

        await randomDelay(200, 500);

        const html = await page.content();
        if (!html || html.length < 100) {
          continue;
        }

        result.render_used_on.push(pageUrl);
        result.pages_scanned.push(pageUrl);
        const textOnly = htmlToText(html);

        extractEmails(html, textOnly, result, seenEmails);
        extractPhones(html, textOnly, result, seenPhones);

      } catch {
        continue;
      }
    }

  } catch (err) {
    return { ok: false, error: err.message, level: 3 };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }

  if (result.pages_scanned.length === 0) {
    return { ok: false, error: 'all pages failed in browser', level: 3 };
  }

  return { ok: true, data: result, level: 3 };
}

async function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
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
