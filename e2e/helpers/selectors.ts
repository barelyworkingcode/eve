/** Centralized CSS selectors for Eve E2E tests */

export const S = {
  // Screens
  welcomeScreen: '#welcomeScreen',
  chatScreen: '#chatScreen',

  // Sidebar
  sidebar: '#sidebar',
  projectList: '#projectList',
  newProjectBtn: '#newProjectBtn',
  newSessionBtn: '#newSessionBtn',

  // Project elements
  projectGroup: '.project-group',
  projectHeader: '.project-header',
  projectName: '.project-name',
  projectModel: '.project-model',
  projectQuickAdd: '.project-quick-add',
  projectDelete: '.project-delete',
  projectFilesToggle: '.project-files-toggle',

  // Session elements
  sessionItem: '.session-item',
  sessionName: '.session-name',
  sessionDelete: '.session-delete',
  sessionRenameInput: '.session-rename-input',

  // Tabs
  tabBar: '#tabBar',
  tab: '.tab',
  tabActive: '.tab.active',
  tabLabel: '.tab-label',
  tabClose: '.tab-close',

  // Chat
  messages: '#messages',
  userInput: '#userInput',
  sendBtn: '#sendBtn',
  messageUser: '.message.user',
  messageAssistant: '.message.assistant',
  thinkingIndicator: '#thinkingIndicator',

  // Modals
  modal: '#modal',
  newSessionForm: '#newSessionForm',
  projectSelect: '#projectSelect',
  directoryInput: '#directoryInput',
  cancelModal: '#cancelModal',

  projectModal: '#projectModal',
  newProjectForm: '#newProjectForm',
  projectNameInput: '#projectNameInput',
  projectPathInput: '#projectPathInput',
  projectModelSelect: '#projectModelSelect',
  cancelProjectModal: '#cancelProjectModal',

  confirmModal: '#confirmModal',
  confirmMessage: '#confirmMessage',
  confirmDelete: '#confirmDelete',
  cancelConfirm: '#cancelConfirm',

  // Terminal
  terminalContent: '#terminal',
  terminalContainer: '#terminalContainer',

  // File browser / editor
  fileTree: '.file-tree',
  fileTreeItem: '.file-tree-item',
  monacoEditor: '#monacoEditor',
  markdownPreview: '#markdownPreview',
  saveFileBtn: '#saveFileBtn',
  viewModeToggle: '#viewModeToggle',
  editorContent: '#editor',
} as const;
