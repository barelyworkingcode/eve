// Written from docs/design-routines.md (S5b-A1, A2 and the Interfaces block).
const { execFileSync } = require('child_process');
const path = require('path');

const RoutineSentence = require('../../public/core/routine-sentence');

const MODULE_PATH = path.join(__dirname, '../../public/core/routine-sentence.js');

// Deliberate: jest sandboxes process.env per test file, so assigning TZ here
// never reaches Date. Zone-dependent calls run in a child node with TZ set.
function inZone(tz, fn, ...args) {
  const script = `const RS = require(${JSON.stringify(MODULE_PATH)});
process.stdout.write(JSON.stringify((${fn.toString()})(RS, ...${JSON.stringify(args)})));`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz } });
  return JSON.parse(out.toString());
}

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0).toISOString();

describe('RoutineSentence.sentence', () => {
  it.each([
    [{ type: 'daily', time: '07:00' }, 'Every day at 07:00'],
    [{ type: 'weekly', day: 'monday', time: '08:00' }, 'Every Monday at 08:00'],
    [{ type: 'weekly', day: 'Mon', time: '08:00' }, 'Every Monday at 08:00'],
    [{ type: 'weekly', day: 'sun', time: '18:30' }, 'Every Sunday at 18:30'],
    [{ type: 'hourly', minute: 15 }, 'Every hour at :15'],
    [{ type: 'hourly', minute: 5 }, 'Every hour at :05'],
    [{ type: 'hourly', minute: 0 }, 'Every hour at :00'],
    [{ type: 'interval', minutes: 1 }, 'Every minute'],
    [{ type: 'interval', minutes: 30 }, 'Every 30 minutes'],
    [{ type: 'interval', minutes: 90 }, 'Every 90 minutes'],
    [{ type: 'interval', minutes: 60 }, 'Every hour'],
    [{ type: 'interval', minutes: 120 }, 'Every 2 hours'],
    [{ type: 'interval', minutes: 360 }, 'Every 6 hours'],
    [{ type: 'on_demand' }, 'When I ask'],
    [{ type: 'cron', expression: '0 7 * * *' }, 'Every day at 07:00'],
    [{ type: 'cron', expression: '30 18 * * *' }, 'Every day at 18:30'],
    [{ type: 'cron', expression: '15 * * * *' }, 'Every hour at :15'],
    [{ type: 'cron', expression: '*/5 * * * *' }, 'Custom schedule'],
    [{ type: 'cron', expression: '0 7 * * 1' }, 'Custom schedule'],
    [{ type: 'cron', expression: '0 7 1 * *' }, 'Custom schedule'],
    [{ type: 'cron' }, 'Custom schedule'],
    [null, 'No schedule'],
    [undefined, 'No schedule'],
    [{}, 'No schedule'],
    [{ type: 'bogus' }, 'No schedule'],
    [{ type: 'daily' }, 'No schedule'],
    [{ type: 'weekly', day: 'someday', time: '08:00' }, 'No schedule'],
    [{ type: 'interval', minutes: 'x' }, 'No schedule'],
    [{ type: 'once' }, 'No schedule'],
    [{ type: 'once', at: 'not a date' }, 'No schedule'],
  ])('%j reads %j', (schedule, expected) => {
    expect(RoutineSentence.sentence(schedule)).toBe(expected);
  });

  it('writes a once routine in local time, with no year this year', () => {
    const now = new Date(2026, 9, 1, 12, 0);
    const at = local(2026, 10, 2, 9, 0);
    expect(RoutineSentence.sentence({ type: 'once', at }, now)).toBe('Once, Fri 2 Oct at 09:00');
  });

  it('adds the year to a once routine when it is not this year', () => {
    const now = new Date(2026, 9, 1, 12, 0);
    const at = local(2027, 10, 2, 9, 0);
    expect(RoutineSentence.sentence({ type: 'once', at }, now)).toBe('Once, Sat 2 Oct 2027 at 09:00');
  });

  it('reads the same instant as local time in two zones', () => {
    const run = (RS) => RS.sentence({ type: 'once', at: '2026-10-02T07:00:00Z' }, new Date('2026-10-01T00:00:00Z'));
    expect(inZone('Europe/Berlin', run)).toBe('Once, Fri 2 Oct at 09:00');
    expect(inZone('America/Los_Angeles', run)).toBe('Once, Fri 2 Oct at 00:00');
  });
});

