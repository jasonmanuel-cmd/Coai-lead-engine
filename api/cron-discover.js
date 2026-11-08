// api/cron-discover.js — hourly lead discovery orchestrator
const { query, initSchema, seedMarkets } = require('../lib/db');
const { isCronAuthorized } = require('../lib/cron-auth');

const MAX_NEW_PER_MARKET = 8; // caps Place Details calls (each one is billed)

async function fetchDetails(placeId, apiKey) {
  const fields = 'formatted_phone_number,website,url';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${apiKey}`;
  const data = await (await fetch(url)).json();
  return data.result || {};
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await initSchema();
    await seedMarkets();

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GOOGLE_PLACES_API_KEY' });

    const markets = (await query('SELECT * FROM markets WHERE active = true')).rows;

    let discovered = 0;
    let duplicates = 0;

    for (const market of markets) {
      try {
        const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(market.search_term)}&key=${apiKey}`;
        const searchData = await (await fetch(searchUrl)).json();
        if (!searchData.results) continue;

        let addedHere = 0;
        for (const place of searchData.results) {
          if (!place.place_id) continue;

          const dupe = await query(
            'SELECT 1 FROM leads WHERE market_id = $1 AND place_id = $2 LIMIT 1',
            [market.id, place.place_id]
          );
          if (dupe.rows.length) { duplicates++; continue; }
          if (addedHere >= MAX_NEW_PER_MARKET) continue;

          // Text search omits phone/website — fetch them so audit/qualify have data.
          let details = {};
          try { details = await fetchDetails(place.place_id, apiKey); }
          catch (e) { console.error('details failed:', e.message); }

          const phone = details.formatted_phone_number || null;
          const phoneDigits = (phone || '').replace(/\D/g, '').slice(-10) || null;

          const ins = await query(
            `INSERT INTO leads (
              market_id, place_id, name, phone, website, address, city, rating, reviews_count,
              maps_url, business_status, pipeline_stage, phone_normalized
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'discovered',$12)
            ON CONFLICT DO NOTHING RETURNING id`,
            [
              market.id, place.place_id, place.name, phone, details.website || null,
              place.formatted_address || null,
              (place.formatted_address || '').split(',')[1]?.trim() || null,
              place.rating || null, place.user_ratings_total || 0,
              details.url || null, place.business_status || 'OPERATIONAL', phoneDigits,
            ]
          );
          if (ins.rows.length) { discovered++; addedHere++; } else duplicates++;
        }
      } catch (err) {
        console.error(`Error discovering in market ${market.name}:`, err.message);
      }
    }

    res.status(200).json({ status: 'OK', discovered, duplicates, markets: markets.length });
  } catch (error) {
    console.error('cron-discover error:', error);
    res.status(500).json({ error: 'Discovery failed.' });
  }
};
