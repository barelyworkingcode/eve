// languageForPath (issue #17): maps a project-relative path to a Monaco
// language id. Built from the acceptance criteria and the contract, against a
// fixture shaped like monaco.languages.getLanguages() in Monaco 0.45.
const { languageForPath, LANGUAGE_OVERRIDES } = require('../../public/core/language-detect.js');

// Real Monaco 0.45 registrations, in registration order.
const MONACO_LANGUAGES = [
  { id: 'plaintext', extensions: ['.txt'] },
  { id: 'c', extensions: ['.c', '.h'] },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'] },
  { id: 'csharp', extensions: ['.cs', '.csx', '.cake'] },
  { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
  {
    id: 'ini',
    extensions: ['.ini', '.properties', '.gitconfig'],
    filenames: ['config', '.gitattributes', '.gitconfig', '.editorconfig'],
  },
  { id: 'javascript', extensions: ['.js', '.es6', '.jsx', '.mjs', '.cjs'], filenames: ['jakefile'] },
  { id: 'typescript', extensions: ['.ts', '.tsx', '.cts', '.mts'] },
  { id: 'powershell', extensions: ['.ps1', '.psm1', '.psd1'] },
  { id: 'razor', extensions: ['.cshtml', '.razor'] },
  {
    id: 'xml',
    extensions: [
      '.xml', '.xsd', '.dtd', '.ascx', '.csproj', '.config', '.props', '.targets', '.wxi', '.wxl',
      '.wxs', '.xaml', '.svg', '.svgz', '.opf', '.xslt', '.xsl',
    ],
  },
  { id: 'html', extensions: ['.html', '.htm'] },
  { id: 'json', extensions: ['.json', '.bowerrc', '.jshintrc', '.jscsrc', '.eslintrc', '.babelrc', '.har'] },
];

const detect = (p, langs = MONACO_LANGUAGES) => languageForPath(p, langs);

describe('module shape', () => {
  test('exports languageForPath as a function', () => {
    expect(typeof languageForPath).toBe('function');
  });

  test('LANGUAGE_OVERRIDES is an object with lower-case keys', () => {
    expect(LANGUAGE_OVERRIDES).toEqual(expect.any(Object));
    for (const key of Object.keys(LANGUAGE_OVERRIDES)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  test('LANGUAGE_OVERRIDES maps the contract examples', () => {
    expect(LANGUAGE_OVERRIDES['.csproj']).toBe('xml');
    expect(LANGUAGE_OVERRIDES['.toml']).toBe('ini');
    expect(LANGUAGE_OVERRIDES['.env']).toBe('ini');
    expect(LANGUAGE_OVERRIDES['.svg']).toBe('xml');
  });
});

describe('known extensions open in the Monaco language', () => {
  test.each([
    ['Program.cs', 'csharp'],
    ['build.cake', 'csharp'],
    ['deploy.ps1', 'powershell'],
    ['Tools.psm1', 'powershell'],
    ['Index.razor', 'razor'],
    ['Views/Home/Index.cshtml', 'razor'],
    ['server.mjs', 'javascript'],
    ['loader.cjs', 'javascript'],
    ['app.js', 'javascript'],
    ['main.ts', 'typescript'],
    ['main.c', 'c'],
    ['widget.hpp', 'cpp'],
    ['index.html', 'html'],
    ['package.json', 'json'],
    ['notes.txt', 'plaintext'],
    ['schema.xsd', 'xml'],
  ])('%s -> %s', (p, id) => {
    expect(detect(p)).toBe(id);
  });

  test('Dockerfile -> dockerfile (filename registration)', () => {
    expect(detect('Dockerfile')).toBe('dockerfile');
  });

  test('jakefile -> javascript (filename registration)', () => {
    expect(detect('jakefile')).toBe('javascript');
  });
});

describe('case-insensitive matching', () => {
  test.each([
    ['Program.CS', 'csharp'],
    ['DEPLOY.PS1', 'powershell'],
    ['Page.Razor', 'razor'],
    ['dockerfile', 'dockerfile'],
    ['DOCKERFILE', 'dockerfile'],
    ['Acme.CsProj', 'xml'],
    ['Settings.TOML', 'ini'],
  ])('%s -> %s', (p, id) => {
    expect(detect(p)).toBe(id);
  });
});

describe('filename beats extension', () => {
  test('a filename registration wins over an extension match on the same basename', () => {
    const langs = [
      { id: 'byext', extensions: ['.lock'] },
      { id: 'byname', filenames: ['acme.lock'] },
    ];
    expect(detect('acme.lock', langs)).toBe('byname');
    expect(detect('other.lock', langs)).toBe('byext');
  });

  test('Dockerfile and dockerfile both resolve by filename', () => {
    expect(detect('Dockerfile')).toBe('dockerfile');
    expect(detect('dockerfile')).toBe('dockerfile');
  });

  test('.gitconfig resolves to ini', () => {
    expect(detect('.gitconfig')).toBe('ini');
  });

  test('.editorconfig resolves to ini by filename', () => {
    expect(detect('.editorconfig')).toBe('ini');
  });
});

describe('longest suffix wins', () => {
  const withDts = [...MONACO_LANGUAGES, { id: 'dts', extensions: ['.d.ts'] }];

  test('.d.ts beats .ts', () => {
    expect(detect('types/index.d.ts', withDts)).toBe('dts');
  });

  test('plain .ts still resolves to typescript', () => {
    expect(detect('src/index.ts', withDts)).toBe('typescript');
  });

  test('longest suffix wins regardless of registration order', () => {
    const dtsFirst = [{ id: 'dts', extensions: ['.d.ts'] }, ...MONACO_LANGUAGES];
    expect(detect('index.d.ts', dtsFirst)).toBe('dts');
    expect(detect('index.ts', dtsFirst)).toBe('typescript');
  });

  test('.cshtml is not mistaken for .html', () => {
    expect(detect('Pages/Index.cshtml')).toBe('razor');
  });

  test('only the basename is matched, not a directory name', () => {
    expect(detect('src.cs/readme')).toBe('plaintext');
  });
});

describe('overrides beat Monaco', () => {
  test('.config -> xml even though ini registers the filename "config"', () => {
    expect(detect('App.config')).toBe('xml');
    expect(detect('web.config')).toBe('xml');
    expect(detect('src/Acme.Web/Web.config')).toBe('xml');
  });

  test.each([
    ['Acme.csproj', 'xml'],
    ['Acme.fsproj', 'xml'],
    ['Acme.vbproj', 'xml'],
    ['Directory.Build.props', 'xml'],
    ['Directory.Build.targets', 'xml'],
    ['Resources.resx', 'xml'],
    ['MainWindow.xaml', 'xml'],
    ['Acme.nuspec', 'xml'],
    ['logo.svg', 'xml'],
    ['Cargo.toml', 'ini'],
    ['pyproject.toml', 'ini'],
  ])('%s -> %s with Monaco languages', (p, id) => {
    expect(detect(p)).toBe(id);
  });

  test('an override wins over a conflicting Monaco registration', () => {
    const conflicting = [{ id: 'notxml', extensions: ['.csproj', '.resx', '.toml'] }];
    expect(detect('Acme.csproj', conflicting)).toBe('xml');
    expect(detect('Strings.resx', conflicting)).toBe('xml');
    expect(detect('Cargo.toml', conflicting)).toBe('ini');
  });

  test('an override wins over a Monaco filename registration', () => {
    const conflicting = [{ id: 'notini', filenames: ['.env'] }];
    expect(detect('.env', conflicting)).toBe('ini');
  });
});

describe('dotfiles', () => {
  test('.env matches the .env override', () => {
    expect(detect('.env')).toBe('ini');
    expect(detect('config/.env')).toBe('ini');
  });

  test('.env.local does not match the .env override by suffix', () => {
    expect(detect('.env.local')).toBe('plaintext');
  });

  test('.gitignore with no registration is plaintext', () => {
    expect(detect('.gitignore')).toBe('plaintext');
  });

  test('a dotfile counts as its own extension', () => {
    expect(detect('.eslintrc')).toBe('json');
    expect(detect('.babelrc')).toBe('json');
  });

  test('a dotfile counts as a basename for filename registrations', () => {
    expect(detect('.gitattributes')).toBe('ini');
  });
});

describe('nested paths', () => {
  test.each([
    ['src/Acme.Api/Program.cs', 'csharp'],
    ['src\\Acme.Api\\Program.cs', 'csharp'],
    ['src\\Acme.Api\\Acme.Api.csproj', 'xml'],
    ['deploy/scripts/run.ps1', 'powershell'],
    ['build\\docker\\Dockerfile', 'dockerfile'],
    ['build/docker/Dockerfile', 'dockerfile'],
    ['app\\.env', 'ini'],
    ['a/b\\c/Page.razor', 'razor'],
  ])('%s -> %s', (p, id) => {
    expect(detect(p)).toBe(id);
  });
});

describe('unknown and extensionless files', () => {
  test.each([
    'Makefile',
    'LICENSE',
    'bin/acme',
    'src\\tools\\acme',
    'data.unknownext',
    'archive.tar.zzz',
  ])('%s -> plaintext', (p) => {
    expect(detect(p)).toBe('plaintext');
  });

  test('a trailing dot is not an extension match', () => {
    expect(detect('weird.')).toBe('plaintext');
  });
});

describe('empty language list', () => {
  test('falls back to plaintext for Monaco-only extensions', () => {
    expect(detect('Program.cs', [])).toBe('plaintext');
    expect(detect('Dockerfile', [])).toBe('plaintext');
    expect(detect('app.js', [])).toBe('plaintext');
  });

  test('overrides still apply', () => {
    expect(detect('Acme.csproj', [])).toBe('xml');
    expect(detect('web.config', [])).toBe('xml');
    expect(detect('Cargo.toml', [])).toBe('ini');
    expect(detect('.env', [])).toBe('ini');
    expect(detect('logo.svg', [])).toBe('xml');
  });
});

describe('language entries without extensions or filenames', () => {
  test('entries missing either field are tolerated', () => {
    const sparse = [{ id: 'bare' }, { id: 'onlyname', filenames: ['acmefile'] }, { id: 'onlyext', extensions: ['.acme'] }];
    expect(detect('acmefile', sparse)).toBe('onlyname');
    expect(detect('x.acme', sparse)).toBe('onlyext');
    expect(detect('x.other', sparse)).toBe('plaintext');
  });
});

describe('ties', () => {
  test('two languages registering the same extension: first registered wins', () => {
    const langs = [
      { id: 'first', extensions: ['.acme'] },
      { id: 'second', extensions: ['.acme'] },
    ];
    expect(detect('widget.acme', langs)).toBe('first');
    expect(detect('widget.acme', [...langs].reverse())).toBe('second');
  });

  test('two languages registering the same filename: first registered wins', () => {
    const langs = [
      { id: 'first', filenames: ['Acmefile'] },
      { id: 'second', filenames: ['Acmefile'] },
    ];
    expect(detect('Acmefile', langs)).toBe('first');
  });
});
