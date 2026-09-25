// relayScheduler accepts full lowercase day names and RFC 3339 `at`; the
// dialog's own inputs are short day names and zone-less datetime-local
// values. TZ is pinned before any Date use so offsets are deterministic.
process.env.TZ = 'Europe/Berlin';

const TaskSchedule = require('../../public/core/task-schedule');

function withTz(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { process.env.TZ = prev; }
}

describe('TaskSchedule', () => {
  it('lists the seven weekdays relayScheduler accepts, Monday first', () => {
    expect(TaskSchedule.WEEKDAYS).toEqual(
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  });

  it.each([
    ['mon', 'monday'],
    ['Mon', 'monday'],
    ['monday', 'monday'],
    ['Monday', 'monday'],
    ['sun', 'sunday'],
    ['funday', null],
    ['', null],
    [undefined, null],
  ])('normalizeDay(%p) -> %p', (input, expected) => {
    expect(TaskSchedule.normalizeDay(input)).toBe(expected);
  });

  it.each([
    ['monday', 'Mon'],
    ['wednesday', 'Wed'],
    ['mon', 'Mon'],
    ['someday', 'someday'],
  ])('shortDay(%p) -> %p', (input, expected) => {
    expect(TaskSchedule.shortDay(input)).toBe(expected);
  });

  it.each([
    ['Europe/Berlin', '2026-09-24T09:30', '2026-09-24T09:30:00+02:00'],
    ['Europe/Berlin', '2026-01-15T09:30', '2026-01-15T09:30:00+01:00'],
    ['America/New_York', '2026-09-24T09:30', '2026-09-24T09:30:00-04:00'],
    ['Asia/Kolkata', '2026-09-24T09:30', '2026-09-24T09:30:00+05:30'],
    ['UTC', '2026-09-24T09:30', '2026-09-24T09:30:00+00:00'],
  ])('toRfc3339 in %s: %s -> %s', (tz, input, expected) => {
    expect(withTz(tz, () => TaskSchedule.toRfc3339(input))).toBe(expected);
  });

  it.each(['', 'not-a-date'])('toRfc3339(%p) -> empty string', (input) => {
    expect(TaskSchedule.toRfc3339(input)).toBe('');
  });

  it.each([
    [{ type: 'once', at: '2026-09-24T09:30:00+02:00' }, '2026-09-24T09:30'],
    [{ type: 'once', at: '2026-09-24T07:30:00Z' }, '2026-09-24T09:30'],
    [{ type: 'once', at: '2026-09-24T09:30:00+02:00', datetime: '2020-01-01T00:00' }, '2026-09-24T09:30'],
    [{ type: 'once', datetime: '2026-09-24T09:30' }, '2026-09-24T09:30'],
    [{ type: 'once' }, ''],
  ])('toLocalInput(%j) -> %p', (schedule, expected) => {
    expect(TaskSchedule.toLocalInput(schedule)).toBe(expected);
  });

  it('round-trips a local value through toRfc3339 and back', () => {
    const at = TaskSchedule.toRfc3339('2026-03-29T12:00');
    expect(TaskSchedule.toLocalInput({ type: 'once', at })).toBe('2026-03-29T12:00');
  });
});
