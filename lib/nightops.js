// lib/nightops.js — the Night Ops nightly harvest.
//
// Pulls one rotation group of Bakersfield businesses from Google Maps (the same
// Nearby Search + Place Details calls /api/search proxies), dedupes them, and
// writes them to the Night Ops database (NIGHTOPS_DATABASE_URL, Neon project
// coai-nightops). The Night Ops routine reads the rows with plain SQL, because
// its sandbox can reach the database connector but not coaihq.online.
//
// Everything that costs money is bounded here:
//   - search: at most SEARCH_PAGES pages per category (Google caps it at 3)
//   - details: at most MAX_DETAILS per night, hard ceiling, env can only lower it
//   - places already pulled on an earlier night never get a second details call
//
// The harvest takes its I/O as arguments (fetchJson, query, sleep, now) so it
// can be tested without a network or a database.

// ---- config -------------------------------------------------------------

const CITY = 'Bakersfield, CA';
const RADIUS_M = 15000;
const SEARCH_PAGES = 3;
const MAX_DETAILS_CEILING = 250; // Night Ops' long-standing cap. Do not raise.

// Rotation, in the same order as Night Ops' state.json. The group for a night
// is worked out from the date, so there is no state to keep in step:
// ANCHOR_DATE is the night that runs ROTATION[ANCHOR_INDEX].
const ROTATION = ['trades', 'beauty', 'pro', 'food'];
const ANCHOR_DATE = '2026-11-28';
const ANCHOR_INDEX = 3; // food, matching state.json next_index on 2026-11-28

// Category slug -> Google keyword, copied from Night Ops' harvest_coai.py.
const CATS = {
  trades: {
    electricians: 'electrician', 'roofing-contractors': 'roofing contractor',
    'landscape-contractors': 'landscaping', 'pest-control-services': 'pest control',
    'swimming-pool-repair-service': 'pool service', 'handyman-services': 'handyman',
    'garage-doors-openers': 'garage door repair',
    'solar-energy-equipment-systems-dealers': 'solar installer',
    'auto-repair-service': 'auto repair', 'automobile-detailing': 'auto detailing',
    'fence-contractors': 'fence contractor', 'concrete-contractors': 'concrete contractor',
  },
  food: {
    restaurants: 'restaurant', 'mexican-restaurants': 'mexican restaurant',
    bakeries: 'bakery', 'coffee-espresso-restaurants': 'coffee shop',
    caterers: 'catering', 'food-trucks': 'food truck',
  },
  beauty: {
    barbers: 'barber shop', 'beauty-salons': 'hair salon', 'nail-salons': 'nail salon',
    tattoos: 'tattoo shop', 'health-clubs': 'gym', 'day-spas': 'day spa',
    'medical-spas': 'med spa',
  },
  pro: {
    attorneys: 'law office', 'accountants-certified-public': 'accountant',
    insurance: 'insurance agency', 'real-estate-agents': 'real estate agent',
    dentists: 'dentist', 'chiropractors-dc': 'chiropractor',
  },
};

// Basic + Contact fields only (same as /api/search placedetails): no
// Atmosphere fields, which would add a charge to every lookup.
const DETAIL_FIELDS = [
  'name', 'formatted_phone_number', 'website', 'formatted_address',
  'business_status', 'url',
].join(',');

function maxDetails(env = process.env) {
  const n = Number(env.NIGHTOPS_MAX_DETAILS);
  if (Number.isInteger(n) && n >= 0) return Math.min(n, MAX_DETAILS_CEILING);
  return MAX_DETAILS_CEILING;
}

// ---- dates and rotation -------------------------------------------------

// Calendar date in Pacific time, YYYY-MM-DD.
function pacificDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function groupForNight(nightDate) {
  const n = ROTATION.length;
  const i = (((ANCHOR_INDEX + daysBetween(ANCHOR_DATE, nightDate)) % n) + n) % n;
  return ROTATION[i];
}

// ---- schema -------------------------------------------------------------

