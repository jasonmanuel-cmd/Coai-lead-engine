// api/search.js — COAI Lead Engine Backend v2.2 (SaaS)
// Adds exact business lookup and richer Place Details support.
// Auth: customer session cookie (see api/auth.js) or the owner's APP_PASSWORD
// master key. Every proxied Google call is metered against the caller's plan.
//
// Required Vercel env vars:
//   GOOGLE_PLACES_API_KEY
//   APP_PASSWORD (owner master key — optional but recommended)
//   DATABASE_URL  (for accounts/usage)

const { requireMeteredCaller, recordUsage } = require('../lib/saas');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || 'https://coaihq.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let caller;
  try {
    caller = await requireMeteredCaller(req);
  } catch (authErr) {
    return res.status(authErr.statusCode || 401).json({
      error: authErr.message,
      upgrade: Boolean(authErr.upgrade),
    });
  }

  const {
    mode, location, lat, lng, radius = '8000', type,
    pagetoken, place_id, input
  } = req.query;

  if (mode === 'ping') {
    return res.status(200).json({
      status: 'authorized',
      admin: caller.admin,
      email: caller.email,
      plan: caller.plan,
      planName: caller.planName,
      usage: caller.usage,
      quota: caller.quota === Infinity ? 'unlimited' : caller.quota,
    });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY not set in Vercel env vars.' });
  }

  try {
    // Every mode below hits the Google API at least once. Usage is recorded
    // after the inputs are validated, so a rejected request costs nothing.
    // The nearby-search path records +1 more when it has to geocode first.

    if (mode === 'geocode') {
      if (!location) return res.status(400).json({ error: 'location param required.' });
      await recordUsage(caller.id, 1);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      return res.status(200).json(await (await fetch(url)).json());
    }

    if (mode === 'findplace') {
      if (!input) return res.status(400).json({ error: 'input param required.' });
      await recordUsage(caller.id, 1);
      const fields = [
        'place_id', 'name', 'formatted_address', 'business_status',
        'rating', 'user_ratings_total', 'geometry', 'types'
      ].join(',');
      const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json`
        + `?input=${encodeURIComponent(input)}`
        + `&inputtype=textquery`
        + `&fields=${encodeURIComponent(fields)}`
        + `&key=${apiKey}`;
      return res.status(200).json(await (await fetch(url)).json());
    }

    if (mode === 'placedetails') {
      if (!place_id) return res.status(400).json({ error: 'place_id param required.' });
      await recordUsage(caller.id, 1);
      // Basic + Contact fields only. Rating, review count and open-now already
      // come back from Nearby Search, so asking Details for them again only
      // added Google's Atmosphere charge to every lookup.
      const fields = [
        'name', 'formatted_phone_number', 'international_phone_number',
        'website', 'formatted_address', 'business_status', 'url', 'types'
      ].join(',');
      const url = `https://maps.googleapis.com/maps/api/place/details/json`
        + `?place_id=${encodeURIComponent(place_id)}`
        + `&fields=${encodeURIComponent(fields)}`
        + `&key=${apiKey}`;
      return res.status(200).json(await (await fetch(url)).json());
    }

    if (!type) return res.status(400).json({ error: 'type param required.' });

    // Inputs go into Google's URL, so accept only plain numbers in range.
    const radiusNum = Number(radius);
    if (!Number.isInteger(radiusNum) || radiusNum < 1 || radiusNum > 50000) {
      return res.status(400).json({ error: 'radius must be a whole number of meters between 1 and 50000.' });
    }
    const hasLat = lat !== undefined && lat !== '';
    const hasLng = lng !== undefined && lng !== '';
    if ((hasLat || hasLng) && !(Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) &&
        Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180)) {
      return res.status(400).json({ error: 'lat and lng must be valid coordinates.' });
    }
    await recordUsage(caller.id, 1);

    let resolvedLat = hasLat ? Number(lat) : undefined;
    let resolvedLng = hasLng ? Number(lng) : undefined;
    if (resolvedLat === undefined || resolvedLng === undefined) {
      if (!location) return res.status(400).json({ error: 'Provide lat+lng or location.' });
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      await recordUsage(caller.id, 1); // the geocode counts too
      const geoData = await (await fetch(geoUrl)).json();
      if (geoData.status !== 'OK' || !geoData.results.length) {
        return res.status(400).json({ error: 'Geocode failed: ' + geoData.status });
      }
      resolvedLat = geoData.results[0].geometry.location.lat;
      resolvedLng = geoData.results[0].geometry.location.lng;
    }

    let placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
      + `?location=${resolvedLat},${resolvedLng}`
      + `&radius=${radiusNum}`
      + `&keyword=${encodeURIComponent(type)}`
      + `&key=${apiKey}`;
    if (pagetoken) placesUrl += `&pagetoken=${encodeURIComponent(pagetoken)}`;

    return res.status(200).json(await (await fetch(placesUrl)).json());
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};