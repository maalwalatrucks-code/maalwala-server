require('dotenv').config();
const express = require('express');
const cors = require('cors');
const store = require('./store');
const whatsapp = require('./whatsapp');
const auth = require('./auth');
const aditi = require('./aditi');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '8mb' })); // POD photos come through as base64, so allow a larger body

const PORT = process.env.PORT || 4000;

// Small helper so every route doesn't need its own try/catch boilerplate
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || 'Something went wrong on the server.' });
    }
  };
}

// ---------------------------------------------------------------
// Auth — real accounts with hashed passwords and session tokens.
// Note: this authenticates users, but most of the app's business
// data (loads, trucks, profile, records) is still shared/single-
// tenant rather than scoped per account — see project notes.
// ---------------------------------------------------------------
app.post('/api/auth/signup', handle(async (req, res) => {
  const { businessName, email, password } = req.body || {};
  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'businessName, email and password are required' });
  }
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = await store.users.findByEmail(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists — try signing in instead.' });

  const { salt, hash } = auth.hashPassword(password);
  const user = { id: store.id(), businessName, email: String(email).toLowerCase(), salt, hash, ts: Date.now() };
  await store.users.insert(user);
  const token = auth.generateToken();
  await store.sessions.insert({ token, userId: user.id, ts: Date.now() });
  res.status(201).json({ token, user: { id: user.id, businessName: user.businessName, email: user.email } });
}));

app.post('/api/auth/login', handle(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const user = await store.users.findByEmail(email);
  if (!user || !auth.verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = auth.generateToken();
  await store.sessions.insert({ token, userId: user.id, ts: Date.now() });
  res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email } });
}));

app.post('/api/auth/logout', handle(async (req, res) => {
  const { token } = req.body || {};
  if (token) await store.sessions.removeByToken(token);
  res.status(204).end();
}));

app.get('/api/auth/me', handle(async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  const session = await store.sessions.findByToken(token);
  if (!session) return res.status(401).json({ error: 'Session expired or invalid' });
  const user = await store.users.findById(session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user: { id: user.id, businessName: user.businessName, email: user.email } });
}));

// ---------------------------------------------------------------
// Fleet positions (Sprint 3 GPS-ready architecture)
// ---------------------------------------------------------------
app.get('/api/fleet/positions', handle(async (req, res) => {
  res.json(await store.positions.latestPerTruck());
}));

app.get('/api/fleet/positions/:truckId/history', handle(async (req, res) => {
  res.json(await store.positions.historyForTruck(req.params.truckId));
}));

app.post('/api/fleet/ping', handle(async (req, res) => {
  const b = req.body || {};
  if (!b.truckId || typeof b.lat !== 'number' || typeof b.lng !== 'number') {
    return res.status(400).json({ error: 'truckId, lat and lng (numbers) are required' });
  }
  const ping = { truckId: b.truckId, lat: b.lat, lng: b.lng, speed: b.speed || null, ts: b.ts || Date.now() };
  await store.positions.insert(ping);
  store.positions.trimOldest(5000).catch(() => {}); // best-effort cleanup, don't block the response
  res.status(201).json(ping);
}));

app.get('/api/fleet/aditi-status', (req, res) => {
  res.json({ configured: aditi.isConfigured() });
});

// Pull-model sync: ask Aditi Tracking for current positions of every posted
// truck that has a vehicleNumber set, then feed each one into the same
// positions store the driver-tracking page and /api/fleet/ping use.
app.post('/api/fleet/sync-aditi', handle(async (req, res) => {
  if (!aditi.isConfigured()) {
    return res.status(400).json({ error: 'Aditi Tracking is not configured on this server yet.' });
  }
  const trucks = (await store.trucks.all()).filter((t) => t.vehicleNumber);
  if (!trucks.length) {
    return res.json({ synced: 0, note: 'No posted trucks have a vehicle number set yet.' });
  }

  const vehicleNumbers = trucks.map((t) => t.vehicleNumber);
  const rows = await aditi.getLiveData(vehicleNumbers);

  let synced = 0;
  const notFound = [];
  for (const truck of trucks) {
    const match = rows.find((r) => r.vehicleNumber === truck.vehicleNumber);
    if (match) {
      await store.positions.insert({ truckId: truck.id, lat: match.lat, lng: match.lng, speed: match.speed, ts: Date.now() });
      synced++;
    } else {
      notFound.push(truck.vehicleNumber);
    }
  }
  res.json({ synced, requested: vehicleNumbers.length, notFound });
}));

// ---------------------------------------------------------------
// Loads
// ---------------------------------------------------------------
app.get('/api/loads', handle(async (req, res) => {
  res.json(await store.loads.all());
}));

