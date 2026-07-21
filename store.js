// store.js — file-backed JSON store (reverted from MongoDB).
//
// Simple to run locally with zero setup. The one thing to know:
// on Render's free tier, this disk is wiped on every restart or
// redeploy, so data isn't permanent there. Fine for testing; if
// you outgrow that, swapping this file for a database later is a
// contained change — every route in server.js only calls the
// methods exported below, never touches storage directly.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  loads: path.join(DATA_DIR, 'loads.json'),
  trucks: path.join(DATA_DIR, 'trucks.json'),
  groups: path.join(DATA_DIR, 'groups.json'),
  contacts: path.join(DATA_DIR, 'contacts.json'),
  profile: path.join(DATA_DIR, 'profile.json'),
  savedSearches: path.join(DATA_DIR, 'savedSearches.json'),
  positions: path.join(DATA_DIR, 'positions.json'),
  records: path.join(DATA_DIR, 'records.json'),
  users: path.join(DATA_DIR, 'users.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
};

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('store read error', file, e.message);
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function id() {
  return 'id' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------- Generic helpers for simple "array of records" files ----------
function listAll(file) {
  return readJSON(file, []);
}
function insertOne(file, item) {
  const list = readJSON(file, []);
  list.unshift(item);
  writeJSON(file, list);
  return item;
}
function removeById(file, idVal) {
  const list = readJSON(file, []).filter((x) => x.id !== idVal);
  writeJSON(file, list);
}
function updateById(file, idVal, patch) {
  const list = readJSON(file, []);
  const idx = list.findIndex((x) => x.id === idVal);
  if (idx > -1) {
    list[idx] = { ...list[idx], ...patch };
    writeJSON(file, list);
    return list[idx];
  }
  return null;
}

module.exports = {
  id,
  loads: {
    all: () => listAll(FILES.loads).sort((a, b) => b.ts - a.ts),
    insert: (item) => insertOne(FILES.loads, item),
    removeById: (idVal) => removeById(FILES.loads, idVal),
  },
  trucks: {
    all: () => listAll(FILES.trucks).sort((a, b) => b.ts - a.ts),
    insert: (item) => insertOne(FILES.trucks, item),
    removeById: (idVal) => removeById(FILES.trucks, idVal),
  },
  groups: {
    all: () => listAll(FILES.groups),
    insert: (item) => insertOne(FILES.groups, item),
    removeById: (idVal) => removeById(FILES.groups, idVal),
  },
  contacts: {
    all: () => listAll(FILES.contacts),
    insert: (item) => insertOne(FILES.contacts, item),
    removeById: (idVal) => removeById(FILES.contacts, idVal),
    findByNumber: (number) => listAll(FILES.contacts).find((c) => c.number === number) || null,
  },
  profile: {
    get: () => readJSON(FILES.profile, { name: '', role: 'Transporter', city: '', phone: '', gst: '', drivers: [] }),
    save: (p) => writeJSON(FILES.profile, p),
  },
  savedSearches: {
    all: () => listAll(FILES.savedSearches),
    insert: (item) => insertOne(FILES.savedSearches, item),
    removeById: (idVal) => removeById(FILES.savedSearches, idVal),
  },
  positions: {
    insert: (ping) => insertOne(FILES.positions, ping),
    latestPerTruck: () => {
      const all = listAll(FILES.positions).sort((a, b) => a.ts - b.ts);
      const latest = {};
      all.forEach((p) => { latest[p.truckId] = p; });
      return Object.values(latest);
    },
    historyForTruck: (truckId) => listAll(FILES.positions).filter((p) => p.truckId === truckId).sort((a, b) => a.ts - b.ts),
    trimOldest: (keepLast = 5000) => {
      const all = listAll(FILES.positions);
      if (all.length > keepLast) writeJSON(FILES.positions, all.slice(-keepLast));
    },
  },
  records: {
    allByKind: (kind) => listAll(FILES.records).filter((r) => r.kind === kind).sort((a, b) => b.ts - a.ts),
    insert: (item) => insertOne(FILES.records, item),
    removeById: (idVal) => removeById(FILES.records, idVal),
    updateById: (idVal, patch) => updateById(FILES.records, idVal, patch),
  },
  users: {
    all: () => listAll(FILES.users),
    findByEmail: (email) => listAll(FILES.users).find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null,
    findById: (idVal) => listAll(FILES.users).find((u) => u.id === idVal) || null,
    insert: (item) => insertOne(FILES.users, item),
  },
  sessions: {
    insert: (item) => insertOne(FILES.sessions, item),
    findByToken: (token) => listAll(FILES.sessions).find((s) => s.token === token) || null,
    removeByToken: (token) => {
      const list = listAll(FILES.sessions).filter((s) => s.token !== token);
      writeJSON(FILES.sessions, list);
    },
  },
};
