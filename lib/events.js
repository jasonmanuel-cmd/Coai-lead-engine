// lib/events.js — server-side funnel events (signup → checkout_started → upgrade)
//
// Recorded on the server, so ad blockers can't hide them and they line up with
// real accounts and real Stripe/Square payments. Each event carries the UTM tags
// the visitor arrived with (stored in the browser at landing, sent at signup),
// so the owner can see which campaign or post produced signups and paid plans.
//
// recordEvent() never throws: analytics must never break signup or billing.

const { query } = require('./db');

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];
let tableReady = false;

async function ensureEventsTable() {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      user_id INTEGER,
      plan TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      ext_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_events_name_time ON events(name, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_name_ext ON events(name, ext_id) WHERE ext_id IS NOT NULL;
  `);
  tableReady = true;
}

// Keep only the three UTM keys, as short plain strings.
function cleanUtm(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of UTM_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 100);
  }
  return out;
}

// name:   'signup' | 'checkout_started' | 'upgrade'
// userId: the COAI account id, when known
// plan:   'starter' | 'pro', when relevant
// utm:    raw object from the client (cleaned here)
// extId:  provider id (Stripe session / Square subscription) so webhook retries count once
async function recordEvent(name, { userId = null, plan = null, utm = null, extId = null } = {}) {
  try {
    await ensureEventsTable();
    let tags = cleanUtm(utm);
    // Paid events inherit the tags from the same account's signup, so an
    // upgrade is credited to the campaign that brought the user in.
    if (!tags.utm_source && userId && name !== 'signup') {
      const prior = await query(
        `SELECT utm_source, utm_medium, utm_campaign FROM events
         WHERE user_id = $1 AND name = 'signup' ORDER BY created_at ASC LIMIT 1`,
        [userId]
      );
      if (prior.rows[0]) tags = cleanUtm(prior.rows[0]);
    }
    await query(
      `INSERT INTO events (name, user_id, plan, utm_source, utm_medium, utm_campaign, ext_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [name, userId, plan, tags.utm_source || null, tags.utm_medium || null,
       tags.utm_campaign || null, extId ? String(extId).slice(0, 200) : null]
    );
  } catch (error) {
    console.warn('events: could not record', name, '-', error.message);
  }
}

// Owner summary: counts per event for 7 and 30 days, plus a 30-day
// breakdown by utm_source (visits from pageviews, signups, upgrades).
async function funnelSummary() {
  await ensureEventsTable();
  const [counts, bySource] = await Promise.all([
    query(`
      SELECT name,
             COUNT(*) FILTER (WHERE created_at >= NOW() - interval '7 days')::int  AS d7,
             COUNT(*) FILTER (WHERE created_at >= NOW() - interval '30 days')::int AS d30
      FROM events GROUP BY name`),
    query(`
      SELECT COALESCE(utm_source, '(none)') AS source,
             COUNT(*) FILTER (WHERE name = 'signup')::int  AS signups,
             COUNT(*) FILTER (WHERE name = 'upgrade')::int AS upgrades
      FROM events
      WHERE created_at >= NOW() - interval '30 days'
      GROUP BY 1 ORDER BY signups DESC, upgrades DESC LIMIT 10`),
  ]);
  const funnel = { signup: { d7: 0, d30: 0 }, checkout_started: { d7: 0, d30: 0 }, upgrade: { d7: 0, d30: 0 } };
  for (const r of counts.rows) funnel[r.name] = { d7: r.d7, d30: r.d30 };
  return { funnel, bySource30d: bySource.rows };
}

module.exports = { recordEvent, funnelSummary, cleanUtm, UTM_KEYS };
