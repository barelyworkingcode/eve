'use strict';

// Lint rules that restate the static guards (docs/test.md, "Lint rules and
// checks"). Guards a linter cannot express (CSS, HTML, file names, frozen
// sets) live in scripts/check-static.js.
const playwright = require('eslint-plugin-playwright');

const quote = (re) => re.replace(/[\\/]/g, '\\$&');

// E1: eve reaches project files only through relay, so no server module may
// load the file system, a child process, ripgrep or a trash library.
const BANNED_MODULES = '^(node:)?(fs|child_process|@vscode/ripgrep|trash)(/.*)?$';
// Each file that may keep one of those, with the reason. check-static S1 reads
// this list: every name must exist.
const FILE_PLANE_ALLOWLIST = [
  'server.js', // index.html, data dir, settings
  'auth.js', // auth.json
  'session-store.js', // sessions.json
  'notifier.js', // notifications log
  'chief-of-staff.js', // its data dir
  'launch-identity.js', // fd 3
  'relay-transport.js', // CA file
  'terminal-paste.js', // the OS temp dir, not a project
  'ws/file-messages.js', // ~/.claude/plans
  'ws/diagnostics-messages.js', // device log
];
const SERVER_FILES = ['*.js', 'ws/**/*.js', 'routes/**/*.js', 'mcp/**/*.js'];

const E1 = [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/${quote(BANNED_MODULES)}/]`,
    message: 'E1: eve reaches project files through relay, not fs, child_process, ripgrep or trash. A file that must keep one goes in the allowlist in eslint.config.js with its reason.',
  },
  {
    selector: "ImportExpression[source.value='trash']",
    message: 'E1: eve reaches project files through relay, not a trash library.',
  },
];

// E4: all egress to relay goes through relay-transport.js. Voice's net.Socket
// stays allowed (CLAUDE.md).
const E4 = [
  { selector: "CallExpression[callee.name='fetch']", message: 'E4: no raw fetch(); relay egress goes through RelayTransport.' },
  { selector: "NewExpression[callee.name='WebSocket']", message: 'E4: no new WebSocket(); relay egress goes through RelayTransport.' },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(request|get)$/][callee.object.name=/^(http|https)$/]",
    message: 'E4: no http.request() or http.get(); relay egress goes through RelayTransport.',
  },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(request|get)$/][callee.object.type='CallExpression'][callee.object.callee.name='require'][callee.object.arguments.0.value=/^(node:)?https?$/]",
    message: 'E4: no http.request() or http.get(); relay egress goes through RelayTransport.',
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?undici$/]",
    message: 'E4: no undici; relay egress goes through RelayTransport.',
  },
];

// E5: a spec drives eve only through what a person sees. These properties are
// banned on any receiver.
const SCREEN_ONLY_BANNED = [
  'locator', 'frameLocator', 'getByTestId', 'getByPlaceholder', 'getByAltText', 'getByTitle',
  '$', '$$', '$eval', '$$eval', 'waitForSelector',
  'evaluate', 'evaluateAll', 'evaluateHandle', 'waitForFunction',
  'addInitScript', 'addScriptTag', 'exposeFunction', 'exposeBinding',
  'route', 'routeWebSocket', 'unroute', 'request', 'goto', 'newCDPSession',
];
const E3_MESSAGE = 'E3: wait on a signal (data-ready, an event, an expect), not a duration.';
const E5_MESSAGE = 'E5: a spec uses role, label and text locators and the fixtures only. Drive eve through the screen.';

const bannedProperties = (names, message) => names.map((property) => ({ property, message }));
const nameList = SCREEN_ONLY_BANNED.map((n) => n.replace(/\$/g, '\\$')).join('|');

const E5_SYNTAX = [
  {
    // eve.reload() is the fixture; page.reload() and any other receiver is not.
    selector: "MemberExpression[property.name='reload']:not([object.name='eve'])",
    message: E5_MESSAGE,
  },
  {
    selector: `ObjectPattern > Property[key.name=/^(${nameList}|reload)$/]`,
    message: `${E5_MESSAGE} Do not destructure the banned members out of page or a locator.`,
  },
  {
    selector: ':function > ObjectPattern.params > Property[key.name="request"]',
    message: 'E5: a spec does not take the request fixture; drive eve through the screen.',
  },
];

// E6: a spec imports the fixtures and worlds, and nothing else.
const E6_SYNTAX = [
  {
    selector: "CallExpression[callee.name='require']:not([arguments.0.value=/^\\.\\/support\\/(fixtures|worlds)$/])",
    message: 'E6: a spec requires only ./support/fixtures and ./support/worlds.',
  },
  { selector: 'ImportDeclaration, ImportExpression', message: 'E6: a spec requires only ./support/fixtures and ./support/worlds.' },
];

module.exports = [
  {
    ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**', 'public/kokoro-voices/**'],
  },
  {
    // An added `eslint-disable` comment must not be able to switch a gate off.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  { files: ['**/*.js', '**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module' } },
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'script' } },

  {
    name: 'E1 and E4: server code',
    files: SERVER_FILES,
    rules: { 'no-restricted-syntax': ['error', ...E1, ...E4] },
  },
  {
    name: 'E1 allowlist',
    files: FILE_PLANE_ALLOWLIST,
    rules: { 'no-restricted-syntax': ['error', ...E4] },
  },
  {
    // The one egress to relay.
    name: 'E4 exemption',
    files: ['relay-transport.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    name: 'E2: iframe sandbox',
    files: ['public/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'Literal[value=/allow-same-origin/]', message: 'E2: a project-content iframe is sandboxed with allow-scripts only; never allow-same-origin.' },
        { selector: 'TemplateElement[value.raw=/allow-same-origin/]', message: 'E2: a project-content iframe is sandboxed with allow-scripts only; never allow-same-origin.' },
      ],
    },
  },

  {
    name: 'E3: no fixed waits',
    files: ['test/e2e/**/*.{js,cjs,mjs}'],
    plugins: { playwright },
    rules: {
      'playwright/no-wait-for-timeout': 'error',
      // The plugin only names `page`-like receivers; this catches any receiver.
      'no-restricted-properties': ['error', ...bannedProperties(['waitForTimeout'], E3_MESSAGE)],
    },
  },
  {
    name: 'E5 and E6: specs',
    files: ['test/e2e/*.spec.js'],
    rules: {
      'no-restricted-properties': ['error',
        ...bannedProperties(['waitForTimeout'], E3_MESSAGE),
        ...bannedProperties(SCREEN_ONLY_BANNED, E5_MESSAGE)],
      'no-restricted-syntax': ['error', ...E5_SYNTAX, ...E6_SYNTAX],
    },
  },
];