describe('RoutineSentence.when', () => {
  const now = new Date(2026, 9, 14, 12, 0); // Wed 14 Oct 2026, local

  it('shows only the time for today', () => {
    expect(RoutineSentence.when(local(2026, 10, 14, 7, 0), now)).toBe('07:00');
  });
  it('says yesterday', () => {
    expect(RoutineSentence.when(local(2026, 10, 13, 17, 30), now)).toBe('yesterday 17:30');
  });
  it('uses the weekday within six days', () => {
    expect(RoutineSentence.when(local(2026, 10, 12, 8, 0), now)).toBe('Mon 08:00');
    expect(RoutineSentence.when(local(2026, 10, 8, 8, 0), now)).toBe('Thu 08:00');
  });
  it('uses the date from seven days back', () => {
    expect(RoutineSentence.when(local(2026, 10, 7, 8, 0), now)).toBe('7 Oct 08:00');
    expect(RoutineSentence.when(local(2026, 10, 2, 8, 0), now)).toBe('2 Oct 08:00');
  });
  it('counts calendar days, not 24-hour spans', () => {
    const late = new Date(2026, 9, 14, 0, 30);
    expect(RoutineSentence.when(local(2026, 10, 13, 23, 50), late)).toBe('yesterday 23:50');
  });
  it('is empty for a missing or bad timestamp', () => {
    expect(RoutineSentence.when('', now)).toBe('');
    expect(RoutineSentence.when('nope', now)).toBe('');
    expect(RoutineSentence.when(undefined, now)).toBe('');
  });
});

describe('RoutineSentence.result', () => {
  const now = new Date(2026, 9, 14, 12, 0);
  const ranAt = local(2026, 10, 14, 7, 0);
  const task = (extra) => ({ enabled: true, schedule: { type: 'daily', time: '07:00' }, ...extra });

  it('is Paused when disabled', () => {
    expect(RoutineSentence.result(task({ enabled: false, lastStatus: 'success', lastRun: ranAt }), null, now))
      .toEqual({ kind: 'paused', text: 'Paused' });
  });
  it('checks Paused before running', () => {
    expect(RoutineSentence.result(task({ enabled: false, lastStatus: 'running' }), null, now).kind).toBe('paused');
  });
  it('does not call a once routine that has run Paused', () => {
    const t = task({ enabled: false, schedule: { type: 'once', at: ranAt }, lastStatus: 'success', lastRun: ranAt });
    expect(RoutineSentence.result(t, null, now)).toEqual({ kind: 'ok', text: 'ran 07:00 · ok' });
  });
  it('calls a once routine that has not run Paused', () => {
    const t = task({ enabled: false, schedule: { type: 'once', at: ranAt } });
    expect(RoutineSentence.result(t, null, now).kind).toBe('paused');
  });
  it('reports running now', () => {
    expect(RoutineSentence.result(task({ lastStatus: 'running' }), null, now))
      .toEqual({ kind: 'running', text: 'running now' });
  });
  it('reports ok with when', () => {
    expect(RoutineSentence.result(task({ lastStatus: 'success', lastRun: ranAt }), null, now))
      .toEqual({ kind: 'ok', text: 'ran 07:00 · ok' });
  });
  it('reports failed with when alone while no history is loaded', () => {
    expect(RoutineSentence.result(task({ lastStatus: 'error', lastRun: ranAt }), null, now))
      .toEqual({ kind: 'failed', text: 'failed 07:00' });
  });
  it('gives the first line of the error, at most 80 characters', () => {
    const t = task({ lastStatus: 'error', lastRun: ranAt });
    expect(RoutineSentence.result(t, { status: 'error', error: 'boom\nstack line' }, now).text).toBe('failed 07:00 · boom');
    const long = RoutineSentence.result(t, { status: 'error', error: 'x'.repeat(200) }, now).text;
    expect(long.slice('failed 07:00 · '.length).length).toBeLessThanOrEqual(80);
  });
  it('says took too long for a timeout', () => {
    const t = task({ lastStatus: 'timeout', lastRun: ranAt });
    expect(RoutineSentence.result(t, { status: 'timeout', error: 'deadline' }, now))
      .toEqual({ kind: 'failed', text: 'failed 07:00 · took too long' });
  });
  it('says exited <code> for a terminal run', () => {
    const t = task({ lastStatus: 'error', lastRun: ranAt, sessionType: 'pty' });
    expect(RoutineSentence.result(t, { status: 'error', exitCode: 2, terminalId: 'x' }, now).text)
      .toBe('failed 07:00 · exited 2');
  });
  it('says no reason given when the entry has none', () => {
    const t = task({ lastStatus: 'error', lastRun: ranAt });
    expect(RoutineSentence.result(t, { status: 'error' }, now).text).toBe('failed 07:00 · no reason given');
    expect(RoutineSentence.result(t, { status: 'error', error: '\n  \n' }, now).text).toBe('failed 07:00 · no reason given');
  });
  it('says never ran otherwise', () => {
    expect(RoutineSentence.result(task({}), null, now)).toEqual({ kind: 'never', text: 'never ran' });
    expect(RoutineSentence.result(task({ lastStatus: 'pending' }), null, now).kind).toBe('never');
  });
});

