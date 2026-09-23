// Maps a file path to a Monaco language id. Monaco's own registry
// (monaco.languages.getLanguages()) does most of the work; the overrides
// cover files it has no entry for but that read fine as a related language.

// Lower-case key -> language id. A key starting with '.' is an extension;
// any other key is an exact basename. Checked before Monaco's registry.
const LANGUAGE_OVERRIDES = {
  // MSBuild and .NET XML files
  '.csproj': 'xml',
  '.fsproj': 'xml',
  '.vbproj': 'xml',
  '.props': 'xml',
  '.targets': 'xml',
  '.resx': 'xml',
  '.xaml': 'xml',
  '.nuspec': 'xml',
  '.config': 'xml',
  '.svg': 'xml',
  '.toml': 'ini',
  '.env': 'ini',
};

// Longest key in `keys` that `name` ends with, or null. Only '.'-prefixed
// keys are extensions. First one wins a tie.
function longestSuffix(name, keys) {
  let best = null;
  for (const key of keys) {
    if (!key || key[0] !== '.') continue;
    const k = key.toLowerCase();
    if (name.endsWith(k) && (best === null || k.length > best.length)) best = k;
  }
  return best;
}

function languageForPath(path, languages) {
  const base = String(path || '').split(/[\\/]/).pop().toLowerCase();
  if (!base) return 'plaintext';

  if (Object.prototype.hasOwnProperty.call(LANGUAGE_OVERRIDES, base) && base[0] !== '.') {
    return LANGUAGE_OVERRIDES[base];
  }
  const overrideExt = longestSuffix(base, Object.keys(LANGUAGE_OVERRIDES));
  if (overrideExt) return LANGUAGE_OVERRIDES[overrideExt];

  const langs = languages || [];
  for (const lang of langs) {
    if ((lang.filenames || []).some(f => f.toLowerCase() === base)) return lang.id;
  }

  let bestId = null;
  let bestLen = 0;
  for (const lang of langs) {
    const ext = longestSuffix(base, lang.extensions || []);
    if (ext && ext.length > bestLen) {
      bestId = lang.id;
      bestLen = ext.length;
    }
  }
  return bestId || 'plaintext';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { languageForPath, LANGUAGE_OVERRIDES };
}
