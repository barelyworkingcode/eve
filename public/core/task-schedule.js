/**
 * TaskSchedule — translation between the task dialog's inputs and
 * relayScheduler's schedule wire shape.
 *
 * relayScheduler accepts full lowercase day names for weekly schedules and an
 * RFC 3339 `at` for one-off schedules. The dialog's inputs are short day
 * labels and zone-less `datetime-local` values. Older tasks may still carry
 * short day names or a `datetime` key, so readers accept both.
 */
const TaskSchedule = {
  WEEKDAYS: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],

  normalizeDay(day) {
    if (typeof day !== 'string' || !day) return null;
    const lower = day.toLowerCase();
    return TaskSchedule.WEEKDAYS.find(d => d === lower || d.slice(0, 3) === lower) || null;
  },

  shortDay(day) {
    const full = TaskSchedule.normalizeDay(day);
    if (!full) return day;
    return full.charAt(0).toUpperCase() + full.slice(1, 3);
  },

  toRfc3339(localValue) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue || '');
    if (!match) return '';
    const [, y, mo, d, h, mi] = match.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, 0);
    if (Number.isNaN(date.getTime())) return '';
    // getTimezoneOffset is minutes *behind* UTC, so its sign is inverted.
    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    return `${TaskSchedule._localStamp(date)}:00${sign}${TaskSchedule._pad(Math.floor(abs / 60))}:${TaskSchedule._pad(abs % 60)}`;
  },

  toLocalInput(schedule) {
    if (!schedule) return '';
    if (schedule.at) {
      const date = new Date(schedule.at);
      return Number.isNaN(date.getTime()) ? '' : TaskSchedule._localStamp(date);
    }
    return schedule.datetime || '';
  },

  _localStamp(date) {
    const p = TaskSchedule._pad;
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  },

  _pad(n) {
    return String(n).padStart(2, '0');
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TaskSchedule;
}
