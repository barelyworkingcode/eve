const EVT = {
  WS_READY: 'ws:ready',
  WS_MESSAGE: 'ws:message',
  WS_DISCONNECTED: 'ws:disconnected',

  SESSION_CREATED: 'session:created',
  SESSION_JOINED: 'session:joined',
  SESSION_ENDED: 'session:ended',
  SESSION_REMOVED: 'session:removed',
  SESSION_RENAMED: 'session:renamed',
  SESSION_UPDATED: 'session:updated',
  SESSION_SWITCH: 'session:switch',

  PROJECTS_LOADED: 'projects:loaded',
  PROJECT_DELETED: 'project:deleted',
  PROJECT_RENAMED: 'project:renamed',
  PROJECT_ACTIVATED: 'project:activated',

  MODELS_LOADED: 'models:loaded',

  CHAT_ASSISTANT_START: 'chat:assistantStart',
  CHAT_ASSISTANT_DELTA: 'chat:assistantDelta',
  CHAT_ASSISTANT_FINISH: 'chat:assistantFinish',
  CHAT_TOOL_USE: 'chat:toolUse',
  CHAT_TOOL_COMPLETE: 'chat:toolComplete',
  CHAT_MESSAGE_COMPLETE: 'chat:messageComplete',
  CHAT_USER_MESSAGE: 'chat:userMessage',
  CHAT_RAW_OUTPUT: 'chat:rawOutput',
  CHAT_SYSTEM_MESSAGE: 'chat:systemMessage',
  CHAT_ERROR: 'chat:error',
  CHAT_CLEAR: 'chat:clear',
  CHAT_STATS_UPDATE: 'chat:statsUpdate',
  CHAT_PROCESS_EXITED: 'chat:processExited',

  CHAT_PLAN_APPROVAL: 'chat:planApproval',
  CHAT_ASK_QUESTION: 'chat:askQuestion',

  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_RESPONSE: 'permission:response',

  TERMINAL_CREATED: 'terminal:created',
  TERMINAL_JOINED: 'terminal:joined',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_CLOSED: 'terminal:closed',
  TERMINAL_LIST: 'terminal:list',
  TERMINAL_TEMPLATES: 'terminal:templates',
  TERMINAL_TEMPLATES_LOADED: 'terminal:templatesLoaded',

  FILE_CONTENT: 'file:content',
  FILE_SAVED: 'file:saved',
  FILE_CHANGED: 'file:changed',
  FILE_ERROR: 'file:error',
  DIRECTORY_LISTING: 'directory:listing',
  FILE_RENAMED: 'file:renamed',
  FILE_MOVED: 'file:moved',
  FILE_DELETED: 'file:deleted',
  FILE_UPLOADED: 'file:uploaded',
  DIRECTORY_CREATED: 'directory:created',
  DIR_CHANGED: 'directory:changed',

  TASKS_LOADED: 'tasks:loaded',
  TASK_UPDATED: 'task:updated',
  TASK_STARTED: 'task:started',
  TASK_COMPLETED: 'task:completed',
  TASK_ERROR: 'task:error',
  TASK_STATUS: 'task:status',

  UI_SHOW_CHAT: 'ui:showChat',
  UI_SHOW_EDITOR: 'ui:showEditor',
  UI_SHOW_TERMINAL: 'ui:showTerminal',
  UI_SHOW_WELCOME: 'ui:showWelcome',
  UI_TOGGLE_SIDEBAR: 'ui:toggleSidebar',

  DIALOG_SHELL_LAUNCHER: 'dialog:shellLauncher',
  DIALOG_TASK: 'dialog:task',
  DIALOG_PROJECT: 'dialog:project',
  DIALOG_CONFIRM: 'dialog:confirm',
  DIALOG_SETTINGS: 'dialog:settings',
  DIALOG_SEARCH: 'dialog:search',
  DIALOG_COMMAND_PALETTE: 'dialog:commandPalette',

  SEARCH_RESULTS: 'search:results',
  SEARCH_ERROR: 'search:error',
  SEARCH_AI_STARTED: 'search:aiStarted',
  SEARCH_AI_EVENT: 'search:aiEvent',
  SEARCH_AI_COMPLETED: 'search:aiCompleted',
  SEARCH_AI_FAILED: 'search:aiFailed',

  MODULE_LIST_UPDATED: 'module:listUpdated',
  MODULE_LAUNCH_REQUEST: 'module:launchRequest',
  MODULE_CREATE_REQUEST: 'module:createRequest',
  MODULE_OPENED: 'module:opened',
  MODULE_CLOSED: 'module:closed',
  MODULE_FILE_RESPONSE: 'module:fileResponse',
  MODULE_AI_STARTED: 'module:aiStarted',
  MODULE_AI_EVENT: 'module:aiEvent',
  MODULE_AI_COMPLETED: 'module:aiCompleted',
  MODULE_AI_FAILED: 'module:aiFailed',

  SETTINGS_CHANGED: 'settings:changed',

  VOICE_BACKEND_CHANGED: 'voice:backendChanged',
  TTS_PLAYBACK_ENDED: 'tts:playbackEnded',

  TOAST_SHOW:    'toast:show',
  TOAST_UPDATE:  'toast:update',
  TOAST_DISMISS: 'toast:dismiss',
};

const IS_NATIVE_APP = !!(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.Plugins?.EveVoice);
// A running native AVAudioEngine (via EveAudioBridge) holds the background-audio
// assertion that lets a voice conversation survive the screen turning off; this
// is independent of which TTS/STT model runs. Gated on the plugin's presence so
// a build without it falls back to the WebView audio path.
const IS_NATIVE_AUDIO = IS_NATIVE_APP && !!window.Capacitor?.Plugins?.EveAudioBridge;
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const IS_MOBILE_SAFARI = /iPhone|iPad|iPod/i.test(navigator.userAgent) && IS_SAFARI;
const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
// Apple keyboards label the modifier "Option" (⌥) rather than "Alt"; the
// escape sequence sent is the same either way.
const IS_APPLE = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const FAVORITE_TEMPLATE_ENABLED = true; // gate behind IS_NATIVE_APP before App Store submission

const PLAN_PROJECT_ID = '__plan__';

// Chat template modes (mirrors relay's ChatTemplate.Mode field)
const MODE_TEXT = 'text';
const MODE_VOICE = 'voice';

// Wildcard sentinel for "all MCPs" / "all models" — matches relay's isWildcard
const MCP_WILDCARD = '*';

function isPlanProject(projectId) {
  return projectId === PLAN_PROJECT_ID;
}