// Kept identical to sql/nightops.sql (test/nightops.test.js checks it). Inlined
// rather than read from disk so the bundled function never depends on a
// non-JS file being shipped with it.
const SCHEMA_SQL = `
-- Night Ops lead store (Neon project: coai-nightops).
-- Written nightly by api/cron-nightops.js, read by the Night Ops routine.
-- Lives in its OWN database (NIGHTOPS_DATABASE_URL), never the app's DATABASE_URL.
-- Idempotent: the cron route runs these same statements before each write.

CREATE TABLE IF NOT EXISTS nightly_leads (
  id              BIGSERIAL PRIMARY KEY,
  night_date      DATE        NOT NULL,              -- Pacific date of the run
  lead_group      TEXT        NOT NULL,              -- trades | beauty | pro | food
  category        TEXT,                              -- slug, e.g. electricians
  business_name   TEXT        NOT NULL,
  phone           TEXT,
  website         TEXT,
  address         TEXT,
  locality        TEXT,                              -- "Bakersfield, CA"
  place_id        TEXT        NOT NULL,              -- Google Maps place id
  maps_url        TEXT,
  rating          NUMERIC(2,1),
  reviews         INTEGER,
  types           TEXT[],
  status          TEXT        NOT NULL,              -- new | seen | capped
  source          TEXT        NOT NULL DEFAULT 'coai-lead-engine',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT nightly_leads_status_chk CHECK (status IN ('new','seen','capped')),
  CONSTRAINT nightly_leads_night_place UNIQUE (night_date, place_id)
);

CREATE INDEX IF NOT EXISTS idx_nightly_leads_night ON nightly_leads (night_date, lead_group);
CREATE INDEX IF NOT EXISTS idx_nightly_leads_place ON nightly_leads (place_id);

-- One row per night, so the reader can tell "the cron ran and found nothing"
-- apart from "the cron never ran".
CREATE TABLE IF NOT EXISTS nightops_runs (
  night_date      DATE        PRIMARY KEY,
  lead_group      TEXT        NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'running',  -- running | ok | partial | failed
  search_calls    INTEGER     NOT NULL DEFAULT 0,
  detail_calls    INTEGER     NOT NULL DEFAULT 0,
  rows_written    INTEGER     NOT NULL DEFAULT 0,
  note            TEXT
);

-- ---- No-website track ------------------------------------------------------
-- site_kind: own (its own domain) | directory (Facebook, Yelp, free builder
-- subdomain...) | none (Google lists no website). track: audit (has its own
-- site: pitch a fix or audit) | build (no site of its own: pitch a website).
-- build_score ranks build leads: established (many reviews, good rating,
-- reachable by phone) businesses with no site are the best prospects.
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS site_kind   TEXT;
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS track       TEXT;
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS build_score INTEGER;

-- ---- Contact finding (api/cron-nightops-contacts.js) ------------------------
-- Filled after the pull from the business's own site: no Google calls.
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS email              TEXT;
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS emails             TEXT[];
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS contact_form_url   TEXT;
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS contact_checked_at TIMESTAMPTZ;
ALTER TABLE nightly_leads ADD COLUMN IF NOT EXISTS contact_note       TEXT;

-- ---- Follow-up log (api/cron-nightops-followups.js) -------------------------
-- One row per touch. Whoever sends touch 1 inserts it with status 'sent'.
-- The follow-up job only ever inserts status 'draft' rows; a draft becomes
-- 'sent' only when Jay presses Send and the sender updates the row.
CREATE TABLE IF NOT EXISTS outreach_touches (
  id             BIGSERIAL PRIMARY KEY,
  lead_key       TEXT        NOT NULL,              -- place_id when known, else the email
  place_id       TEXT,
  business_name  TEXT        NOT NULL,
  email          TEXT,
  channel        TEXT        NOT NULL DEFAULT 'email', -- email | form | call
  touch_no       INTEGER     NOT NULL,              -- 1, 2 or 3
  subject        TEXT,
  body           TEXT,
  fact           TEXT,                              -- the observation touch 1 was built on
  offer          TEXT,                              -- e.g. $350 audit
  status         TEXT        NOT NULL,              -- draft | sent | replied | bounced | opted_out | skipped
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  note           TEXT,
  CONSTRAINT outreach_touches_status_chk
    CHECK (status IN ('draft','sent','replied','bounced','opted_out','skipped')),
  CONSTRAINT outreach_touches_touch_chk CHECK (touch_no BETWEEN 1 AND 3),
  CONSTRAINT outreach_touches_lead_touch UNIQUE (lead_key, touch_no)
);

CREATE INDEX IF NOT EXISTS idx_outreach_touches_status ON outreach_touches (status);
CREATE INDEX IF NOT EXISTS idx_outreach_touches_email ON outreach_touches (lower(email));

-- Email leads whose latest sent touch is due a follow-up: touch 2 three days
-- after touch 1, touch 3 four days after touch 2 (day 7), then never again.
-- A reply, bounce or opt-out on any touch stops the lead; an opt-out stops
-- that email address everywhere.
CREATE OR REPLACE VIEW followups_due AS
WITH last_sent AS (
  SELECT DISTINCT ON (lead_key) *
    FROM outreach_touches
   WHERE status = 'sent'
   ORDER BY lead_key, touch_no DESC
)
SELECT l.lead_key, l.place_id, l.business_name, l.email,
       l.touch_no + 1 AS next_touch, l.sent_at AS last_sent_at,
       l.subject AS last_subject, l.fact, l.offer,
       l.sent_at + CASE WHEN l.touch_no = 1 THEN interval '3 days' ELSE interval '4 days' END AS due_at
  FROM last_sent l
 WHERE l.touch_no < 3
   AND l.channel = 'email'
   AND l.email IS NOT NULL
   AND l.sent_at IS NOT NULL
   AND l.sent_at + CASE WHEN l.touch_no = 1 THEN interval '3 days' ELSE interval '4 days' END <= now()
   AND NOT EXISTS (SELECT 1 FROM outreach_touches t
                    WHERE t.lead_key = l.lead_key AND t.touch_no > l.touch_no)
   AND NOT EXISTS (SELECT 1 FROM outreach_touches t
                    WHERE t.lead_key = l.lead_key AND t.status IN ('replied','bounced','opted_out'))
   AND NOT EXISTS (SELECT 1 FROM outreach_touches t
                    WHERE t.status = 'opted_out' AND lower(t.email) = lower(l.email))
`;

