const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/nightops-contacts');

test('pulls real emails out of mailto links, text and obfuscation, and drops junk', () => {
  const html = `
    <a href="mailto:Info@SandovalTax.com?subject=Hi">Email us</a>
    <p>Call or write office [at] sandovaltax [dot] com</p>
    <img src="logo@2x.png"> <script>x="u@sentry.io"; y="noreply@sandovaltax.com"</script>
    <p>me@example.com</p>`;
  assert.deepStrictEqual(C.extractEmails(html).sort(), ['info@sandovaltax.com', 'office@sandovaltax.com']);
});

test('spots a contact form, ignores a search box', () => {
  assert.ok(C.hasContactForm('<form><input name="your-email"><textarea></textarea></form>'));
  assert.ok(C.hasContactForm('<form action="/x"><input type="email"></form>'));
  assert.ok(!C.hasContactForm('<form role="search"><input name="q"></form>'));
});

test('finds same-site contact pages and ignores other sites', () => {
  const html = `<a href="/contact-us">Contact</a> <a href="https://facebook.com/x/contact">FB</a>
                <a href="/services">Services</a> <a href="/request-a-quote">Get a quote</a>`;
  assert.deepStrictEqual(C.contactLinks(html, 'https://www.biz.com/'),
    ['https://www.biz.com/contact-us', 'https://www.biz.com/request-a-quote']);
});

test('prefers an address on the business domain, then free mail', () => {
  assert.strictEqual(C.pickEmail(['joe@gmail.com', 'info@biz.com'], 'https://www.biz.com'), 'info@biz.com');
  assert.strictEqual(C.pickEmail(['vendor@other.com', 'joe@gmail.com'], 'https://biz.com'), 'joe@gmail.com');
  assert.strictEqual(C.pickEmail([], 'https://biz.com'), null);
});

test('checks the contact page when the home page has no email', async () => {
  const pages = {
    'https://biz.com/': '<a href="/contact">Contact</a>',
    'https://biz.com/contact': '<form><textarea></textarea></form> hello@biz.com',
  };
  const got = await C.findContacts('https://biz.com/', async (u) => {
    if (!(u in pages)) throw new Error('404');
    return { url: u, html: pages[u] };
  });
  assert.strictEqual(got.email, 'hello@biz.com');
  assert.strictEqual(got.contact_form_url, 'https://biz.com/contact');
});

test('a dead site is recorded, not thrown', async () => {
  const got = await C.findContacts('https://dead.biz/', async () => { throw new Error('ENOTFOUND'); });
  assert.strictEqual(got.email, null);
  assert.match(got.note, /site: ENOTFOUND/);
});

test('fetchPage re-checks every redirect hop against the SSRF guard', async () => {
  const seen = [];
  const fetchImpl = async (u) => (u === 'https://biz.com/'
    ? { status: 301, ok: false, headers: new Map([['location', 'http://169.254.169.254/']]) }
    : { status: 200, ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => 'x' });
  const assertUrl = async (u) => { seen.push(u); if (u.includes('169.254')) throw new Error('blocked'); };
  await assert.rejects(C.fetchPage('https://biz.com/', { fetchImpl, assertUrl }), /blocked/);
  assert.deepStrictEqual(seen, ['https://biz.com/', 'http://169.254.169.254/']);
});

test('runContacts updates each unchecked own-site lead once and respects the deadline', async () => {
  const updates = [];
  const query = async (text, params) => {
    if (/^SELECT id, website/.test(text.trim())) {
      return { rows: [{ id: 1, website: 'https://a.com/' }, { id: 2, website: 'https://b.com/' }] };
    }
    if (/^UPDATE nightly_leads/.test(text.trim())) { updates.push(params); return { rows: [] }; }
    throw new Error('unexpected ' + text);
  };
  const getPage = async (u) => ({ url: u, html: u.includes('a.com') ? 'sales@a.com' : '<p>nothing</p>' });
  const s = await C.runContacts({ query, getPage, now: () => 0 }, { nightDate: '2026-11-28' });
  assert.strictEqual(s.checked, 2);
  assert.strictEqual(s.with_email, 1);
  assert.strictEqual(updates.find((u) => u[0] === 1)[1], 'sales@a.com');
  assert.strictEqual(updates.find((u) => u[0] === 2)[4], 'no email or form found');

  const late = await C.runContacts({ query, getPage, now: () => 10 }, { nightDate: '2026-11-28', deadlineMs: 5 });
  assert.strictEqual(late.checked, 0);
  assert.strictEqual(late.left, 2);
});
