/**
 * Front door (S2-A5): Today after this device has been away an hour.
 * `eve-last-active` holds an epoch-ms stamp, shared by every eve page on the
 * device through localStorage. Pure: callers pass storage and the clock.
 * Design: docs/design-today-s2.md.
 */
const FrontDoor = {
  KEY: 'eve-last-active',
  AWAY_MS: 3600000,

  // A missing or unparseable stamp counts as away; exactly AWAY_MS counts too.
  isAway(raw, now) {
    if (raw === null || raw === undefined || raw === '') return true;
    const stamp = Number(raw);
    if (!Number.isFinite(stamp)) return true;
    return now - stamp >= FrontDoor.AWAY_MS;
  },

  read(storage) {
    try { return storage ? storage.getItem(FrontDoor.KEY) : null; } catch { return null; }
  },

  stamp(storage, now) {
    try { if (storage) storage.setItem(FrontDoor.KEY, String(now)); } catch { /* storage full or blocked: next open counts as away */ }
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = FrontDoor;