function schemaStatements(text = SCHEMA_SQL) {
  return text
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.replace(/\s+--.*$/gm, '').trim()).filter(Boolean);
}

// ---- helpers ------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function splitLocality(formatted, fallback) {
  // "123 Main St, Bakersfield, CA 93301, USA" -> "Bakersfield, CA"
  const parts = String(formatted || '').split(',').map((s) => s.trim());
  if (parts.length >= 3) return `${parts[1]}, ${parts[2].split(' ')[0]}`;
  return fallback;
}

const mapsUrlFor = (placeId) => `https://www.google.com/maps/place/?q=place_id:${placeId}`;

class GoogleError extends Error {}

function checkGoogle(data, okStatuses = ['OK', 'ZERO_RESULTS']) {
  const status = data && data.status;
  if (!okStatuses.includes(status)) {
    throw new GoogleError(`Google ${status || 'error'}${data && data.error_message ? ': ' + data.error_message : ''}`);
  }
  return data;
}

// ---- no-website track ---------------------------------------------------

// Hosts that are a listing or a free-builder page, not a site the business
// owns. Same list Night Ops' cut.py uses, so both sides agree on "no site".
const NOT_OWN = ['yellowpages.com', 'facebook.com', 'm.facebook.com', 'groupon.com',
  'chamberofcommerce.com', 'cslb.ca.gov', 'sites.google.com', 'instagram.com', 'yelp.com',
  'linktr.ee', 'business.site', 'nextdoor.com', 'google.com', 'g.page', 'squareup.com',
  'wixsite.com'];
const NOT_OWN_PARTS = ['facebook', 'wixsite', 'godaddysites', 'business.site'];

