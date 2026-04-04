/**
 * Event name constants for the EventBus.
 * Grouped by domain for easy discovery.
 */
const EVT = {
  // WebSocket lifecycle
  WS_READY: 'ws:ready',
  WS_MESSAGE: 'ws:message',
  WS_DISCONNECTED: 'ws:disconnected',

  // Session lifecycle
  SESSION_CREATED: 'session:created',
  SESSION_JOINED: 'session:joined',
  SESSION_ENDED: 'session:ended',
  SESSION_REMOVED: 'session:removed',
  SESSION_RENAMED: 'session:renamed',
  SESSION_UPDATED: 'session:updated',
  SESSION_SWITCH: 'session:switch',

  // Project lifecycle
  PROJECTS_LOADED: 'projects:loaded',
  PROJECT_DELETED: 'project:deleted',

  // Models
  MODELS_LOADED: 'models:loaded',

  // Chat / LLM streaming
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

  // Interactive tools
  CHAT_PLAN_APPROVAL: 'chat:planApproval',
  CHAT_ASK_QUESTION: 'chat:askQuestion',

  // Permission
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_RESPONSE: 'permission:response',

  // Terminal
  TERMINAL_CREATED: 'terminal:created',
  TERMINAL_JOINED: 'terminal:joined',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_CLOSED: 'terminal:closed',
  TERMINAL_LIST: 'terminal:list',
  TERMINAL_TEMPLATES: 'terminal:templates',

  // File operations
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

  // Task lifecycle
  TASKS_LOADED: 'tasks:loaded',
  TASK_UPDATED: 'task:updated',
  TASK_STARTED: 'task:started',
  TASK_COMPLETED: 'task:completed',
  TASK_ERROR: 'task:error',
  TASK_STATUS: 'task:status',

  // UI navigation
  UI_SHOW_CHAT: 'ui:showChat',
  UI_SHOW_EDITOR: 'ui:showEditor',
  UI_SHOW_TERMINAL: 'ui:showTerminal',
  UI_SHOW_WELCOME: 'ui:showWelcome',
  UI_TOGGLE_SIDEBAR: 'ui:toggleSidebar',

  // Dialog requests
  DIALOG_SHELL_LAUNCHER: 'dialog:shellLauncher',
  DIALOG_TASK: 'dialog:task',
  DIALOG_PROJECT: 'dialog:project',
  DIALOG_CONFIRM: 'dialog:confirm',
  DIALOG_SETTINGS: 'dialog:settings',

  // Settings
  SETTINGS_CHANGED: 'settings:changed',

  // Voice
  VOICE_BACKEND_CHANGED: 'voice:backendChanged',

  // Toast (generic)
  TOAST_SHOW:    'toast:show',
  TOAST_UPDATE:  'toast:update',
  TOAST_DISMISS: 'toast:dismiss',
};

// Platform detection (invariant for page lifetime)
const IS_NATIVE_APP = !!(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.Plugins?.EveVoice);
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const IS_MOBILE_SAFARI = /iPhone|iPad|iPod/i.test(navigator.userAgent) && IS_SAFARI;

// Plan file project ID sentinel
const PLAN_PROJECT_ID = '__plan__';

function isPlanProject(projectId) {
  return projectId === PLAN_PROJECT_ID;
}
