// S1-A3: running / waiting / failed per thread, derived from inbound frames only.
// docs/design-today-s1.md
const SessionActivity = require('../../public/core/session-activity');

beforeAll(() => { global.EVT = { SESSION_ACTIVITY: 'session:activity' }; });
afterAll(() => { delete global.EVT; });

const make = () => {
  const emitted = [];
  const a = new SessionActivity({ emit: (evt, data) => emitted.push([evt, data]) });
  return { a, emitted };
};
const llm = (sessionId) => ({ type: 'llm_event', sessionId, event: {} });

describe('SessionActivity', () => {
  it('an unseen thread is idle', () => {
    expect(make().a.statusOf('nobody')).toBe('idle');
  });

  it.each([
    ['user_message', { type: 'user_message', sessionId: 's', text: 'hi' }],
    ['llm_event', llm('s')],
  ])('%s starts a turn', (_n, frame) => {
    const { a } = make();
    a.observe(frame);
    expect(a.statusOf('s')).toBe('running');
  });

  it('message_complete ends the turn', () => {
    const { a } = make();
    a.observe(llm('s'));
    a.observe({ type: 'message_complete', sessionId: 's' });
    expect(a.statusOf('s')).toBe('idle');
  });

  it('an error naming a session fails it, with the reason; the next turn clears it', () => {
    const { a } = make();
    a.observe({ type: 'error', sessionId: 's', message: 'model unavailable' });
    expect(a.statusOf('s')).toBe('failed');
    expect(a.reasonOf('s')).toBe('model unavailable');
    a.observe(llm('s'));
    expect(a.statusOf('s')).toBe('running');
    expect(a.reasonOf('s')).toBeFalsy();
  });

  it('an error with no session, and resume_required, fail nothing', () => {
    const { a } = make();
    a.observe(llm('s'));
    a.observe({ type: 'error', message: 'unrelated' });
    a.observe({ type: 'error', code: 'resume_required', sessionId: 's' });
    expect(a.statusOf('s')).toBe('running');
  });

  it('process_exited fails a thread mid-turn and leaves an idle one idle', () => {
    const { a } = make();
    a.observe(llm('busy'));
    a.observe({ type: 'process_exited', sessionId: 'busy' });
    a.observe({ type: 'process_exited', sessionId: 'quiet' });
    expect(a.statusOf('busy')).toBe('failed');
    expect(a.statusOf('quiet')).toBe('idle');
  });

  it('a permission request is waiting until it is answered, then the turn resumes as running', () => {
    const { a } = make();
    a.observe(llm('s'));
    a.observe({ type: 'permission_request', sessionId: 's', permissionId: 'p1' });
    expect(a.statusOf('s')).toBe('waiting');
    a.permissionAnswered('p1');
    expect(a.statusOf('s')).toBe('running');
  });

  it('waits on every open request, not just the first', () => {
    const { a } = make();
    a.observe({ type: 'permission_request', sessionId: 's', permissionId: 'p1' });
    a.observe({ type: 'permission_request', sessionId: 's', permissionId: 'p2' });
    a.permissionAnswered('p1');
    expect(a.statusOf('s')).toBe('waiting');
    a.permissionAnswered('p2');
    expect(a.statusOf('s')).toBe('idle');
  });

  it('session_joined and session_ended clear it; reset clears everything', () => {
    const { a } = make();
    a.observe(llm('a'));
    a.observe(llm('b'));
    a.observe(llm('c'));
    a.observe({ type: 'session_joined', sessionId: 'a' });
    a.observe({ type: 'session_ended', sessionId: 'b' });
    expect(a.statusOf('a')).toBe('idle');
    expect(a.statusOf('b')).toBe('idle');
    expect(a.statusOf('c')).toBe('running');
    a.reset();
    expect(a.statusOf('c')).toBe('idle');
  });

  it('emits SESSION_ACTIVITY only when a thread\'s status changes', () => {
    const { a, emitted } = make();
    a.observe(llm('s'));
    a.observe(llm('s'));
    a.observe({ type: 'message_complete', sessionId: 's' });
    expect(emitted).toEqual([
      ['session:activity', { sessionId: 's' }],
      ['session:activity', { sessionId: 's' }],
    ]);
  });
});