function siteDomain(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// own | directory | none
function classifySite(website) {
  if (!website) return 'none';
  const d = siteDomain(website);
  if (!d) return 'none';
  if (NOT_OWN.some((h) => d === h || d.endsWith('.' + h))) return 'directory';
  if (NOT_OWN_PARTS.some((x) => d.includes(x))) return 'directory';
  return 'own';
}

// 0-130. An established business with no site of its own is the best build
// prospect: reviews show it is real and busy, a good rating means it has
// something worth showing, a phone means Jay can actually reach it.
function buildScore({ rating, reviews, phone }) {
  const r = Number(rating) || 0;
  const n = Math.max(0, Number(reviews) || 0);
  return Math.round(Math.min(n, 200) / 2) + (r >= 4.5 ? 20 : r >= 4 ? 10 : 0) + (phone ? 10 : 0);
}

// ---- the harvest --------------------------------------------------------

/**
 * Runs one night's harvest and writes it.
 * deps: { fetchJson(url), query(text, params), sleep(ms), now(): number }
 * opts: { apiKey, nightDate, group, maxDetails, deadlineMs }
 * Returns a summary object (also stored in nightops_runs).
 */
async function runNight(deps, opts) {
  const { fetchJson, query, sleep, now } = deps;
  const { apiKey, nightDate, group } = opts;
  const cap = Math.min(opts.maxDetails ?? MAX_DETAILS_CEILING, MAX_DETAILS_CEILING);
  const deadline = opts.deadlineMs ?? Infinity;
  const cats = CATS[group];
  if (!cats) throw new Error(`unknown group: ${group}`);

  const stats = { night_date: nightDate, group, search_calls: 0, detail_calls: 0,
    found: 0, new: 0, seen: 0, capped: 0, already_tonight: 0, rows_written: 0,
    status: 'ok', note: null };

  for (const stmt of schemaStatements()) await query(stmt);
  await query(
    `INSERT INTO nightops_runs (night_date, lead_group) VALUES ($1, $2)
     ON CONFLICT (night_date) DO UPDATE
       SET lead_group = EXCLUDED.lead_group, started_at = now(), finished_at = NULL,
           status = 'running', note = NULL`,
    [nightDate, group]
  );

  const g = 'https://maps.googleapis.com/maps/api';
  try {
    // 1. Where is the city?
    stats.search_calls++;
    const geo = checkGoogle(await fetchJson(
      `${g}/geocode/json?address=${encodeURIComponent(CITY)}&key=${apiKey}`), ['OK']);
    const { lat, lng } = geo.results[0].geometry.location;

    // 2. Nearby search, every category in the group, up to 3 pages each.
    const places = new Map(); // place_id -> { category, p }
    await mapLimit(Object.entries(cats), 4, async ([slug, keyword]) => {
      let token = null;
      for (let page = 0; page < SEARCH_PAGES; page++) {
        if (now() > deadline) return;
        let url = `${g}/place/nearbysearch/json?location=${lat},${lng}`
          + `&radius=${RADIUS_M}&keyword=${encodeURIComponent(keyword)}&key=${apiKey}`;
        if (token) url += `&pagetoken=${encodeURIComponent(token)}`;
        stats.search_calls++;
        let data = await fetchJson(url);
        if (data.status === 'INVALID_REQUEST' && token) {
          // A page token takes a moment to become valid; one retry.
          await sleep(3000);
          stats.search_calls++;
          data = await fetchJson(url);
        }
        checkGoogle(data);
        for (const p of data.results || []) {
          if (!p.place_id || places.has(p.place_id)) continue;
          if ((p.business_status || 'OPERATIONAL') !== 'OPERATIONAL') continue;
          places.set(p.place_id, { category: slug, p });
        }
        token = data.next_page_token;
        if (!token) break;
        await sleep(2200);
      }
    });
    stats.found = places.size;

    // 3. Dedupe against the database before paying for any details.
    const ids = [...places.keys()];
    const prior = new Set();
    const tonight = new Set();
    if (ids.length) {
      const r = await query(
        // "seen" means we already paid for its details on an earlier night.
        // A place that was only ever written as seen/capped still gets fetched.
        `SELECT place_id, bool_or(night_date = $2) AS tonight,
                bool_or(night_date < $2 AND status = 'new') AS fetched_before
           FROM nightly_leads WHERE place_id = ANY($1) GROUP BY place_id`,
        [ids, nightDate]
      );
      for (const row of r.rows) {
        if (row.tonight) tonight.add(row.place_id);
        else if (row.fetched_before) prior.add(row.place_id);
      }
    }

    const base = (id, { category, p }) => ({
      place_id: id, category, business_name: p.name, phone: null, website: null,
      address: p.vicinity || null, locality: CITY, maps_url: mapsUrlFor(id),
      rating: p.rating ?? null, reviews: p.user_ratings_total ?? null,
      types: Array.isArray(p.types) ? p.types : null,
    });

    const toFetch = [];
    const pending = [];
    for (const [id, v] of places) {
      if (tonight.has(id)) { stats.already_tonight++; continue; } // a re-run: already written
      if (prior.has(id)) { pending.push({ ...base(id, v), status: 'seen' }); continue; }
      if (toFetch.length >= cap) { pending.push({ ...base(id, v), status: 'capped' }); continue; }
      toFetch.push([id, v]);
    }

    // 4. Details for new places only, written in batches as they arrive.
    const write = async (rows) => {
      if (!rows.length) return;
      const r = await insertRows(query, nightDate, group, rows);
      stats.rows_written += r;
    };
    await write(pending.splice(0));

    let stopped = false;
    for (let i = 0; i < toFetch.length; i += 25) {
      const chunk = toFetch.slice(i, i + 25);
      if (stopped || now() > deadline) {
        stopped = true;
        await write(chunk.map(([id, v]) => ({ ...base(id, v), status: 'capped' })));
        continue;
      }
      const rows = await mapLimit(chunk, 8, async ([id, v]) => {
        stats.detail_calls++;
        const d = await fetchJson(`${g}/place/details/json?place_id=${encodeURIComponent(id)}`
          + `&fields=${encodeURIComponent(DETAIL_FIELDS)}&key=${apiKey}`);
        const res = (d && d.status === 'OK' && d.result) || {};
        const row = {
          ...base(id, v),
          business_name: res.name || v.p.name,
          phone: res.formatted_phone_number || null,
          website: res.website || null,
          address: res.formatted_address || v.p.vicinity || null,
          locality: splitLocality(res.formatted_address, CITY),
          maps_url: res.url || mapsUrlFor(id),
          status: 'new',
        };
        row.site_kind = classifySite(row.website);
        row.track = row.site_kind === 'own' ? 'audit' : 'build';
        row.build_score = row.track === 'build' ? buildScore(row) : null;
        return row;
      });
      await write(rows);
    }
    if (stopped) { stats.status = 'partial'; stats.note = 'time budget reached; rest marked capped'; }
  } catch (err) {
    stats.status = stats.rows_written ? 'partial' : 'failed';
    stats.note = String(err.message || err).slice(0, 500);
  }

  const counts = await query(
    `SELECT status, count(*)::int AS n FROM nightly_leads WHERE night_date = $1 GROUP BY status`,
    [nightDate]
  );
  for (const row of counts.rows) stats[row.status] = row.n;
  const tracks = await query(
    `SELECT track, count(*)::int AS n FROM nightly_leads
      WHERE night_date = $1 AND status = 'new' GROUP BY track`,
    [nightDate]
  );
  stats.tracks = Object.fromEntries((tracks.rows || []).map((r) => [r.track, r.n]));

  await query(
    `UPDATE nightops_runs SET finished_at = now(), status = $2, search_calls = $3,
       detail_calls = $4, note = $5,
       rows_written = (SELECT count(*) FROM nightly_leads WHERE night_date = $1)
     WHERE night_date = $1`,
    [nightDate, stats.status, stats.search_calls, stats.detail_calls, stats.note]
  );
  return stats;
}

async function insertRows(query, nightDate, group, rows) {
  const cols = ['night_date', 'lead_group', 'category', 'business_name', 'phone', 'website',
    'address', 'locality', 'place_id', 'maps_url', 'rating', 'reviews', 'types', 'status',
    'site_kind', 'track', 'build_score'];
  const params = [];
  const tuples = rows.map((r) => {
    const vals = [nightDate, group, r.category, r.business_name, r.phone, r.website,
      r.address, r.locality, r.place_id, r.maps_url, r.rating, r.reviews, r.types, r.status,
      r.site_kind ?? null, r.track ?? null, r.build_score ?? null];
    const start = params.length;
    params.push(...vals);
    return '(' + vals.map((_, j) => `$${start + j + 1}`).join(',') + ')';
  });
  const res = await query(
    `INSERT INTO nightly_leads (${cols.join(',')}) VALUES ${tuples.join(',')}
     ON CONFLICT (night_date, place_id) DO NOTHING`,
    params
  );
  return res.rowCount || 0;
}

// ---- auth ---------------------------------------------------------------

// Vercel Cron's CRON_SECRET, or NIGHTOPS_RUN_SECRET, which opens only the Night
// Ops routes so a manual run doesn't need the shared cron key. Header
// (`Authorization: Bearer ...`) or `?secret=`. Unset secrets never match.
function isNightopsAuthorized(req) {
  const { isCronAuthorized, safeEqual } = require('./cron-auth');
  if (isCronAuthorized(req)) return true;
  const secret = process.env.NIGHTOPS_RUN_SECRET;
  if (!secret) return false;
  const header = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  const q = (req.query && req.query.secret) || '';
  return Boolean((header && safeEqual(header, secret)) || (q && safeEqual(q, secret)));
}

// ---- real I/O -----------------------------------------------------------

let pool;
function nightopsQuery(text, params = []) {
  if (!pool) {
    const connectionString = process.env.NIGHTOPS_DATABASE_URL;
    if (!connectionString) throw new Error('NIGHTOPS_DATABASE_URL not set');
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool.query(text, params);
}

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

module.exports = {
  CITY, ROTATION, ANCHOR_DATE, CATS, MAX_DETAILS_CEILING,
  maxDetails, pacificDate, groupForNight, schemaStatements, splitLocality,
  classifySite, buildScore, siteDomain, mapLimit,
  runNight, nightopsQuery, fetchJson, isNightopsAuthorized,
};
