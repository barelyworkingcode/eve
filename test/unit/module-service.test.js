/**
 * ModuleService — module discovery, manifest validation, and the load-bearing
 * path defenses (name allow-list, traversal block, symlink-escape block) that
 * route handlers trust when serving module files. Driven against a real temp
 * project tree so the realpath/symlink checks exercise the actual filesystem.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const ModuleService = require('../../module-service');

let tmp, projectPath, outsideSecret;
const svc = new ModuleService();

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-module-svc-'));
  projectPath = path.join(tmp, 'project');
  const modules = path.join(projectPath, 'modules');
  fs.mkdirSync(modules, { recursive: true });

  // A valid module.
  const good = path.join(modules, 'good');
  fs.mkdirSync(path.join(good, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(good, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(good, 'sub', 'page.html'), '<p>p</p>');
  fs.writeFileSync(path.join(good, 'module.json'), JSON.stringify({
    displayName: 'Good Module',
    entry: 'index.html',
    permissions: { files: ['data/notes.txt'], tools: ['Read'] },
  }));

  // A broken module (manifest missing required displayName).
  const broken = path.join(modules, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'module.json'), JSON.stringify({ entry: 'index.html' }));

  // Ignored: dot-dir and an invalid (uppercase) module name.
  fs.mkdirSync(path.join(modules, '.hidden'));
  fs.mkdirSync(path.join(modules, 'NotAllowed'));

  // A file outside the project, used as a traversal / symlink-escape target.
  outsideSecret = path.join(tmp, 'secret.txt');
  fs.writeFileSync(outsideSecret, 'TOP SECRET');
  // Symlink inside the good module pointing outside it.
  try {
    fs.symlinkSync(outsideSecret, path.join(good, 'escape.txt'));
  } catch (_) { /* symlink unsupported — the escape test self-skips below */ }
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('listModules', () => {
  it('returns [] when the project has no modules dir', async () => {
    expect(await svc.listModules(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('lists valid modules and surfaces broken ones, skipping dot/invalid names', async () => {
    const list = await svc.listModules(projectPath);
    const byName = Object.fromEntries(list.map(m => [m.name, m]));

    expect(Object.keys(byName).sort()).toEqual(['broken', 'good']); // .hidden + NotAllowed excluded
    expect(byName.good).toMatchObject({
      name: 'good',
      displayName: 'Good Module',
      entry: 'index.html',
      permissions: { files: ['data/notes.txt'], tools: ['Read'] },
    });
    expect(byName.broken).toMatchObject({ broken: true });
    expect(byName.broken.error).toMatch(/displayName/);
  });
});

describe('getModule', () => {
  it('loads and canonicalizes the name from the directory', async () => {
    const m = await svc.getModule(projectPath, 'good');
    expect(m.name).toBe('good');
    expect(m.displayName).toBe('Good Module');
  });

  it('rejects an invalid module name', async () => {
    await expect(svc.getModule(projectPath, '../evil')).rejects.toThrow(/Invalid module name/);
  });

  it('throws MISSING_MANIFEST for an absent module', async () => {
    await expect(svc.getModule(projectPath, 'ghost')).rejects.toMatchObject({ code: 'MISSING_MANIFEST' });
  });
});

describe('resolveModuleFile path defenses', () => {
  it('resolves an in-module file to its realpath', async () => {
    const real = await svc.resolveModuleFile(projectPath, 'good', '/sub/page.html');
    expect(real).toBe(fs.realpathSync(path.join(projectPath, 'modules', 'good', 'sub', 'page.html')));
  });

  it('defaults to index.html when no path is given', async () => {
    const real = await svc.resolveModuleFile(projectPath, 'good', '');
    expect(path.basename(real)).toBe('index.html');
  });

  it('blocks ../ traversal out of the module', async () => {
    await expect(svc.resolveModuleFile(projectPath, 'good', '../../secret.txt'))
      .rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
  });

  it('returns ENOENT for a missing in-module file', async () => {
    await expect(svc.resolveModuleFile(projectPath, 'good', 'does-not-exist.html'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks a symlink escaping the module folder', async () => {
    const linkExists = fs.existsSync(path.join(projectPath, 'modules', 'good', 'escape.txt'));
    if (!linkExists) return; // symlink couldn't be created in this env
    await expect(svc.resolveModuleFile(projectPath, 'good', 'escape.txt'))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });
});

describe('isFilePermitted', () => {
  const manifest = { permissions: { files: ['data/notes.txt', './a/b.txt'] } };

  it('permits a declared file (normalized)', () => {
    expect(svc.isFilePermitted(manifest, 'data/notes.txt')).toBe(true);
    expect(svc.isFilePermitted(manifest, '/a/b.txt')).toBe(true); // normalization strips leading ./ and /
  });

  it('denies an undeclared file and when there is no files list', () => {
    expect(svc.isFilePermitted(manifest, 'data/other.txt')).toBe(false);
    expect(svc.isFilePermitted({ permissions: {} }, 'data/notes.txt')).toBe(false);
    expect(svc.isFilePermitted(null, 'x')).toBe(false);
  });
});

describe('manifest validation', () => {
  async function loadWith(manifest) {
    const dir = path.join(projectPath, 'modules', 'valcheck');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
    try {
      return await svc.getModule(projectPath, 'valcheck');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('rejects a manifest whose name disagrees with the directory', async () => {
    await expect(loadWith({ name: 'other', displayName: 'X' })).rejects.toThrow(/does not match directory/);
  });

  it('rejects a non-.html or non-relative entry', async () => {
    await expect(loadWith({ displayName: 'X', entry: 'main.js' })).rejects.toThrow(/end in .html|\.html/);
    await expect(loadWith({ displayName: 'X', entry: '/abs/index.html' })).rejects.toThrow(/module-relative/);
    await expect(loadWith({ displayName: 'X', entry: '../up/index.html' })).rejects.toThrow(/module-relative/);
  });

  it('rejects permissions.files entries that escape the project', async () => {
    await expect(loadWith({ displayName: 'X', permissions: { files: ['../etc/passwd'] } }))
      .rejects.toThrow(/project-relative/);
    await expect(loadWith({ displayName: 'X', permissions: { files: ['/abs'] } }))
      .rejects.toThrow(/project-relative/);
  });

  it('accepts a minimal valid manifest', async () => {
    const m = await loadWith({ displayName: 'Just Fine' });
    expect(m.displayName).toBe('Just Fine');
  });
});
