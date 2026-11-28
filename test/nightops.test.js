// node --test test/  — no dependencies, no network, no database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const N = require('../lib/nightops');

// ---- fakes ----------------------------------------------------------------

const idNum = (id) => Number(String(id).split('-').pop());
const siteFor = (id) => (idNum(id) % 3 === 0 ? undefined
  : idNum(id) % 5 === 0 ? 'https://www.facebook.com/somebiz' : 'https://example-' + String(id).replace(/[^a-z0-9]+/gi, '-') + '.com');

function fakeGoogle({ perPage = 20, pages = 3, geocodeStatus = 'OK' } = {}) {
  const calls = { geocode: 0, nearby: 0, details: 0 };
  async function fetchJson(url) {
    const u = new URL(url);
    if (u.pathname.endsWith('/geocode/json')) {
      calls.geocode++;
      if (geocodeStatus !== 'OK') return { status: geocodeStatus, error_message: 'denied' };
      return { status: 'OK', results: [{ geometry: { location: { lat: 35.37, lng: -119.02 } } }] };
    }
    if (u.pathname.endsWith('/nearbysearch/json')) {
      calls.nearby++;
      const kw = u.searchParams.get('keyword');
      const page = Number(u.searchParams.get('pagetoken') || 0);
      const results = [];
      for (let i = 0; i < perPage; i++) {
        // ids repeat across keywords for i < 2, so cross-category dedupe is exercised
        const id = i < 2 ? `shared-${page}-${i}` : `${kw}-${page}-${i}`;
        results.push({ place_id: id, name: `Biz ${id}`, vicinity: '1 Main St',
          rating: 4.5, user_ratings_total: 10, types: ['store'],
          business_status: i === 3 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL' });
      }
      return { status: 'OK', results, next_page_token: page + 1 < pages ? String(page + 1) : undefined };
    }
    if (u.pathname.endsWith('/details/json')) {
      calls.details++;
      const id = u.searchParams.get('place_id');
      assert.ok(!/rating|review|opening/.test(u.searchParams.get('fields')), 'no Atmosphere fields');
      return { status: 'OK', result: { name: `Biz ${id}`, formatted_phone_number: '(661) 555-0100',
        website: siteFor(id), formatted_address: '1 Main St, Bakersfield, CA 93301, USA',
        url: `https://maps.google.com/?cid=${id}` } };
    }
    throw new Error('unexpected url ' + url);
  }
  return { fetchJson, calls };
}

function fakeDb({ prior = [], tonight = [], onlyCapped = [] } = {}) {
  const rows = [];
  const runs = [];
  async function query(text, params = []) {
    if (/^(CREATE|ALTER)/.test(text.trim())) return { rows: [] };
    if (/INSERT INTO nightops_runs/.test(text)) { runs.push({ start: params }); return { rows: [] }; }
    if (/UPDATE nightops_runs/.test(text)) { runs.push({ end: params }); return { rows: [] }; }
    if (/bool_or/.test(text)) {
      const ids = new Set(params[0]);
      return { rows: [
        ...prior.filter((id) => ids.has(id)).map((place_id) => ({ place_id, tonight: false, fetched_before: true })),
        ...tonight.filter((id) => ids.has(id)).map((place_id) => ({ place_id, tonight: true, fetched_before: false })),
        ...onlyCapped.filter((id) => ids.has(id)).map((place_id) => ({ place_id, tonight: false, fetched_before: false })),
      ] };
    }
    if (/INSERT INTO nightly_leads/.test(text)) {
      let n = 0;
      for (let i = 0; i < params.length; i += 17) {
        const p = params.slice(i, i + 17);
        if (rows.some((r) => r.place_id === p[8])) continue; // ON CONFLICT DO NOTHING
        rows.push({ night_date: p[0], lead_group: p[1], category: p[2], business_name: p[3],
          phone: p[4], website: p[5], address: p[6], locality: p[7], place_id: p[8], status: p[13], site_kind: p[14], track: p[15], build_score: p[16] });
        n++;
      }
      return { rowCount: n, rows: [] };
    }
    if (/SELECT track, count/.test(text)) {
      const c = {};
      for (const r of rows.filter((x) => x.status === 'new')) c[r.track] = (c[r.track] || 0) + 1;
      return { rows: Object.entries(c).map(([track, n]) => ({ track, n })) };
    }
    if (/SELECT status, count/.test(text)) {
      const c = {};
      for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
      return { rows: Object.entries(c).map(([status, n]) => ({ status, n })) };
    }
    throw new Error('unexpected sql ' + text);
  }
  return { query, rows, runs };
}

const deps = (g, db, now = () => 0) => ({ fetchJson: g.fetchJson, query: db.query, sleep: async () => {}, now });
const opts = (o = {}) => ({ apiKey: 'k', nightDate: '2026-11-28', group: 'food', ...o });

// ---- rotation, dates, caps -------------------------------------------------

test('rotation matches Night Ops history and state.json', () => {
  assert.strictEqual(N.groupForNight('2026-11-25'), 'trades'); // night 4
  assert.strictEqual(N.groupForNight('2026-11-26'), 'beauty'); // night 5
  assert.strictEqual(N.groupForNight('2026-11-27'), 'pro');    // night 6
  assert.strictEqual(N.groupForNight('2026-11-28'), 'food');   // state.json next_index 3
  assert.strictEqual(N.groupForNight('2026-11-29'), 'trades');
  assert.strictEqual(N.groupForNight('2027-03-14'), N.ROTATION[(3 + 106) % 4]);
});

test('night date is the Pacific calendar date at cron time, PST and PDT', () => {
  assert.strictEqual(N.pacificDate(new Date('2026-11-28T08:30:00Z')), '2026-11-28'); // 12:30 AM PST
  assert.strictEqual(N.pacificDate(new Date('2027-07-01T08:30:00Z')), '2027-07-01'); // 1:30 AM PDT
});

test('details cap can be lowered by env but never raised past 250', () => {
  assert.strictEqual(N.maxDetails({}), 250);
  assert.strictEqual(N.maxDetails({ NIGHTOPS_MAX_DETAILS: '100' }), 100);
  assert.strictEqual(N.maxDetails({ NIGHTOPS_MAX_DETAILS: '9999' }), 250);
  assert.strictEqual(N.maxDetails({ NIGHTOPS_MAX_DETAILS: 'lots' }), 250);
});

test('inlined schema matches sql/nightops.sql', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'sql', 'nightops.sql'), 'utf8');
  assert.deepStrictEqual(N.schemaStatements(), N.schemaStatements(file));
  assert.strictEqual(N.schemaStatements().length, 16);
});

