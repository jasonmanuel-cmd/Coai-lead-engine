// lib/nightops-contacts.js — find a way to write to each new lead.
//
// Reads the business's own site (home page plus up to two contact pages) and
// pulls out email addresses and whether there is a contact form. No Google
// calls, no browser, no form is ever submitted. Every fetch goes through the
// SSRF guard and a per-page timeout and size cap.

const { assertPublicUrl } = require('./ssrf');

const PAGE_TIMEOUT_MS = 8000;
const MAX_BYTES = 1500000;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; COAI-NightOps/1.0; +https://coaihq.online)';

// Addresses that are never a business's inbox.
const JUNK_EMAIL = [
  /@(example|domain|email|yourdomain|yoursite|sentry|sentry\.io|wixpress|wix|godaddy|squarespace|mysite)\./i,
  /^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|privacy|abuse)@/i,
  /\.(png|jpe?g|gif|webp|svg|css|js)$/i,
  /@\d+x\./i,
  /^[0-9a-f]{20,}@/i, // tracking hashes
];

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}/gi;

function decodeEntities(s) {
  return s
    .replace(/&#64;|&#x40;/gi, '@')
    .replace(/\s*(\[at\]|\(at\))\s*/gi, '@')
    .replace(/&#46;|&#x2e;/gi, '.')
    .replace(/\s*(\[dot\]|\(dot\))\s*/gi, '.')
    .replace(/&amp;/g, '&');
}

function extractEmails(html) {
  const text = decodeEntities(String(html || ''));
  const found = new Set();
  for (const m of text.match(/mailto:([^"'?\s>]+)/gi) || []) {
    let e = m.replace(/^mailto:/i, '');
    try { e = decodeURIComponent(e); } catch { /* keep raw */ }
    found.add(e.toLowerCase());
  }
  for (const m of text.match(EMAIL_RE) || []) found.add(m.toLowerCase());
  return [...found]
    .map((e) => e.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''))
    .filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e))
    .filter((e) => !JUNK_EMAIL.some((re) => re.test(e)));
}

// A form a customer could write in: has a textarea or an email field.
function hasContactForm(html) {
  const forms = String(html || '').match(/<form[\s\S]*?<\/form>/gi) || [];
  return forms.some((f) =>
    /<textarea/i.test(f) || /type=["']?email/i.test(f) || /name=["'][^"']*(email|message)/i.test(f));
}

// Links on the same site that look like a contact page.
function contactLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (!/contact|get-in-touch|reach-us|quote|estimate/i.test(href + ' ' + label)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    u.hash = '';
    if (!out.includes(u.href) && u.href !== base.href) out.push(u.href);
  }
  // Prefer links that literally say "contact".
  return out.sort((a, b) => Number(!/contact/i.test(a)) - Number(!/contact/i.test(b)));
}

// Picks the address most likely to reach the owner: one on the business's own
// domain first, then a free-mail inbox (many small shops use Gmail).
function pickEmail(emails, website) {
  if (!emails.length) return null;
  let host = '';
  try { host = new URL(website).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* none */ }
  const own = emails.filter((e) => host && e.endsWith('@' + host));
  const pref = (list) => list.find((e) => /^(info|contact|office|hello|service|sales|admin)@/.test(e)) || list[0];
  if (own.length) return pref(own);
  const free = emails.filter((e) => /@(gmail|yahoo|outlook|hotmail|icloud|aol|att|sbcglobal|comcast)\./.test(e));
  if (free.length) return pref(free);
  return pref(emails);
}

// Real fetch: SSRF-checked at every hop, timeout, size cap, HTML only.
async function fetchPage(url, { fetchImpl = fetch, assertUrl = assertPublicUrl } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
    let r;
    try {
      r = await fetchImpl(current, {
        redirect: 'manual', signal: ctrl.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      });
    } finally { clearTimeout(timer); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location'), current).href;
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (type && !/html|xml|text/i.test(type)) throw new Error(`not html (${type.split(';')[0]})`);
    const text = await r.text();
    return { url: current, html: text.slice(0, MAX_BYTES) };
  }
  throw new Error('too many redirects');
}

/**
 * Looks for contacts on one site. getPage(url) -> { url, html }.
 * Returns { email, emails, contact_form_url, note }.
 */
async function findContacts(website, getPage) {
  const emails = new Set();
  let formUrl = null;
  const notes = [];

  let home;
  try { home = await getPage(website); }
  catch (e) { return { email: null, emails: [], contact_form_url: null, note: `site: ${e.message}` }; }

  for (const e of extractEmails(home.html)) emails.add(e);
  if (hasContactForm(home.html)) formUrl = home.url;

  for (const link of contactLinks(home.html, home.url).slice(0, 2)) {
    if (emails.size && formUrl) break;
    try {
      const page = await getPage(link);
      for (const e of extractEmails(page.html)) emails.add(e);
      if (!formUrl && hasContactForm(page.html)) formUrl = page.url;
    } catch (e) { notes.push(`contact page: ${e.message}`); }
  }

  const list = [...emails].slice(0, 10);
  return {
    email: pickEmail(list, home.url),
    emails: list,
    contact_form_url: formUrl,
    note: notes.length ? notes.join('; ').slice(0, 300) : (list.length || formUrl ? null : 'no email or form found'),
  };
}

/**
 * Fills contacts for tonight's new own-site leads that haven't been checked.
 * deps: { query, getPage, now }  opts: { nightDate, limit, deadlineMs }
 */
async function runContacts(deps, opts) {
  const { query, getPage, now } = deps;
  const { nightDate, limit = 150, deadlineMs = Infinity } = opts;
  const r = await query(
    `SELECT id, website FROM nightly_leads
      WHERE night_date = $1 AND status = 'new' AND site_kind = 'own'
        AND website IS NOT NULL AND contact_checked_at IS NULL
      ORDER BY id LIMIT $2`,
    [nightDate, limit]
  );
  const stats = { night_date: nightDate, checked: 0, with_email: 0, with_form: 0, failed: 0, left: 0 };
  const { mapLimit } = require('./nightops');
  await mapLimit(r.rows, 8, async (row) => {
    if (now() > deadlineMs) { stats.left++; return; }
    const c = await findContacts(row.website, getPage);
    stats.checked++;
    if (c.email) stats.with_email++;
    if (c.contact_form_url) stats.with_form++;
    if (c.note && /^site:/.test(c.note)) stats.failed++;
    await query(
      `UPDATE nightly_leads SET email = $2, emails = $3, contact_form_url = $4,
              contact_note = $5, contact_checked_at = now()
        WHERE id = $1`,
      [row.id, c.email, c.emails, c.contact_form_url, c.note]
    );
  });
  return stats;
}

module.exports = {
  extractEmails, hasContactForm, contactLinks, pickEmail, findContacts, fetchPage, runContacts,
};
