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
