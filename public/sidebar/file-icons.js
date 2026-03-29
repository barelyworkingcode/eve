/**
 * FileIcons - extension-to-SVG icon mapping.
 * Single-color SVGs colored via CSS (VS Code Seti-style approach).
 */

const FILE_ICON_COLORS = {
  js: '#cbcb41',
  mjs: '#cbcb41',
  cjs: '#cbcb41',
  ts: '#519aba',
  tsx: '#519aba',
  jsx: '#519aba',
  json: '#cbcb41',
  md: '#519aba',
  html: '#e44d26',
  htm: '#e44d26',
  css: '#563d7c',
  scss: '#c6538c',
  less: '#563d7c',
  py: '#3572a5',
  go: '#00add8',
  rs: '#dea584',
  rb: '#cc342d',
  java: '#b07219',
  c: '#555555',
  cpp: '#f34b7d',
  h: '#555555',
  hpp: '#f34b7d',
  swift: '#f05138',
  kt: '#a97bff',
  sh: '#89e051',
  bash: '#89e051',
  zsh: '#89e051',
  sql: '#e38c00',
  yaml: '#cb171e',
  yml: '#cb171e',
  toml: '#9c4221',
  ini: '#9c4221',
  conf: '#9c4221',
  xml: '#e44d26',
  svg: '#ffb13b',
  log: '#8a8a8a',
  txt: '#8a8a8a',
  env: '#ecd53f',
  lock: '#8a8a8a',
  gitignore: '#f05032',
  dockerfile: '#2496ed',
  makefile: '#6d8086',
  vue: '#42b883',
  svelte: '#ff3e00',
  xlsx: '#217346',
  xls: '#217346',
  csv: '#217346',
  pdf: '#e44d26',
  png: '#a074c4',
  jpg: '#a074c4',
  jpeg: '#a074c4',
  gif: '#a074c4',
  ico: '#a074c4',
  webp: '#a074c4',
  default: '#8a8a8a',
  folder: '#dcb67a',
  folderOpen: '#dcb67a',
};

// Compact SVG paths for file type icons (16x16 viewBox)
const FILE_ICON_SVGS = {
  // Generic file
  file: '<path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  // Folder closed
  folder: '<path d="M2 4h4l1.5-2H14a1 1 0 011 1v9a1 1 0 01-1 1H2a1 1 0 01-1-1V5a1 1 0 011-1z" fill="currentColor" opacity="0.85"/>',
  // Folder open
  folderOpen: '<path d="M2 4h4l1.5-2H14a1 1 0 011 1v2H5L3 13H2a1 1 0 01-1-1V5a1 1 0 011-1z" fill="currentColor" opacity="0.85"/><path d="M5 7h11l-2 7H3z" fill="currentColor" opacity="0.6"/>',
  // Code file (js, ts, etc.)
  code: '<path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 9l2 2-2 2M9 13h2.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  // Markdown
  markdown: '<path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 10v-3l1.5 2 1.5-2v3M10 10V7l2 3V7" fill="none" stroke="currentColor" stroke-width="1"/>',
  // Config/data (json, yaml, toml)
  config: '<path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6.5" cy="9.5" r="0.8" fill="currentColor"/><circle cx="6.5" cy="12" r="0.8" fill="currentColor"/><line x1="8" y1="9.5" x2="11.5" y2="9.5" stroke="currentColor" stroke-width="0.8"/><line x1="8" y1="12" x2="11.5" y2="12" stroke="currentColor" stroke-width="0.8"/>',
  // Image
  image: '<path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="8" r="1" fill="currentColor"/><path d="M3 13l3-4 2 2 2-3 3 5" fill="none" stroke="currentColor" stroke-width="0.8"/>',
  // Shell script
  shell: '<path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 9l2.5 2-2.5 2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="9" y1="13" x2="12" y2="13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  // Spreadsheet
  spreadsheet: '<path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 8h8M4 10.5h8M7 7v5.5M10 7v5.5" stroke="currentColor" stroke-width="0.6"/>',
};

// Map extensions to SVG shape
const EXT_TO_SHAPE = {
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code',
  py: 'code', go: 'code', rs: 'code', rb: 'code', java: 'code', c: 'code',
  cpp: 'code', h: 'code', hpp: 'code', swift: 'code', kt: 'code',
  html: 'code', htm: 'code', css: 'code', scss: 'code', less: 'code',
  xml: 'code', svg: 'code', vue: 'code', svelte: 'code', sql: 'code',
  md: 'markdown',
  json: 'config', yaml: 'config', yml: 'config', toml: 'config',
  ini: 'config', conf: 'config', env: 'config', lock: 'config',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  xlsx: 'spreadsheet', xls: 'spreadsheet', csv: 'spreadsheet',
};

/**
 * Returns an SVG icon element for a filename.
 */
function getFileIconSVG(filename) {
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  // Special filenames
  const nameLower = filename.toLowerCase();
  let shape = 'file';
  let color = FILE_ICON_COLORS.default;

  if (nameLower === 'dockerfile' || nameLower.startsWith('dockerfile.')) {
    color = FILE_ICON_COLORS.dockerfile;
    shape = 'config';
  } else if (nameLower === 'makefile' || nameLower === 'gnumakefile') {
    color = FILE_ICON_COLORS.makefile;
    shape = 'config';
  } else if (nameLower === '.gitignore' || nameLower === '.gitattributes') {
    color = FILE_ICON_COLORS.gitignore;
    shape = 'config';
  } else {
    shape = EXT_TO_SHAPE[ext] || 'file';
    color = FILE_ICON_COLORS[ext] || FILE_ICON_COLORS.default;
  }

  return _makeSVG(FILE_ICON_SVGS[shape], color);
}

/**
 * Returns an SVG icon element for a folder.
 */
function getFolderIconSVG(isOpen) {
  const shape = isOpen ? 'folderOpen' : 'folder';
  const color = FILE_ICON_COLORS.folder;
  return _makeSVG(FILE_ICON_SVGS[shape], color);
}

function _makeSVG(pathData, color) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.style.color = color;
  svg.style.flexShrink = '0';
  svg.innerHTML = pathData;
  return svg;
}