// ---- the harvest -----------------------------------------------------------

test('harvests, dedupes, skips closed, and pays for details only on new places', async () => {
  const g = fakeGoogle({ perPage: 10 }); // stays under the 250 cap
  const prior = ['restaurant-0-5', 'bakery-1-7'];
  const db = fakeDb({ prior });
  const s = await N.runNight(deps(g, db), opts());

  assert.strictEqual(s.status, 'ok');
  assert.strictEqual(g.calls.geocode, 1);
  assert.strictEqual(g.calls.nearby, 6 * 3); // 6 food categories x 3 pages
  // per category per page: 10 results, 1 closed, 2 shared across categories
  const unique = 6 * 3 * (10 - 1 - 2) + 3 * 2;
  assert.strictEqual(s.found, unique);
  assert.strictEqual(new Set(db.rows.map((r) => r.place_id)).size, unique);
  assert.ok(!db.rows.some((r) => /-3$/.test(r.place_id)), 'closed businesses dropped');
  assert.strictEqual(s.seen, 2);
  assert.strictEqual(s.new, unique - 2);
  assert.strictEqual(g.calls.details, unique - 2, 'no details call for already-seen places');
  const fresh = db.rows.find((r) => r.status === 'new');
  assert.strictEqual(fresh.phone, '(661) 555-0100');
  assert.strictEqual(fresh.locality, 'Bakersfield, CA');
  assert.ok(db.rows.every((r) => r.night_date === '2026-11-28' && r.lead_group === 'food'));
});

test('stops paying for details at the cap and marks the rest capped', async () => {
  const g = fakeGoogle();
  const db = fakeDb();
  const s = await N.runNight(deps(g, db), opts({ maxDetails: 10 }));
  assert.strictEqual(g.calls.details, 10);
  assert.strictEqual(s.new, 10);
  assert.strictEqual(s.capped, s.found - 10);
});

test('a cap above 250 is clamped to 250', async () => {
  const g = fakeGoogle({ perPage: 20 });
  const db = fakeDb();
  await N.runNight(deps(g, db), opts({ group: 'trades', maxDetails: 100000 }));
  assert.strictEqual(g.calls.details, 250);
});

test('a re-run on the same night does not buy details twice', async () => {
  const g1 = fakeGoogle();
  const db = fakeDb();
  await N.runNight(deps(g1, db), opts({ maxDetails: 30 }));
  const written = db.rows.map((r) => r.place_id);
  const g2 = fakeGoogle();
  const db2 = fakeDb({ tonight: written });
  db2.rows.push(...db.rows);
  const s = await N.runNight(deps(g2, db2), opts({ maxDetails: 30 }));
  assert.strictEqual(g2.calls.details, 0);
  assert.strictEqual(s.already_tonight, written.length);
});

