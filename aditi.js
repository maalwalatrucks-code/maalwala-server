// aditi.js — integration with Aditi Tracking's "Token Based Pull API"
// (their platform is white-labeled as "Trakzee" under the hood).
//
// This is a PULL integration: we ask Aditi for locations whenever we
// want them (see server.js's /api/fleet/sync-aditi route), rather than
// them pushing to us. Credentials live only in environment variables —
// never in this codebase, never sent to the frontend.

const BASE_URL = process.env.ADITI_BASE_URL || 'http://13.126.244.90/webservice';
const PROJECT_ID = process.env.ADITI_PROJECT_ID || '37'; // 37 = Trakzee project, per Aditi's docs

let cachedToken = null;
let tokenFetchedAt = 0;
const TOKEN_MAX_AGE_MS = 20 * 60 * 1000; // refresh token every 20 min to be safe; adjust if Aditi documents an exact expiry

function isConfigured() {
  return Boolean(process.env.ADITI_USERNAME && process.env.ADITI_PASSWORD && process.env.ADITI_COMPANY_NAME);
}

async function generateAccessToken() {
  const res = await fetch(`${BASE_URL}?token=generateAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADITI_USERNAME,
      password: process.env.ADITI_PASSWORD,
    }),
  });
  const data = await res.json().catch(() => ({}));
  const token = data?.data?.[0]?.token || data?.token;
  if (!res.ok || !token) {
    throw new Error('Could not get an access token from Aditi Tracking — check ADITI_USERNAME/ADITI_PASSWORD.');
  }
  return token;
}

async function getToken(forceRefresh = false) {
  const stale = Date.now() - tokenFetchedAt > TOKEN_MAX_AGE_MS;
  if (!cachedToken || stale || forceRefresh) {
    cachedToken = await generateAccessToken();
    tokenFetchedAt = Date.now();
  }
  return cachedToken;
}

// vehicleNumbers: array of strings, e.g. ['GJ01KT0057', 'GJ18BT5996']
async function getLiveData(vehicleNumbers) {
  if (!isConfigured()) {
    throw new Error('Aditi Tracking is not configured on this server yet (missing ADITI_* environment variables).');
  }
  if (!vehicleNumbers.length) return [];

  async function callOnce(token) {
    const res = await fetch(`${BASE_URL}?token=getTokenBaseLiveData&ProjectId=${PROJECT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'auth-code': token },
      body: JSON.stringify({
        company_names: process.env.ADITI_COMPANY_NAME,
        vehicle_nos: vehicleNumbers.join(','),
        format: 'json',
      }),
    });
    return res;
  }

  let token = await getToken();
  let res = await callOnce(token);

  // If the token expired server-side, retry once with a freshly generated one.
  if (res.status === 401 || res.status === 403) {
    token = await getToken(true);
    res = await callOnce(token);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `Aditi Tracking request failed (HTTP ${res.status})`);
  }

  const rows = data?.root?.[0]?.VehicleData || data?.VehicleData || [];
  return rows.map((r) => ({
    vehicleNumber: (r.Vehicle_No || '').toUpperCase(),
    lat: parseFloat(r.Latitude),
    lng: parseFloat(r.Longitude),
    speed: r.Speed != null ? parseFloat(r.Speed) : null,
    datetime: r.Datetime || null,
  })).filter((r) => !isNaN(r.lat) && !isNaN(r.lng));
}

module.exports = { isConfigured, getLiveData };