app.post('/api/loads', handle(async (req, res) => {
  const b = req.body || {};
  if (!b.from || !b.to || !b.material) return res.status(400).json({ error: 'from, to and material are required' });
  const item = {
    id: store.id(), from: b.from, to: b.to, material: b.material,
    weight: b.weight || null, truckType: b.truckType || 'Open Body',
    rate: b.rate || null, date: b.date || null,
    poster: b.poster || 'Unknown', phone: b.phone || '',
    verified: Boolean(b.verified), ts: Date.now(),
  };
  res.status(201).json(await store.loads.insert(item));
}));

app.delete('/api/loads/:id', handle(async (req, res) => {
  await store.loads.removeById(req.params.id);
  res.status(204).end();
}));

// ---------------------------------------------------------------
// Trucks
// ---------------------------------------------------------------
app.get('/api/trucks', handle(async (req, res) => {
  res.json(await store.trucks.all());
}));

app.post('/api/trucks', handle(async (req, res) => {
  const b = req.body || {};
  if (!b.from || !b.truckType || !b.capacity) return res.status(400).json({ error: 'from, truckType and capacity are required' });
  const item = {
    id: store.id(), from: b.from, to: b.to || 'Anywhere',
    truckType: b.truckType, capacity: b.capacity, date: b.date || null,
    poster: b.poster || 'Unknown', phone: b.phone || '',
    driverName: b.driverName || '', driverPhone: b.driverPhone || '',
    vehicleNumber: (b.vehicleNumber || '').toUpperCase(),
    verified: Boolean(b.verified), ts: Date.now(),
  };
  res.status(201).json(await store.trucks.insert(item));
}));

app.delete('/api/trucks/:id', handle(async (req, res) => {
  await store.trucks.removeById(req.params.id);
  res.status(204).end();
}));

// ---------------------------------------------------------------
// Groups
// ---------------------------------------------------------------
app.get('/api/groups', handle(async (req, res) => res.json(await store.groups.all())));

app.post('/api/groups', handle(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.link) return res.status(400).json({ error: 'name and link are required' });
  res.status(201).json(await store.groups.insert({ id: store.id(), name: b.name, link: b.link, ts: Date.now() }));
}));

app.delete('/api/groups/:id', handle(async (req, res) => {
  await store.groups.removeById(req.params.id);
  res.status(204).end();
}));

// ---------------------------------------------------------------
// Opted-in WhatsApp contacts
// ---------------------------------------------------------------
app.get('/api/contacts', handle(async (req, res) => res.json(await store.contacts.all())));

app.delete('/api/contacts/:id', handle(async (req, res) => {
  await store.contacts.removeById(req.params.id);
  res.status(204).end();
}));

// ---------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------
app.get('/api/saved-searches', handle(async (req, res) => res.json(await store.savedSearches.all())));

app.post('/api/saved-searches', handle(async (req, res) => {
  const b = req.body || {};
  if (!b.type || (!b.from && !b.to && !b.truckType)) {
    return res.status(400).json({ error: 'type and at least one filter (from/to/truckType) are required' });
  }
  const item = {
    id: store.id(), type: b.type, from: b.from || '', to: b.to || '', truckType: b.truckType || '',
    label: b.label || [b.from, b.to].filter(Boolean).join(' → ') || b.truckType || 'Search',
    ts: Date.now(),
  };
  res.status(201).json(await store.savedSearches.insert(item));
}));

app.delete('/api/saved-searches/:id', handle(async (req, res) => {
  await store.savedSearches.removeById(req.params.id);
  res.status(204).end();
}));

// ---------------------------------------------------------------
// Profile
// ---------------------------------------------------------------
app.get('/api/profile', handle(async (req, res) => res.json(await store.profile.get())));
app.post('/api/profile', handle(async (req, res) => {
  await store.profile.save(req.body || {});
  res.json(await store.profile.get());
}));

// ---------------------------------------------------------------
// WhatsApp Cloud API status + webhook
// ---------------------------------------------------------------
app.get('/api/whatsapp/status', (req, res) => res.json({ configured: whatsapp.isConfigured() }));

app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/api/whatsapp/webhook', handle(async (req, res) => {
  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const messages = change?.messages;
  if (messages && messages.length) {
    const optInWord = (process.env.OPT_IN_KEYWORD || 'JOIN').toLowerCase();
    const optOutWord = (process.env.OPT_OUT_KEYWORD || 'STOP').toLowerCase();
    for (const m of messages) {
      const from = m.from;
      const text = (m.text?.body || '').trim().toLowerCase();
      if (text === optInWord) {
        const existing = await store.contacts.findByNumber(from);
        if (!existing) await store.contacts.insert({ id: store.id(), number: from, optedInAt: Date.now() });
        whatsapp.sendTextMessage(from, "You're in! You'll now get load & truck alerts from Maalwala. Reply STOP anytime to leave.").catch(() => {});
      } else if (text === optOutWord) {
        const existing = await store.contacts.findByNumber(from);
        if (existing) await store.contacts.removeById(existing.id);
        whatsapp.sendTextMessage(from, "You've been removed from Maalwala alerts.").catch(() => {});
      }
    }
  }
  res.sendStatus(200);
}));

