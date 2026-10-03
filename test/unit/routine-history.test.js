const RoutineHistory = require('../../public/routine-history');

const flush = () => new Promise(r => setImmediate(r));
const make = (limit = 20) => {
  const load = jest.fn(async id => [{ id: `${id}-newest` }, { id: 'older' }]);
  const onChange = jest.fn();
  return { h: new RoutineHistory({ load, onChange, limit }), load, onChange };
};

describe('RoutineHistory', () => {
  test('newest returns the newest entry for any status once loaded, fetching once', async () => {
    const { h, load, onChange } = make();
    const t = { id: 'a', lastStatus: 'success', lastRun: '2026-10-01T07:00:00Z' };
    expect(h.newest(t)).toBeNull();
    await flush();
    expect(h.newest(t)).toEqual({ id: 'a-newest' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('lastExec ignores tasks that are not failed and fetches for failed ones', async () => {
    const { h, load } = make();
    expect(h.lastExec({ id: 'a', lastStatus: 'success', lastRun: 'x' })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    const t = { id: 'b', lastStatus: 'timeout', lastRun: 'x' };
    h.lastExec(t);
    await flush();
    expect(h.lastExec(t)).toEqual({ id: 'b-newest' });
  });

  test('the cap counts tasks and stops further fetches', async () => {
    const { h, load } = make(2);
    for (const id of ['a', 'b', 'c']) h.newest({ id, lastStatus: 'error', lastRun: '1' });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(h.newest({ id: 'c', lastStatus: 'error', lastRun: '1' })).toBeNull();
  });

  test('a newer run replaces the task\'s older entry', async () => {
    const { h, load } = make(3);
    h.newest({ id: 'a', lastStatus: 'error', lastRun: '1' });
    h.newest({ id: 'b', lastStatus: 'error', lastRun: '1' });
    await flush();
    h.newest({ id: 'a', lastStatus: 'error', lastRun: '2' });
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(h._cache.size).toBe(2);
  });

  test('a newer run of a cached task still fetches when the cache is full', async () => {
    const { h, load } = make(2);
    h.newest({ id: 'a', lastStatus: 'success', lastRun: '1' });
    h.newest({ id: 'b', lastStatus: 'success', lastRun: '1' });
    await flush();
    expect(h._cache.size).toBe(2);
    h.newest({ id: 'a', lastStatus: 'success', lastRun: '2' });
    expect(load).toHaveBeenCalledTimes(3);
    await flush();
    expect(h.newest({ id: 'a', lastStatus: 'success', lastRun: '2' })).toEqual({ id: 'a-newest' });
    expect(h._cache.size).toBe(2);
    expect(h.newest({ id: 'c', lastStatus: 'success', lastRun: '1' })).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
  });

  test('a custom pick reads the whole history, and its result is cached per (task, lastRun)', async () => {
    const entries = [{ status: 'error', error: 'output file not produced' }, { status: 'success', output: '{}' }];
    const load = jest.fn(async () => entries);
    const h = new RoutineHistory({ load, onChange: jest.fn(), limit: 5, pick: (list) => ({ newest: list[0], good: list[1] }) });
    const t = { id: 'a', lastStatus: 'error', lastRun: '1' };
    expect(h.newest(t)).toBeNull();
    await flush();
    expect(h.newest(t)).toEqual({ newest: entries[0], good: entries[1] });
    expect(load).toHaveBeenCalledTimes(1);
    h.newest({ ...t, lastRun: '2' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
