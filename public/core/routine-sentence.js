/**
 * RoutineSentence — plain-English reading of a stored schedule and of a
 * routine's last result. Pure: no DOM, no state. The routines page, the
 * project page, the sheet and the make-routine panel all read through it so a
 * sentence the panel promises is the sentence the list shows.
 */
const RoutineSentence = (() => {
  const TS = typeof TaskSchedule !== 'undefined' ? TaskSchedule : require('./task-schedule');
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const NO_SCHEDULE = 'No schedule';

  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const parse = (iso) => {
    const d = new Date(iso);
    return iso && !Number.isNaN(d.getTime()) ? d : null;
  };
  const validMinute = (m) => Number.isInteger(Number(m)) && m !== '' && m !== null && Number(m) >= 0 && Number(m) <= 59;
  const minuteText = (m) => `:${pad(Number(m))}`;

  function cronSentence(expression) {
    const parts = typeof expression === 'string' ? expression.trim().split(/\s+/) : [];
    const [m, h, ...rest] = parts;
    if (parts.length !== 5 || !/^\d+$/.test(m) || Number(m) > 59 || !rest.every(f => f === '*')) return 'Custom schedule';
    if (h === '*') return `Every hour at ${minuteText(m)}`;
    if (/^\d+$/.test(h) && Number(h) <= 23) return `Every day at ${pad(Number(h))}:${pad(Number(m))}`;
    return 'Custom schedule';
  }

  function intervalSentence(minutes) {
    const n = Number(minutes);
    if (!Number.isInteger(n) || n < 1) return NO_SCHEDULE;
    if (n === 1) return 'Every minute';
    if (n === 60) return 'Every hour';
    if (n % 60 === 0) return `Every ${n / 60} hours`;
    return `Every ${n} minutes`;
  }

  function onceSentence(at, now) {
    const d = parse(at);
    if (!d) return NO_SCHEDULE;
    const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
    return `Once, ${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year} at ${hhmm(d)}`;
  }

  function sentence(schedule, now = new Date()) {
    if (!schedule || typeof schedule !== 'object') return NO_SCHEDULE;
    switch (schedule.type) {
      case 'daily': return TIME.test(schedule.time || '') ? `Every day at ${schedule.time}` : NO_SCHEDULE;
      case 'weekly': {
        const day = TS.normalizeDay(schedule.day);
        return day && TIME.test(schedule.time || '') ? `Every ${cap(day)} at ${schedule.time}` : NO_SCHEDULE;
      }
      case 'hourly': return validMinute(schedule.minute ?? 0) ? `Every hour at ${minuteText(schedule.minute ?? 0)}` : NO_SCHEDULE;
      case 'interval': return intervalSentence(schedule.minutes);
      case 'once': return onceSentence(schedule.at, now);
      case 'on_demand': return 'When I ask';
      case 'cron': return cronSentence(schedule.expression);
      default: return NO_SCHEDULE;
    }
  }

  function fromChoice(choice) {
    switch (choice.when) {
      case 'daily': return { type: 'daily', time: choice.time };
      case 'weekly': return { type: 'weekly', day: TS.normalizeDay(choice.day), time: choice.time };
      case 'hourly': return { type: 'hourly', minute: choice.minute };
      default: return { type: 'on_demand' };
    }
  }

  function toChoice(schedule) {
    if (!schedule) return null;
    switch (schedule.type) {
      case 'daily': return { when: 'daily', time: schedule.time };
      case 'weekly': return { when: 'weekly', day: TS.normalizeDay(schedule.day), time: schedule.time };
      case 'hourly': return { when: 'hourly', minute: schedule.minute };
      case 'on_demand': return { when: 'on_demand' };
      default: return null;
    }
  }

  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  function when(iso, now = new Date()) {
    const d = parse(iso);
    if (!d) return '';
    // Calendar days in local time, rounded so a DST day isn't 23 or 25 hours.
    const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
    if (days === 0) return hhmm(d);
    if (days === 1) return `yesterday ${hhmm(d)}`;
    if (days > 1 && days <= 6) return `${DAY_NAMES[d.getDay()]} ${hhmm(d)}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hhmm(d)}`;
  }

  function firstLine(text, max = 120) {
    if (typeof text !== 'string') return '';
    const line = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  function reason(task, exec) {
    if (task.lastStatus === 'timeout' || exec.status === 'timeout') return 'took too long';
    if (exec.exitCode !== undefined && exec.exitCode !== null) return `exited ${exec.exitCode}`;
    return firstLine(exec.error, 80) || 'no reason given';
  }

  function result(task, lastExec = null, now = new Date()) {
    const status = task.lastStatus;
    const hasRun = status === 'success' || status === 'error' || status === 'timeout';
    const onceDone = task.schedule?.type === 'once' && hasRun;
    if (!task.enabled && !onceDone) return { kind: 'paused', text: 'Paused' };
    if (status === 'running') return { kind: 'running', text: 'running now' };
    const at = when(task.lastRun, now);
    if (status === 'success') return { kind: 'ok', text: `ran${at ? ` ${at}` : ''} · ok` };
    if (status === 'error' || status === 'timeout') {
      const head = at ? `failed ${at}` : 'failed';
      return { kind: 'failed', text: lastExec ? `${head} · ${reason(task, lastExec)}` : head };
    }
    return { kind: 'never', text: 'never ran' };
  }

  return { sentence, fromChoice, toChoice, when, result, firstLine };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RoutineSentence;
}
