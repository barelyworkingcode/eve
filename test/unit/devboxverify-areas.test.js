const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const MAP_FILE = path.join(ROOT, 'docs/areas.jsonc');

describe('devboxverify/areas.js', () => {
  const {
    SMOKE, globToRegExp, parseMap, fixedTrigger, areasFor, unmapped, select,
  } = require('../../devboxverify/areas');

  describe('globToRegExp', () => {
    it.each([
      ['public/*.js', 'public/a.js', true],
      ['public/*.js', 'public/sub/a.js', false],
      ['public/?.js', 'public/a.js', true],
      ['public/?.js', 'public/ab.js', false],
      ['public/?.js', 'public/sub.js', false],
      ['a/**/b.js', 'a/b.js', true],
      ['a/**/b.js', 'a/x/b.js', true],
      ['a/**/b.js', 'a/x/y/b.js', true],
      ['a/**/b.js', 'x/a/b.js', false],
      ['viewers/**', 'viewers/a.js', true],
      ['viewers/**', 'viewers/x/y/a.js', true],
      ['viewers/**', 'other/a.js', false],
      ['server.js', 'server.js', true],
      ['server.js', 'lib/server.js', false],
      ['*.json', 'package.json', true],
      ['*.json', 'lib/package.json', false],
      ['**/*.md', 'README.md', true],
      ['**/*.md', 'docs/deep/note.md', true],
      ['**/*.md', 'docs/note.txt', false],
      ['*.js', '.eslintrc.js', true],
      ['.github/**', '.github/workflows/ci.yml', true],
      ['a.js', 'axjs', false],
      ['x+y(1).js', 'x+y(1).js', true],
      ['x+y(1).js', 'xxy(1).js', false],
    ])('%s against %s is %s', (glob, file, expected) => {
      expect(globToRegExp(glob).test(file)).toBe(expected);
    });
  });

  describe('parseMap', () => {
    it('parses comments, defaults full to false', () => {
      const map = parseMap(`// note\n{ "quiet": ["notes/**"], "areas": { "chat": { "code": ["a.js"] }, "core": { "full": true, "code": ["server.js"] } } }`);
      expect(map.quiet).toEqual(['notes/**']);
      expect(map.areas.chat).toEqual({ full: false, code: ['a.js'] });
      expect(map.areas.core.full).toBe(true);
    });

    it.each([
      ['an unknown top-level key', '{ "quiet": [], "areas": {}, "extra": 1 }'],
      ['an unknown area key', '{ "quiet": [], "areas": { "chat": { "code": ["a.js"], "extra": 1 } } }'],
      ['an empty code list', '{ "quiet": [], "areas": { "chat": { "code": [] } } }'],
      ['an invalid area name', '{ "quiet": [], "areas": { "Bad_Name": { "code": ["a.js"] } } }'],
    ])('rejects %s with the file name in the message', (_label, text) => {
      expect(() => parseMap(text)).toThrow(/^docs\/areas\.jsonc: /);
    });
  });

  describe('fixedTrigger', () => {
    it.each([
      ['devboxverify/x.js', 'harness'],
      ['devboxverify/README.md', null],
      ['scripts/browser-lock.js', 'harness'],
      ['docs/areas.jsonc', 'map'],
      ['server.js', null],
    ])('%s is %s', (file, expected) => {
      expect(fixedTrigger(file)).toBe(expected);
    });
  });

  // Synthetic map and journey table for areasFor, unmapped and select.
  const MAP = parseMap(JSON.stringify({
    quiet: ['notes/**', '*.md'],
    areas: {
      core: { full: true, code: ['server.js'] },
      chat: { code: ['chat/**', 'shared.js'] },
      files: { code: ['files/**', 'shared.js'] },
      git: { code: ['git.js'] },
      search: { code: ['search.js'] },
    },
  }));
  const J = (id, areas = [], extra = {}) => ({ id, areas, ...extra });
  const JOURNEYS = [
    J('owner-sign-in', [], { fixture: true }),
    J('landing-view'),
    J('chat-reply', ['chat']),
    J('open-existing-thread', ['chat']),
    J('terminal-on-request'),
    J('task-created-listed'),
    J('changes-diff', ['git']),
    J('file-edit-save', ['files']),
    J('files-extra', ['files']),
    J('git-extra', ['git']),
  ];
  const ALWAYS = ['owner-sign-in', ...SMOKE];

  describe('areasFor and unmapped', () => {
    it('areasFor returns the sorted union of matching areas', () => {
      expect(areasFor(MAP, 'shared.js')).toEqual(['chat', 'files']);
      expect(areasFor(MAP, 'notes/a.txt')).toEqual([]);
    });

    it('unmapped leaves out fixed, area and quiet paths', () => {
      expect(unmapped(MAP, [
        'devboxverify/x.js', 'docs/areas.jsonc', 'server.js', 'notes/a.txt', 'README.md', 'stray.txt', 'dir/stray.js',
      ])).toEqual(['stray.txt', 'dir/stray.js']);
    });
  });

  describe('select', () => {
    const pick = (files, journeys = JOURNEYS, map = MAP) => select({ map, journeys, changed: { files } });

    it('runs full when the diff failed', () => {
      expect(select({ map: MAP, journeys: JOURNEYS, changed: { error: 'bad ref' } }))
        .toMatchObject({ mode: 'full', why: 'no diff: bad ref', total: JOURNEYS.length });
    });

    it('runs full when the diff is empty', () => {
      expect(pick([])).toMatchObject({ mode: 'full', why: 'no diff: empty' });
    });

    it('runs full when a journey names an area missing from the map', () => {
      expect(pick(['git.js'], [...JOURNEYS, J('x', ['ghost'])]))
        .toMatchObject({ mode: 'full', why: 'area not in map: ghost' });
    });

    it.each([
      [['devboxverify/journeys.js'], 'harness: devboxverify/journeys.js'],
      [['docs/areas.jsonc'], 'map: docs/areas.jsonc'],
      [['server.js'], 'core: server.js'],
      [['stray.txt'], 'unmapped: stray.txt'],
    ])('runs full for %j with why %s', (files, why) => {
      expect(pick(files)).toMatchObject({ mode: 'full', why });
    });

    it('lets the first path in sorted order decide', () => {
      expect(pick(['server.js', 'a-stray.txt']).why).toBe('unmapped: a-stray.txt');
      expect(pick(['server.js', 'devboxverify/x.js']).why).toBe('harness: devboxverify/x.js');
      expect(pick(['stray.txt', 'server.js']).why).toBe('core: server.js');
    });

    it('selects smoke, fixtures and touched-area journeys in table order', () => {
      const sel = pick(['files/a.js', 'shared.js']);
      expect(sel.mode).toBe('partial');
      expect(sel.areas).toEqual(['chat', 'files']);
      expect(sel.ids).toEqual([...ALWAYS, 'files-extra']);
      expect(sel.total).toBe(JOURNEYS.length);
    });

    it('selects only smoke and fixtures for a quiet change', () => {
      expect(pick(['notes/a.txt'])).toMatchObject({ mode: 'partial', areas: [], ids: ALWAYS });
    });

    it('selects only smoke and fixtures for an area with no journey', () => {
      expect(pick(['search.js'])).toMatchObject({ mode: 'partial', areas: ['search'], ids: ALWAYS });
    });

    it('runs full when every journey is selected', () => {
      const sel = pick(['files/a.js', 'git.js']);
      expect(sel).toMatchObject({ mode: 'full', why: 'all selected', total: JOURNEYS.length });
      expect(sel.ids).toHaveLength(JOURNEYS.length);
    });

    it('runs full when the head map drops server.js from core', () => {
      const map = parseMap(fs.readFileSync(MAP_FILE, 'utf8'));
      expect(map.areas.core.code).toContain('server.js');
      map.areas.core.code = map.areas.core.code.filter(g => g !== 'server.js');
      expect(select({ map, journeys: [J('chat-reply', ['chat'])], changed: { files: ['server.js', 'docs/areas.jsonc'] } }))
        .toMatchObject({ mode: 'full', why: 'map: docs/areas.jsonc' });
    });
  });

  describe('the real map', () => {
    const map = () => parseMap(fs.readFileSync(MAP_FILE, 'utf8'));
    const { journeys } = require('../../devboxverify/journeys');

    it('covers every tracked file', () => {
      const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean).filter(f => !fixedTrigger(f));
      const missing = unmapped(map(), tracked);
      if (missing.length) throw new Error(`not in any area or quiet: ${missing.join(', ')}; add them to docs/areas.jsonc`);
    });

    it('has every journey area in the map', () => {
      const known = new Set(Object.keys(map().areas));
      const bad = journeys.flatMap(j => j.areas.filter(a => !known.has(a)).map(a => `${j.id}:${a}`));
      expect(bad).toEqual([]);
    });

    it('keeps SMOKE to plain journeys, chat-reply first', () => {
      const byId = new Map(journeys.map(j => [j.id, j]));
      for (const id of SMOKE) {
        expect(byId.has(id)).toBe(true);
        expect(byId.get(id).screen).toBeFalsy();
        expect(byId.get(id).fixture).toBeFalsy();
      }
      const order = journeys.map(j => j.id);
      expect(SMOKE).toContain('chat-reply');
      expect(order.indexOf('chat-reply')).toBeLessThan(order.indexOf('open-existing-thread'));
      expect(order.indexOf('chat-reply')).toBeLessThan(order.indexOf('listen'));
    });
  });
});
