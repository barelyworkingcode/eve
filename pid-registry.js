const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, 'data', 'pids.json');

let pids = new Set();

// Load existing PIDs on require
try {
  if (fs.existsSync(PID_FILE)) {
    const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (Array.isArray(data)) {
      pids = new Set(data);
    }
  }
} catch (e) {
  // Corrupt file -- start fresh
  pids = new Set();
}

function persist() {
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify([...pids]));
  } catch (e) {
    console.error('[PID Registry] Failed to write:', e.message);
  }
}

module.exports = {
  add(pid) {
    if (pid == null) return;
    pids.add(pid);
    persist();
  },

  remove(pid) {
    if (pid == null) return;
    pids.delete(pid);
    persist();
  },

  getAll() {
    return [...pids];
  },

  clear() {
    pids.clear();
    persist();
  }
};
