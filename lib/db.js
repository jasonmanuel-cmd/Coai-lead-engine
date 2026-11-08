const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL not set');
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

async function query(text, params = []) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS markets (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      location TEXT,
      industry TEXT,
      search_term TEXT NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      market_id INTEGER REFERENCES markets(id),
      name TEXT NOT NULL,
      phone TEXT,
      website TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      rating NUMERIC,
      reviews_count INTEGER,
      maps_url TEXT,
      business_status TEXT,
      pipeline_stage TEXT DEFAULT 'discovered',
      score INTEGER,
      audit_score INTEGER,
      last_audited TIMESTAMP,
      last_messaged TIMESTAMP,
      last_response TIMESTAMP,
      response_count INTEGER DEFAULT 0,
      phone_normalized TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(phone_normalized, market_id)
    );

    CREATE TABLE IF NOT EXISTS outreach_log (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      email TEXT,
      template_name TEXT,
      status TEXT DEFAULT 'sent',
      sent_at TIMESTAMP DEFAULT NOW(),
      opened_at TIMESTAMP,
      clicked_at TIMESTAMP,
      replied_at TIMESTAMP,
      response_text TEXT
    );

    CREATE TABLE IF NOT EXISTS market_competitors (
      id SERIAL PRIMARY KEY,
      market_id INTEGER NOT NULL REFERENCES markets(id),
      competitor_name TEXT NOT NULL,
      competitor_location TEXT,
      last_seen TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE leads ADD COLUMN IF NOT EXISTS place_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_market_place ON leads(market_id, place_id);
    CREATE INDEX IF NOT EXISTS idx_leads_market ON leads(market_id);
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(pipeline_stage);
    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_normalized);
    CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach_log(lead_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_log(status);
  `);
}

async function seedMarkets() {
  const markets = [
    { name: 'Denver - Smoke Shops', industry: 'smoke-shop', location: 'Denver, CO', search_term: 'smoke shop denver' },
    { name: 'Austin - Vape Shops', industry: 'vape-shop', location: 'Austin, TX', search_term: 'vape shop austin' },
    { name: 'Los Angeles - CBD', industry: 'cbd-shop', location: 'Los Angeles, CA', search_term: 'cbd dispensary los angeles' }
  ];

  for (const market of markets) {
    await query(
      `INSERT INTO markets (name, industry, location, search_term) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [market.name, market.industry, market.location, market.search_term]
    );
  }
}

module.exports = { getPool, query, initSchema, seedMarkets };
