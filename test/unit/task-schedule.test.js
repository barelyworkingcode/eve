// relayScheduler accepts full lowercase day names and RFC 3339 `at`; the
// dialog's own inputs are short day names and zone-less datetime-local
// values.
const { execFileSync } = require('child_process');
const path = require('path');

const TaskSchedule = require('../../public/core/task-schedule');

const MODULE_PATH = path.join(__dirname, '../../public/core/task-schedule.js');

// Deliberate: jest sandboxes process.env per test file, so assigning TZ here
// never reaches Date. Zone-dependent calls run in a child node with TZ set.
function inZone(tz, fn, ...args) {
  const script = `const TS = require(${JSON.stringify(MODULE_PATH)});
process.stdout.write(JSON.stringify((${fn.toString()})(TS, ...${JSON.stringify(args)})));`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz } });
  return JSON.parse(out.toString());
}

const BERLIN = 'Europe/Berlin';

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
    expect(inZone(tz, (TS, v) => TS.toRfc3339(v), input)).toBe(expected);
  });

  it.each(['', 'not-a-date'])('toRfc3339(%p) -> empty string', (input) => {
    expect(inZone(BERLIN, (TS, v) => TS.toRfc3339(v), input)).toBe('');
  });

  it.each([
    [{ type: 'once', at: '2026-09-24T09:30:00+02:00' }, '2026-09-24T09:30'],
    [{ type: 'once', at: '2026-09-24T07:30:00Z' }, '2026-09-24T09:30'],
    [{ type: 'once', at: '2026-09-24T09:30:00+02:00', datetime: '2020-01-01T00:00' }, '2026-09-24T09:30'],
    [{ type: 'once', datetime: '2026-09-24T09:30' }, '2026-09-24T09:30'],
    [{ type: 'once' }, ''],
  ])('toLocalInput(%j) -> %p', (schedule, expected) => {
    expect(inZone(BERLIN, (TS, s) => TS.toLocalInput(s), schedule)).toBe(expected);
  });

  it('round-trips a local value through toRfc3339 and back', () => {
    const roundTrip = (TS, v) => TS.toLocalInput({ type: 'once', at: TS.toRfc3339(v) });
    expect(inZone(BERLIN, roundTrip, '2026-03-29T12:00')).toBe('2026-03-29T12:00');
  });
});