test('out of time: no more details, remaining rows kept as capped, run marked partial', async () => {
  const g = fakeGoogle();
  const db = fakeDb();
  let t = 0;
  const s = await N.runNight(deps(g, db, () => (t++ > 20 ? 10 : 0)), opts({ deadlineMs: 5 }));
  assert.strictEqual(s.status, 'partial');
  assert.ok(g.calls.details < s.found);
  assert.strictEqual(db.rows.length, s.found, 'every found place still written');
});

test('Google refusing the key fails the run cleanly with no paid calls', async () => {
  const g = fakeGoogle({ geocodeStatus: 'REQUEST_DENIED' });
  const db = fakeDb();
  const s = await N.runNight(deps(g, db), opts());
  assert.strictEqual(s.status, 'failed');
  assert.match(s.note, /REQUEST_DENIED/);
  assert.strictEqual(g.calls.nearby + g.calls.details, 0);
  assert.ok(db.runs.some((r) => r.end && r.end[1] === 'failed'));
});

test('cron route refuses calls without the cron secret', async () => {
  process.env.CRON_SECRET = 's3cret';
  const handler = require('../api/cron-nightops');
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ headers: {}, query: {} }, res);
  assert.strictEqual(res.code, 401);
  await handler({ headers: { authorization: 'Bearer wrong' }, query: {} }, res);
  assert.strictEqual(res.code, 401);
  delete process.env.CRON_SECRET;
  await handler({ headers: { authorization: 'Bearer ' }, query: {} }, res);
  assert.strictEqual(res.code, 401, 'unset secret fails closed');
  assert.strictEqual(handler.config.maxDuration, 300);

  process.env.NIGHTOPS_RUN_SECRET = 'runonly';
  process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'test-key';
  process.env.NIGHTOPS_DATABASE_URL = process.env.NIGHTOPS_DATABASE_URL || 'postgres://unused';
  await handler({ headers: {}, query: { secret: 'nope' } }, res);
  assert.strictEqual(res.code, 401);
  await handler({ headers: {}, query: { secret: 'runonly', group: 'bogus' } }, res);
  assert.strictEqual(res.code, 400, 'run secret gets past auth; bad group rejected');
  await handler({ headers: {}, query: { secret: 'runonly', max: '-1' } }, res);
  assert.strictEqual(res.code, 400, 'bad max rejected');
  delete process.env.NIGHTOPS_RUN_SECRET;
});

test('a place only ever written as capped on an earlier night still gets its details', async () => {
  const g = fakeGoogle({ perPage: 10 });
  const db = fakeDb({ onlyCapped: ['restaurant-0-5'] });
  const s = await N.runNight(deps(g, db), opts());
  assert.strictEqual(s.seen || 0, 0);
  assert.strictEqual(g.calls.details, s.found);
});

// ---- no-website track ------------------------------------------------------

test('classifies own sites, directory pages and no site', () => {
  assert.strictEqual(N.classifySite('https://www.sandovaltax.com/'), 'own');
  assert.strictEqual(N.classifySite('https://m.facebook.com/joes'), 'directory');
  assert.strictEqual(N.classifySite('https://joes.wixsite.com/home'), 'directory');
  assert.strictEqual(N.classifySite('https://www.yelp.com/biz/joes'), 'directory');
  assert.strictEqual(N.classifySite(null), 'none');
  assert.strictEqual(N.classifySite('not a url'), 'none');
});

test('build score favours established, well-rated, reachable businesses', () => {
  assert.strictEqual(N.buildScore({ rating: 4.8, reviews: 300, phone: 'x' }), 130);
  assert.strictEqual(N.buildScore({ rating: 4.1, reviews: 40, phone: null }), 30);
  assert.strictEqual(N.buildScore({}), 0);
  assert.ok(N.buildScore({ rating: 4.6, reviews: 120, phone: 'x' }) >
            N.buildScore({ rating: 3.9, reviews: 8, phone: 'x' }));
});

test('harvest tags each new lead with a track and scores the build leads', async () => {
  const g = fakeGoogle({ perPage: 10 });
  const db = fakeDb();
  const s = await N.runNight(deps(g, db), opts());
  const fresh = db.rows.filter((r) => r.status === 'new');
  assert.ok(fresh.length > 0);
  for (const r of fresh) {
    const n = idNum(r.place_id);
    const want = n % 3 === 0 ? 'none' : n % 5 === 0 ? 'directory' : 'own';
    assert.strictEqual(r.site_kind, want, r.place_id);
    assert.strictEqual(r.track, want === 'own' ? 'audit' : 'build');
    if (r.track === 'build') assert.strictEqual(typeof r.build_score, 'number');
    else assert.strictEqual(r.build_score, null);
  }
  assert.strictEqual(s.tracks.audit + s.tracks.build, fresh.length);
});
