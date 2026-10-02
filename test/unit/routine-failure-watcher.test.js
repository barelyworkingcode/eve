const { EventEmitter } = require('events');
const { RoutineFailureWatcher, routineFailedNotification } = require('../../routine-failure-watcher');

const NOW = new Date('2026-10-02T07:00:03.120Z');
const failed = (extra = {}) => ({ type: 'task_error', taskId: 't_123', projectId: 'p_9', taskName: 'Morning brief', view: { runId: 'r0' }, ...extra });

describe('routineFailedNotification', () => {
  it('maps a failed run to the pinned wire shape', () => {
    expect(routineFailedNotification(failed({ error: 'process exited with code 3', status: 'error' }), NOW)).toEqual({
      v: 1, kind: 'routine_failed', at: '2026-10-02T07:00:03.120Z', title: 'Routine failed: Morning brief',
      message: 'process exited with code 3', url: '#routines', taskId: 't_123', projectId: 'p_9', status: 'error',
    });
  });

  it.each([
    ['a timeout', { status: 'timeout', error: 'killed after 600s' }, { status: 'timeout', title: 'Routine timed out: Morning brief', message: 'killed after 600s' }],
    ['no status (failRun)', { error: 'unknown template', exitCode: 1 }, { status: 'error', title: 'Routine failed: Morning brief', message: 'unknown template' }],
    ['an empty error', { status: 'error', error: '' }, { message: 'The run failed.' }],
    ['an empty timeout error', { status: 'timeout' }, { message: 'The run took too long.' }],
    ['a long name and a long, spaced error', { taskName: 'N'.repeat(100), error: `a \n\n\t b ${'x'.repeat(300)}` },
      { title: `Routine failed: ${'N'.repeat(80)}`, message: `a b ${'x'.repeat(196)}` }],
    ['no task name', { taskName: undefined, error: 'boom' }, { title: 'Routine failed: t_123' }],
  ])('%s', (_, extra, expected) => {
    expect(routineFailedNotification(failed(extra), NOW)).toMatchObject(expected);
  });

  it.each([
    ['task_started', { type: 'task_started', taskId: 't1' }],
    ['task_completed', { type: 'task_completed', taskId: 't1', status: 'success' }],
    ['task_status', { type: 'task_status', running: [] }],
    ['task_error without a taskId', { type: 'task_error', error: 'boom' }],
    ['task_error with a non-string taskId', { type: 'task_error', taskId: 7, error: 'boom' }],
  ])('returns null for %s', (_, frame) => {
    expect(routineFailedNotification(frame, NOW)).toBeNull();
  });
});

describe('RoutineFailureWatcher', () => {
  function setup() {
    const sockets = [];
    const relayTransport = {
      createWebSocket: jest.fn(() => {
        const ws = new EventEmitter();
        ws.send = jest.fn();
        ws.close = jest.fn(() => ws.emit('close'));
        sockets.push(ws);
        return ws;
      }),
    };
    const notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    const watcher = new RoutineFailureWatcher({ relayTransport, notifier });
    return { sockets, relayTransport, notifier, watcher };
  }
  const frame = (ws, f) => ws.emit('message', Buffer.from(typeof f === 'string' ? f : JSON.stringify(f)));

  it('opens its own /ws/tasks once, notifies once per task_error, ignores other frames and never sends', () => {
    const { sockets, relayTransport, notifier, watcher } = setup();
    watcher.start();
    watcher.start();
    expect(relayTransport.createWebSocket.mock.calls).toEqual([['/ws/tasks']]);
    const [ws] = sockets;
    ws.emit('open');
    frame(ws, { type: 'task_started', taskId: 't_123' });
    frame(ws, { type: 'task_completed', taskId: 't_123', status: 'success' });
    frame(ws, { type: 'task_status', running: [] });
    frame(ws, '{not json');
    frame(ws, failed({ error: 'boom', status: 'error' }));
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify.mock.calls[0][0]).toMatchObject({ kind: 'routine_failed', taskId: 't_123', title: 'Routine failed: Morning brief' });
    expect(ws.send).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('reconnects after a drop at 2 s doubling to a 30 s cap, back to 2 s after an open', () => {
    jest.useFakeTimers();
    const { sockets, watcher } = setup();
    watcher.start();
    const dropAndWait = (ms) => {
      const before = sockets.length;
      sockets.at(-1).emit('close');
      jest.advanceTimersByTime(ms - 1);
      expect(sockets).toHaveLength(before);
      jest.advanceTimersByTime(1);
      expect(sockets).toHaveLength(before + 1);
    };
    for (const ms of [2000, 4000, 8000, 16000, 30000, 30000]) dropAndWait(ms);
    sockets.at(-1).emit('open');
    dropAndWait(2000);
    watcher.stop();
  });

  it('stop() closes the socket and nothing reconnects, whether connected or waiting to reconnect', () => {
    jest.useFakeTimers();
    const connected = setup();
    connected.watcher.start();
    connected.sockets[0].emit('open');
    connected.watcher.stop();
    expect(connected.sockets[0].close).toHaveBeenCalled();

    const waiting = setup();
    waiting.watcher.start();
    waiting.sockets[0].emit('close');
    waiting.watcher.stop();

    jest.advanceTimersByTime(120000);
    expect(connected.sockets).toHaveLength(1);
    expect(waiting.sockets).toHaveLength(1);
  });
});
