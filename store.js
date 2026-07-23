// store.js — MongoDB Atlas-backed persistent store.
//
// Replaces the file-based store: Render's free tier disk is wiped on
// every redeploy (which happens whenever new backend code is pushed),
// so real posted data — trucks, loads, accounts, records — was only
// ever living in temporary space. MongoDB Atlas's free M0 tier
// persists forever, independent of Render's container lifecycle.
//
// Every collection stores plain objects with our own string `id`
// field (not Mongo's ObjectId) so the frontend never has to know or
// care that Mongo is involved — this file is the only thing that
// changed; server.js and every route is unaffected.
const { MongoClient } = require('mongodb');

let client;
let dbPromise;

function getDb() {
  if (!dbPromise) {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not set — add it to your .env (locally) or Render environment variables (in production).');
    }
    client = new MongoClient(process.env.MONGODB_URI);
    dbPromise = client.connect().then(() => client.db(process.env.MONGODB_DB || 'maalwala'));
  }
  return dbPromise;
}

async function col(name) {
  const db = await getDb();
  return db.collection(name);
}

function id() {
  return 'id' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
// Strips everything except digits and keeps the last 10 — so "+91 98765-43210",
// "9876543210", and "919876543210" all match the same user.
function normalizePhoneForLookup(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// ---------- Generic helpers ----------
async function listAll(name, sort = { ts: -1 }) {
  const c = await col(name);
  return c.find({}, { projection: { _id: 0 } }).sort(sort).toArray();
}
async function insertOne(name, doc) {
  const c = await col(name);
  await c.insertOne({ ...doc });
  const { _id, ...clean } = doc;
  return clean;
}
async function removeById(name, idVal) {
  const c = await col(name);
  await c.deleteOne({ id: idVal });
}
async function updateById(name, idVal, patch) {
  const c = await col(name);
  await c.updateOne({ id: idVal }, { $set: patch });
  return c.findOne({ id: idVal }, { projection: { _id: 0 } });
}
async function getSingleton(name, fallback) {
  const c = await col(name);
  const doc = await c.findOne({ _key: 'singleton' }, { projection: { _id: 0, _key: 0 } });
  return doc || fallback;
}
async function saveSingleton(name, value) {
  const c = await col(name);
  await c.updateOne({ _key: 'singleton' }, { $set: { ...value, _key: 'singleton' } }, { upsert: true });
}

module.exports = {
  id,
  loads: {
    all: () => listAll('loads'),
    insert: (item) => insertOne('loads', item),
    removeById: (idVal) => removeById('loads', idVal),
  },
  trucks: {
    all: () => listAll('trucks'),
    insert: (item) => insertOne('trucks', item),
    removeById: (idVal) => removeById('trucks', idVal),
    updateById: (idVal, patch) => updateById('trucks', idVal, patch),
  },
  groups: {
    all: () => listAll('groups', { _id: 1 }),
    insert: (item) => insertOne('groups', item),
    removeById: (idVal) => removeById('groups', idVal),
  },
  contacts: {
    all: () => listAll('contacts', { optedInAt: -1 }),
    insert: (item) => insertOne('contacts', item),
    removeById: (idVal) => removeById('contacts', idVal),
    findByNumber: async (number) => {
      const c = await col('contacts');
      return c.findOne({ number }, { projection: { _id: 0 } });
    },
  },
  profile: {
    get: () => getSingleton('profile', { name: '', role: 'Transporter', city: '', phone: '', gst: '', drivers: [] }),
    save: (p) => saveSingleton('profile', p),
  },
  savedSearches: {
    all: () => listAll('savedSearches'),
    insert: (item) => insertOne('savedSearches', item),
    removeById: (idVal) => removeById('savedSearches', idVal),
  },
  positions: {
    insert: (ping) => insertOne('positions', ping),
    latestPerTruck: async () => {
      const c = await col('positions');
      const all = await c.find({}, { projection: { _id: 0 } }).sort({ ts: 1 }).toArray();
      const latest = {};
      all.forEach((p) => { latest[p.truckId] = p; });
      return Object.values(latest);
    },
    historyForTruck: async (truckId) => {
      const c = await col('positions');
      return c.find({ truckId }, { projection: { _id: 0 } }).sort({ ts: 1 }).toArray();
    },
    trimOldest: async (keepLast = 5000) => {
      const c = await col('positions');
      const count = await c.countDocuments();
      if (count > keepLast) {
        const excess = count - keepLast;
        const oldest = await c.find({}, { projection: { _id: 1 } }).sort({ ts: 1 }).limit(excess).toArray();
        await c.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
      }
    },
  },
  records: {
    allByKind: async (kind) => {
      const c = await col('records');
      return c.find({ kind }, { projection: { _id: 0 } }).sort({ ts: -1 }).toArray();
    },
    insert: (item) => insertOne('records', item),
    removeById: (idVal) => removeById('records', idVal),
    updateById: (idVal, patch) => updateById('records', idVal, patch),
  },
  bookings: {
    all: () => listAll('bookings'),
    findById: async (idVal) => {
      const c = await col('bookings');
      return c.findOne({ id: idVal }, { projection: { _id: 0 } });
    },
    insert: (item) => insertOne('bookings', item),
    updateById: (idVal, patch) => updateById('bookings', idVal, patch),
    // Bookings that are past their auto-release window, delivered, undisputed —
    // used by the release-check sweep instead of a real cron job.
    findReleasable: async (cutoffTs) => {
      const c = await col('bookings');
      return c.find({
        status: 'delivered_pending_confirmation',
        deliveryConfirmedAt: { $lte: cutoffTs },
      }, { projection: { _id: 0 } }).toArray();
    },
  },
  users: {
    all: () => listAll('users'),
    findByEmail: async (email) => {
      const c = await col('users');
      const all = await c.find({}, { projection: { _id: 0 } }).toArray();
      return all.find((u) => u.email && u.email.toLowerCase() === String(email).toLowerCase()) || null;
    },
    findByPhone: async (phone) => {
      const c = await col('users');
      return c.findOne({ phone: normalizePhoneForLookup(phone) }, { projection: { _id: 0 } });
    },
    findById: async (idVal) => {
      const c = await col('users');
      return c.findOne({ id: idVal }, { projection: { _id: 0 } });
    },
    insert: (item) => insertOne('users', item),
  },
  otps: {
    insert: (item) => insertOne('otps', item),
    findLatestForPhone: async (phone) => {
      const c = await col('otps');
      const all = await c.find({ phone: normalizePhoneForLookup(phone) }, { projection: { _id: 0 } }).sort({ ts: -1 }).limit(1).toArray();
      return all[0] || null;
    },
    removeForPhone: async (phone) => {
      const c = await col('otps');
      await c.deleteMany({ phone: normalizePhoneForLookup(phone) });
    },
  },
  sessions: {
    insert: (item) => insertOne('sessions', item),
    findByToken: async (token) => {
      const c = await col('sessions');
      return c.findOne({ token }, { projection: { _id: 0 } });
    },
    removeByToken: async (token) => {
      const c = await col('sessions');
      await c.deleteOne({ token });
    },
  },
};
