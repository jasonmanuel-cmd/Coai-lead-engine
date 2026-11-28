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