describe('RoutineSentence.firstLine', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(RoutineSentence.firstLine('\n  \n  Hello there  \nsecond')).toBe('Hello there');
  });
  it('caps at 120 characters by default and at max when given', () => {
    expect(RoutineSentence.firstLine('a'.repeat(300)).length).toBeLessThanOrEqual(120);
    expect(RoutineSentence.firstLine('a'.repeat(300), 10).length).toBeLessThanOrEqual(10);
    expect(RoutineSentence.firstLine('short', 10)).toBe('short');
  });
  it('is empty for nothing', () => {
    expect(RoutineSentence.firstLine('')).toBe('');
    expect(RoutineSentence.firstLine(null)).toBe('');
  });
});

describe('RoutineSentence.fromChoice', () => {
  it.each([
    [{ when: 'daily', time: '09:00' }, { type: 'daily', time: '09:00' }],
    [{ when: 'weekly', day: 'Monday', time: '08:00' }, { type: 'weekly', day: 'monday', time: '08:00' }],
    [{ when: 'weekly', day: 'tue', time: '08:00' }, { type: 'weekly', day: 'tuesday', time: '08:00' }],
    [{ when: 'hourly', minute: 15 }, { type: 'hourly', minute: 15 }],
    [{ when: 'on_demand' }, { type: 'on_demand' }],
  ])('%j gives %j', (choice, schedule) => {
    expect(RoutineSentence.fromChoice(choice)).toEqual(schedule);
  });
});

describe('RoutineSentence.toChoice', () => {
  it('returns null for interval, once, cron and unknown', () => {
    for (const s of [{ type: 'interval', minutes: 5 }, { type: 'once', at: '2026-10-02T07:00:00Z' },
      { type: 'cron', expression: '0 7 * * *' }, { type: 'x' }, null, undefined]) {
      expect(RoutineSentence.toChoice(s)).toBeNull();
    }
  });
});

describe('round trip', () => {
  const choices = [
    { when: 'daily', time: '09:00' },
    { when: 'weekly', day: 'monday', time: '08:00' },
    { when: 'weekly', day: 'sunday', time: '23:59' },
    { when: 'hourly', minute: 0 },
    { when: 'hourly', minute: 45 },
    { when: 'on_demand' },
  ];
  it.each(choices)('toChoice(fromChoice(%j)) equals the choice', (c) => {
    expect(RoutineSentence.toChoice(RoutineSentence.fromChoice(c))).toEqual(c);
  });

  const schedules = [
    [{ type: 'daily', time: '07:00' }, { type: 'daily', time: '07:00' }],
    [{ type: 'weekly', day: 'Mon', time: '08:00' }, { type: 'weekly', day: 'monday', time: '08:00' }],
    [{ type: 'weekly', day: 'friday', time: '17:00' }, { type: 'weekly', day: 'friday', time: '17:00' }],
    [{ type: 'hourly', minute: 15 }, { type: 'hourly', minute: 15 }],
    [{ type: 'on_demand' }, { type: 'on_demand' }],
  ];
  it.each(schedules)('fromChoice(toChoice(%j)) equals the schedule with the day normalized', (s, expected) => {
    expect(RoutineSentence.fromChoice(RoutineSentence.toChoice(s))).toEqual(expected);
  });

  it('reads back the same sentence the panel promised', () => {
    for (const c of choices) {
      const s = RoutineSentence.fromChoice(c);
      expect(RoutineSentence.sentence(RoutineSentence.fromChoice(RoutineSentence.toChoice(s)))).toBe(RoutineSentence.sentence(s));
    }
  });
});
