// ProTeen Nation — Scholarship & Grant Database

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/scholarships.json');

function initFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ scholarships: [] }, null, 2));
}

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { scholarships: [] }; }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

const scholarshipDB = {
  // Save a new scholarship (dedup by URL)
  save(scholarship) {
    initFile();
    const data = readDB();
    const existing = data.scholarships.findIndex(s => s.url === scholarship.url);
    if (existing >= 0) {
      // Update if found — deadline/amount may have changed
      data.scholarships[existing] = { ...data.scholarships[existing], ...scholarship, updatedAt: new Date().toISOString() };
    } else {
      data.scholarships.unshift(scholarship);
    }
    // Keep last 500
    if (data.scholarships.length > 500) data.scholarships = data.scholarships.slice(0, 500);
    writeDB(data);
    return scholarship;
  },

  // Get all active scholarships (not expired), sorted by deadline
  getActive({ type, limit } = {}) {
    initFile();
    const data = readDB();
    const today = new Date().toISOString().split('T')[0];
    let list = data.scholarships.filter(s => {
      if (s.status === 'expired') return false;
      // Auto-expire if deadline has passed
      if (s.deadlineISO && s.deadlineISO < today) return false;
      return true;
    });
    if (type && type !== 'all') list = list.filter(s => s.type === type);
    // Sort: no-deadline last, otherwise soonest first
    list.sort((a, b) => {
      if (!a.deadlineISO && !b.deadlineISO) return 0;
      if (!a.deadlineISO) return 1;
      if (!b.deadlineISO) return -1;
      return a.deadlineISO.localeCompare(b.deadlineISO);
    });
    if (limit) list = list.slice(0, parseInt(limit));
    return list;
  },

  getAll() {
    initFile();
    return readDB().scholarships;
  },

  // Mark expired manually
  expire(id) {
    initFile();
    const data = readDB();
    const idx = data.scholarships.findIndex(s => s.id === id);
    if (idx >= 0) data.scholarships[idx].status = 'expired';
    writeDB(data);
  },

  // Stats
  getStats() {
    initFile();
    const all = readDB().scholarships;
    const today = new Date().toISOString().split('T')[0];
    const active = all.filter(s => s.status !== 'expired' && (!s.deadlineISO || s.deadlineISO >= today));
    return {
      total: all.length,
      active: active.length,
      scholarships: active.filter(s => s.type === 'scholarship').length,
      grants:       active.filter(s => s.type === 'grant').length,
      contests:     active.filter(s => s.type === 'contest').length,
    };
  },
};

module.exports = { scholarshipDB };
