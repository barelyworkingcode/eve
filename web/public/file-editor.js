class FileEditor {
  constructor(client) {
    this.client = client;
    this.editor = null;
    this.currentFile = null; // { projectId, path, content, originalContent }

    this.initMonaco();
    this.initElements();
    this.initEventListeners();
  }

  initElements() {
    this.editorContainer = document.getElementById('monacoEditor');
    this.saveBtn = document.getElementById('saveFileBtn');
    this.editorPath = document.getElementById('editorPath');
  }

  initEventListeners() {
    // Save button
    this.saveBtn.addEventListener('click', () => {
      this.saveCurrentFile();
    });

    // Cmd/Ctrl+S to save
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (this.currentFile) {
          this.saveCurrentFile();
        }
      }
    });
  }

  initMonaco() {
    // Monaco will be loaded from CDN
    if (typeof require === 'undefined') {
      // Load Monaco
      this.loadMonaco();
    }
  }

  loadMonaco() {
    if (!window.require) {
      console.error('Monaco loader not found');
      this.showEditorError('Monaco editor failed to load');
      return;
    }

    require.config({
      paths: {
        'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs'
      }
    });

    require(['vs/editor/editor.main'], () => {
      this.createEditor();
    }, (err) => {
      console.error('Monaco editor failed to load:', err);
      this.showEditorError('Monaco editor failed to load. Check your internet connection.');
    });
  }

  showEditorError(message) {
    this.editorContainer.innerHTML = `
      <div style="padding: 20px; color: var(--danger); text-align: center;">
        <p>${message}</p>
      </div>
    `;
  }

  createEditor() {
    this.editor = monaco.editor.create(this.editorContainer, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
      tabSize: 2,
      insertSpaces: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      lineNumbers: 'on'
    });

    // Listen for content changes
    this.editor.onDidChangeModelContent(() => {
      if (this.currentFile) {
        const currentContent = this.editor.getValue();
        const isModified = currentContent !== this.currentFile.originalContent;

        this.saveBtn.disabled = !isModified;
        this.client.tabManager.setFileModified(
          this.currentFile.projectId,
          this.currentFile.path,
          isModified
        );
      }
    });
  }

  /**
   * Opens a file in the editor
   */
  openFile(projectId, path, content) {
    if (!this.editor) {
      // Monaco not ready yet, retry later
      setTimeout(() => this.openFile(projectId, path, content), 100);
      return;
    }

    this.currentFile = {
      projectId,
      path,
      content,
      originalContent: content
    };

    // Set editor content
    this.editor.setValue(content);

    // Detect language from file extension
    const language = this.detectLanguage(path);
    const model = this.editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, language);
    }

    // Update UI
    this.editorPath.textContent = path;
    this.saveBtn.disabled = true;
  }

  /**
   * Shows a specific file (called by tab manager)
   */
  showFile(projectId, path) {
    if (this.currentFile?.projectId === projectId && this.currentFile?.path === path) {
      // File already loaded
      return;
    }

    // Request file content from server if not already loaded
    this.client.ws.send(JSON.stringify({
      type: 'read_file',
      projectId,
      path
    }));
  }

  /**
   * Saves the current file
   */
  saveCurrentFile() {
    if (!this.currentFile) return;

    const content = this.editor.getValue();

    this.client.ws.send(JSON.stringify({
      type: 'write_file',
      projectId: this.currentFile.projectId,
      path: this.currentFile.path,
      content
    }));

    // Update original content after save
    this.currentFile.originalContent = content;
    this.saveBtn.disabled = true;
  }

  /**
   * Detects language from file extension
   */
  detectLanguage(path) {
    const ext = path.split('.').pop().toLowerCase();

    const languageMap = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'json': 'json',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'md': 'markdown',
      'py': 'python',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'sh': 'shell',
      'bash': 'shell',
      'yml': 'yaml',
      'yaml': 'yaml',
      'toml': 'ini',
      'sql': 'sql',
      'xml': 'xml',
      'svg': 'xml'
    };

    return languageMap[ext] || 'plaintext';
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileEditor;
}
