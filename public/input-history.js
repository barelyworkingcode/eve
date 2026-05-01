class InputHistory {
  constructor(storageKey, limit) {
    this.storageKey = storageKey;
    this.limit = limit;
    this.entries = this._load();
    this.index = -1;
    this.draft = null;
  }

  push(text) {
    const trimmed = (text || '').trim();
    this.reset();
    if (!trimmed) return;
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) return;
    this.entries.push(trimmed);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    this._save();
  }

  prev(currentText) {
    if (this.entries.length === 0) return null;
    if (this.index === -1) {
      this.draft = currentText || '';
      this.index = this.entries.length - 1;
    } else if (this.index > 0) {
      this.index -= 1;
    } else {
      return null;
    }
    return this.entries[this.index];
  }

  next() {
    if (this.index === -1) return null;
    if (this.index < this.entries.length - 1) {
      this.index += 1;
      return this.entries[this.index];
    }
    const draft = this.draft || '';
    this.reset();
    return draft;
  }

  reset() {
    this.index = -1;
    this.draft = null;
  }

  _load() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter((s) => typeof s === 'string').slice(-this.limit);
    } catch {
      return [];
    }
  }

  // Persisted without a 24h expiry — command history is conventionally long-lived.
  _save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({
        entries: this.entries,
        savedAt: Date.now(),
      }));
    } catch {
      // ignore quota / unavailable storage
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = InputHistory;
}
