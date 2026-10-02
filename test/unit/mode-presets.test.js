// S3b-1: a mode's project and presets, the editor's one-per-kind rule, the
// Ask frame and the Action Button's 30-minute resume rule. docs/design-mode-presets.md
const ModePresets = require('../../public/core/mode-presets');

const MIN = 60 * 1000;

describe('ModePresets.projectFor', () => {
  const local = (id, extra = {}) => ({ id, name: id, mode: 'both', defaultFor: [], ...extra });

  it.each([
    ['the default wins over the others', [local('a'), local('b', { defaultFor: ['work'] })], 'b'],
    ['the only local project in the mode', [local('a', { mode: 'home' }), local('b', { mode: 'work' })], 'b'],
    ['a host project is not a candidate', [local('h', { hostId: 'h1' }), local('b')], 'b'],
    ['a host project is never the default', [local('h', { hostId: 'h1', defaultFor: ['work'] }), local('a'), local('b')], null],
    ['two in the mode, no default for it', [local('a', { defaultFor: ['home'] }), local('b')], null],
    ['nothing in the mode', [local('a', { mode: 'home' })], null],
    ['no projects', [], null],
  ])('%s', (_what, projects, expected) => {
    const found = ModePresets.projectFor(projects, 'work');
    expect(found ? found.id : null).toBe(expected);
  });
});

describe('ModePresets.presetsOf and forMode', () => {
  const T = (id, mode, presetFor) => ({ id, name: id, model: 'm', mode, voice: '', systemPrompt: '', presetFor });
  const project = {
    id: 'p1', name: 'Acme', mode: 'both', defaultFor: ['work'],
    chatTemplates: [T('plain', 'text', []), T('ask1', 'text', ['work']), T('v1', 'voice', ['work', 'home']), T('ask2', 'text', ['work', 'home'])],
  };

  it('splits by kind: a voice template is the voice preset, any other the Ask preset; the first of a kind wins', () => {
    const work = ModePresets.presetsOf(project, 'work');
    expect([work.ask.id, work.voice.id]).toEqual(['ask1', 'v1']);
    const home = ModePresets.presetsOf(project, 'home');
    expect([home.ask.id, home.voice.id]).toEqual(['ask2', 'v1']);
  });

  it('a mode no template lists has neither preset', () => {
    const bare = { ...project, chatTemplates: [T('plain', 'text', []), T('v', 'voice', undefined)] };
    expect(ModePresets.presetsOf(bare, 'work')).toEqual({ ask: null, voice: null });
  });

  it('reads presets from the mode\'s project only; a preset elsewhere is inert', () => {
    const other = { id: 'p2', name: 'Other', mode: 'both', defaultFor: [], chatTemplates: [T('elsewhere', 'voice', ['work'])] };
    const bare = { ...project, chatTemplates: [] };
    expect(ModePresets.forMode([other, bare], 'work')).toEqual({ project: bare, ask: null, voice: null });
    expect(ModePresets.forMode([other], 'work')).toMatchObject({ project: other, ask: null, voice: { id: 'elsewhere' } });
    expect(ModePresets.forMode([], 'work')).toEqual({ project: null, ask: null, voice: null });
  });
});

describe('ModePresets.normalize', () => {
  it.each([
    [['work', 'both', 'home', 'work', 'x'], ['home', 'work']],
    [['work'], ['work']],
    [[], []],
    ['work', []],
    [null, []],
    [undefined, []],
    [{ 0: 'work' }, []],
  ])('%j reads %j', (input, expected) => {
    expect(ModePresets.normalize(input)).toEqual(expected);
  });
});

describe('ModePresets.withPreset', () => {
  const templates = () => [
    { id: 'a', name: 'A', mode: 'text', presetFor: ['work'] },
    { id: 'b', name: 'B', mode: 'text', presetFor: [] },
    { id: 'c', name: 'C', mode: 'voice', presetFor: ['work'] },
    { id: 'd', name: 'D', mode: 'text', presetFor: ['home'] },
  ];

  it.each([
    ['on for work clears work from the other Ask template, not from the voice one', 1, 'work', true, [[], ['work'], ['work'], ['home']]],
    ['on for home clears home from the other Ask template only', 1, 'home', true, [['work'], ['home'], ['work'], []]],
    ['on for work on a voice template leaves the Ask templates alone', 2, 'work', true, [['work'], [], ['work'], ['home']]],
    ['off removes the mode from that template only', 0, 'work', false, [[], [], ['work'], ['home']]],
  ])('%s', (_what, index, mode, on, expected) => {
    const input = templates();
    const before = JSON.stringify(input);
    const out = ModePresets.withPreset(input, index, mode, on);
    expect(out.map((t) => t.presetFor)).toEqual(expected);
    expect(out.map((t) => t.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(out).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('ModePresets.askFrame', () => {
  const project = { id: 'p1', name: 'Acme' };

  it('uses the preset\'s model and system prompt over the Ask model', () => {
    const frame = ModePresets.askFrame({ project, template: { model: 'preset-model', systemPrompt: 'Be brief.' }, model: 'ask-model', text: 'hello' });
    expect(frame).toMatchObject({ type: 'create_session', projectId: 'p1', model: 'preset-model', systemPrompt: 'Be brief.', name: 'Acme - hello' });
    expect(frame).not.toHaveProperty('appendClaudeMd');
  });

  it.each([
    ['no preset', null],
    ['a preset with an empty prompt', { model: 'ask-model', systemPrompt: '' }],
  ])('%s: no systemPrompt key', (_what, template) => {
    const frame = ModePresets.askFrame({ project, template, model: 'ask-model', text: 'hello' });
    expect(frame).toMatchObject({ type: 'create_session', projectId: 'p1', model: 'ask-model' });
    expect(frame).not.toHaveProperty('systemPrompt');
  });

  it('names the thread after the first line, cut to 48 characters', () => {
    const first = 'x'.repeat(60);
    expect(ModePresets.askFrame({ project, template: null, model: 'm', text: `${first}\nsecond line` }).name).toBe(`Acme - ${'x'.repeat(48)}`);
  });
});

describe('ModePresets.lastActive and resumable (the 30-minute rule)', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();

  it.each([
    ['createdAt only', { createdAt: iso(now - 10 * MIN) }, undefined, now - 10 * MIN],
    ['lastMessageAt is later', { createdAt: iso(now - 50 * MIN), lastMessageAt: iso(now - 5 * MIN) }, undefined, now - 5 * MIN],
    ['this device opened it later', { createdAt: iso(now - 50 * MIN) }, now - 2 * MIN, now - 2 * MIN],
    ['nothing known', {}, undefined, 0],
  ])('lastActive: %s', (_what, session, lastOpenedAt, expected) => {
    expect(ModePresets.lastActive(session, lastOpenedAt)).toBe(expected);
  });

  const voice = (agoMs) => ({ createdAt: iso(now - agoMs) });
  it.each([
    ['29:59 ago', voice(30 * MIN - 1000), {}, true],
    ['30:00 ago', voice(30 * MIN), {}, false],
    ['created long ago, opened 29:59 ago', voice(3 * 60 * MIN), { lastOpenedAt: now - (30 * MIN - 1000) }, true],
    ['in the other mode', voice(MIN), { inMode: false }, false],
    ['not a voice thread', voice(MIN), { isVoice: false }, false],
    ['no activity known', {}, {}, false],
  ])('resumable: %s', (_what, session, over, expected) => {
    expect(ModePresets.resumable(session, { now, inMode: true, isVoice: true, ...over })).toBe(expected);
  });
});
