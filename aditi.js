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
  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave data as {} */ }

  // Their docs' example response shape isn't 100% precise from a screenshot,
  // so try every reasonable place a token might live before giving up.
  const token =
    (typeof data?.data === 'string' && data.data) ||
    data?.data?.[0]?.token ||
    data?.data?.token ||
    data?.token ||
    data?.[0]?.data ||
    data?.[0]?.token ||
    null;

  if (!res.ok || !token) {
    // Log the real shape server-side (Render → Logs) without exposing
    // credentials, so this can actually be debugged if it fails again.
    console.error('Aditi generateAccessToken failed. HTTP status:', res.status, 'Response body:', rawText.slice(0, 500));
    throw new Error(`Could not get an access token from Aditi Tracking (HTTP ${res.status}). Check ADITI_USERNAME/ADITI_PASSWORD are correct, and check the Render logs for the exact response Aditi sent back.`);
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

  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave data as {} */ }

  if (!res.ok) {
    console.error('Aditi getLiveData HTTP error. Status:', res.status, 'Body:', rawText.slice(0, 800));
    throw new Error(data?.message || `Aditi Tracking request failed (HTTP ${res.status})`);
  }

  // Same situation as the token endpoint: their docs show a screenshot, not an
  // exact spec, so try every plausible place the vehicle array could be.
  const rows =
    data?.root?.[0]?.VehicleData ||
    data?.root?.VehicleData ||
    data?.VehicleData ||
    data?.data?.[0]?.VehicleData ||
    data?.data?.VehicleData ||
    (Array.isArray(data?.root) ? data.root : null) ||
    [];

  if (!rows.length) {
    // Log the real response shape so this is debuggable from Render's logs
    // instead of guessing again — this is the single most useful line if
    // vehicles still don't match after this fix.
    console.error('Aditi getLiveData returned no rows we could parse. Raw response:', rawText.slice(0, 1500));
  }

  return rows.map((r) => ({
    vehicleNumber: (r.Vehicle_No || r.VehicleNo || r.Vehicle_Number || r.Registration || '').toString().toUpperCase(),
    lat: parseFloat(r.Latitude ?? r.latitude ?? r.lat),
    lng: parseFloat(r.Longitude ?? r.longitude ?? r.lng),
    speed: (r.Speed ?? r.speed) != null ? parseFloat(r.Speed ?? r.speed) : null,
    datetime: r.Datetime || r.datetime || null,
  })).filter((r) => !isNaN(r.lat) && !isNaN(r.lng));
}

module.exports = { isConfigured, getLiveData };