app.post('/api/whatsapp/broadcast', handle(async (req, res) => {
  if (!whatsapp.isConfigured()) return res.status(400).json({ error: 'WhatsApp Cloud API is not configured on this server yet.' });
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  const contacts = await store.contacts.all();
  if (!contacts.length) return res.status(200).json({ sent: 0, failed: 0, note: 'No opted-in contacts yet.' });
  let sent = 0, failed = 0;
  const errors = [];
  for (const c of contacts) {
    try { await whatsapp.sendTextMessage(c.number, message); sent++; }
    catch (e) { failed++; errors.push({ number: c.number, error: e.message }); }
  }
  res.json({ sent, failed, errors });
}));

// ---------------------------------------------------------------
// Sprint 4 — ERP records: invoices, expenses, maintenance, salary,
// fuel, POD. One collection, filtered by `kind`, so the frontend
// can add new record types without new backend routes.
// ---------------------------------------------------------------
const RECORD_KINDS = ['invoice', 'expense', 'maintenance', 'salary', 'fuel', 'pod'];

app.get('/api/records', handle(async (req, res) => {
  const kind = req.query.kind;
  if (!RECORD_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${RECORD_KINDS.join(', ')}` });
  res.json(await store.records.allByKind(kind));
}));

app.post('/api/records', handle(async (req, res) => {
  const b = req.body || {};
  if (!RECORD_KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of: ${RECORD_KINDS.join(', ')}` });
  // 8mb JSON body cap (set above) keeps a single POD photo request reasonable;
  // this is file-based storage on disk, so this isn't for storing thousands
  // of full-resolution photos — fine for a small fleet's records.
  const item = { ...b, id: store.id(), ts: Date.now() };
  res.status(201).json(await store.records.insert(item));
}));

app.patch('/api/records/:id', handle(async (req, res) => {
  const updated = await store.records.updateById(req.params.id, req.body || {});
  res.json(updated);
}));

app.delete('/api/records/:id', handle(async (req, res) => {
  await store.records.removeById(req.params.id);
  res.status(204).end();
}));

// ---------------------------------------------------------------
// Auto-seed — if this server has no loads/trucks yet (fresh deploy,
// or data reset by Render's free-tier restarts), populate a few
// realistic sample listings so the site never looks empty. Runs
// every startup but only inserts anything when both are empty.
// ---------------------------------------------------------------
async function seedIfEmpty() {
  try {
    const [loads, trucks] = await Promise.all([store.loads.all(), store.trucks.all()]);
    if (loads.length > 0 || trucks.length > 0) return;

    const sampleLoads = [
      { from: 'Ahmedabad', to: 'Indore', material: 'Cotton Bales', weight: 14, truckType: 'Open Body', rate: 38000, date: '2026-07-18', poster: 'Patel Roadlines', phone: '9825000001', verified: true },
      { from: 'Surat', to: 'Pune', material: 'Textile Rolls', weight: 9, truckType: 'Container', rate: 29500, date: '2026-07-17', poster: 'Shree Ganesh Transport', phone: '9825000002', verified: false },
      { from: 'Rajkot', to: 'Delhi', material: 'Ceramic Tiles', weight: 18, truckType: 'Trailer', rate: 64000, date: '2026-07-19', poster: 'Om Logistics', phone: '9825000003', verified: true },
      { from: 'Vadodara', to: 'Nagpur', material: 'Chemicals (Drums)', weight: 12, truckType: 'Tanker', rate: 41000, date: '2026-07-20', poster: 'Narmada Carriers', phone: '9825000004', verified: false },
    ];
    const sampleTrucks = [
      { from: 'Ahmedabad', to: 'Anywhere Mumbai side', truckType: 'Open Body', capacity: 16, date: '2026-07-17', poster: 'Desai Fleet Owners', phone: '9825000011', driverName: '', driverPhone: '', verified: true },
      { from: 'Indore', to: 'Ahmedabad / Rajkot', truckType: 'Container', capacity: 10, date: '2026-07-18', poster: 'Malwa Transport Co.', phone: '9825000012', driverName: '', driverPhone: '', verified: false },
      { from: 'Jaipur', to: 'Anywhere North', truckType: 'Trailer', capacity: 20, date: '2026-07-19', poster: 'Rajputana Roadways', phone: '9825000013', driverName: '', driverPhone: '', verified: true },
    ];

    for (const l of sampleLoads) {
      await store.loads.insert({ id: store.id(), ...l, ts: Date.now() });
    }
    for (const t of sampleTrucks) {
      await store.trucks.insert({ id: store.id(), ...t, ts: Date.now() });
    }
    console.log('Seeded sample loads and trucks (server had none).');
  } catch (e) {
    console.error('Seeding failed (non-fatal):', e.message);
  }
}

app.listen(PORT, async () => {
  console.log(`Maalwala API listening on http://localhost:${PORT}`);
  console.log(`WhatsApp Cloud API configured: ${whatsapp.isConfigured()}`);
  await seedIfEmpty();
});
