class FileEditor {
  constructor(client) {
    this.client = client;
    this.editor = null;
    this.currentFile = null; // { projectId, path, content, originalContent }
    this.viewMode = 'split';
    this._previewDebounce = null;

    this.initMonaco();
    this.initElements();
    this.initEventListeners();
  }

  initElements() {
    this.editorContainer = document.getElementById('monacoEditor');
    this.saveBtn = document.getElementById('saveFileBtn');
    this.editorPath = document.getElementById('editorPath');
    this.editorContentEl = document.getElementById('editor');
    this.editorPanes = this.editorContentEl.querySelector('.editor-panes');
    this.markdownPreview = document.getElementById('markdownPreview');
    this.splitDivider = this.editorContentEl.querySelector('.editor-split-divider');
    this.viewModeToggle = document.getElementById('viewModeToggle');
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

    // View mode toggle buttons
    this.viewModeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.view-mode-btn');
      if (!btn) return;
      this.setViewMode(btn.dataset.mode);
    });

    this.initSplitResize();
  }

  initSplitResize() {
    let startX, startLeftWidth, startRightWidth;

    const onMouseMove = (e) => {
      const dx = e.clientX - startX;
      const panesWidth = this.editorPanes.offsetWidth - this.splitDivider.offsetWidth;
      let leftWidth = startLeftWidth + dx;
      let rightWidth = startRightWidth - dx;

      // Enforce minimums
      if (leftWidth < 200) { leftWidth = 200; rightWidth = panesWidth - leftWidth; }
      if (rightWidth < 200) { rightWidth = 200; leftWidth = panesWidth - rightWidth; }

      this.editorContainer.style.flex = 'none';
      this.editorContainer.style.width = leftWidth + 'px';
      this.markdownPreview.style.flex = 'none';
      this.markdownPreview.style.width = rightWidth + 'px';

      if (this.editor) this.editor.layout();
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      this.splitDivider.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    this.splitDivider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startLeftWidth = this.editorContainer.offsetWidth;
      startRightWidth = this.markdownPreview.offsetWidth;
      this.splitDivider.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  isMarkdownFile() {
    if (!this.currentFile) return false;
    return /\.md$/i.test(this.currentFile.path);
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.editorContentEl.setAttribute('data-view-mode', mode);

    // Update toggle button active states
    this.viewModeToggle.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Reset custom split widths when changing mode
    this.editorContainer.style.flex = '';
    this.editorContainer.style.width = '';
    this.markdownPreview.style.flex = '';
    this.markdownPreview.style.width = '';

    // Layout editor when it becomes visible
    if (mode !== 'preview' && this.editor) {
      this.editor.layout();
    }

    // Update preview when it becomes visible
    if (mode !== 'edit') {
      this.updatePreview();
    }
  }

  updatePreview() {
    if (!this.currentFile || !this.editor) return;
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return;

    const content = this.editor.getValue();
    this.markdownPreview.innerHTML = DOMPurify.sanitize(marked.parse(content));
  }

  initMonaco() {
    // Load Monaco editor module
    this.loadMonaco();
  }

  loadMonaco() {
    console.log('[FileEditor] loadMonaco called, window.require:', typeof window.require);
    if (!window.require) {
      console.error('[FileEditor] Monaco loader not found');
      this.showEditorError('Monaco editor failed to load');
      return;
    }

    require.config({
      paths: {
        'vs': '/monaco/vs'
      }
    });

    console.log('[FileEditor] Loading Monaco editor...');
    require(['vs/editor/editor.main'], () => {
      console.log('[FileEditor] Monaco editor loaded, creating editor');
      this.createEditor();
    }, (err) => {
      console.error('[FileEditor] Monaco editor failed to load:', err);
      this.showEditorError('Monaco editor failed to load.');
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
    console.log('[FileEditor] createEditor called, container:', this.editorContainer);
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

    console.log('[FileEditor] Editor created:', !!this.editor);

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

        // Debounced markdown preview update
        if (this.isMarkdownFile() && this.viewMode !== 'edit') {
          clearTimeout(this._previewDebounce);
          this._previewDebounce = setTimeout(() => this.updatePreview(), 150);
        }
      }
    });
  }

  /**
   * Opens a file in the editor
   */
  openFile(projectId, path, content) {
    console.log('[FileEditor] openFile called:', projectId, path);

    // Set currentFile immediately to prevent duplicate requests from showFile
    this.currentFile = {
      projectId,
      path,
      content,
      originalContent: content
    };
    console.log('[FileEditor] currentFile set to:', this.currentFile.projectId, this.currentFile.path);

    if (!this.editor) {
      // Monaco not ready yet, retry later to actually load content
      console.log('[FileEditor] Monaco not ready, retrying in 100ms');
      setTimeout(() => this.loadContentIntoEditor(), 100);
      return;
    }

    this.loadContentIntoEditor();
  }

  /**
   * Loads the current file content into Monaco editor
   */
  loadContentIntoEditor() {
    console.log('[FileEditor] loadContentIntoEditor called, editor:', !!this.editor);

    if (!this.editor) {
      // Monaco still not ready, retry
      console.log('[FileEditor] Editor not ready, retrying in 100ms');
      setTimeout(() => this.loadContentIntoEditor(), 100);
      return;
    }

    if (!this.currentFile) {
      console.log('[FileEditor] No currentFile to load');
      return;
    }

    const { path, content } = this.currentFile;
    console.log('[FileEditor] Setting editor content for:', path, 'length:', content?.length);

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

    // Configure view mode based on file type
    if (this.isMarkdownFile()) {
      this.viewModeToggle.classList.remove('hidden');
      this.setViewMode(this.viewMode);
    } else {
      this.viewModeToggle.classList.add('hidden');
      this.editorContentEl.removeAttribute('data-view-mode');
      // Reset any custom split widths
      this.editorContainer.style.flex = '';
      this.editorContainer.style.width = '';
      this.markdownPreview.style.flex = '';
      this.markdownPreview.style.width = '';
    }
  }

  /**
   * Shows a specific file (called by tab manager)
   */
  showFile(projectId, path) {
    console.log('[FileEditor] showFile called:', projectId, path);
    console.log('[FileEditor] currentFile:', this.currentFile);

    if (this.currentFile?.projectId === projectId && this.currentFile?.path === path) {
      // File already loaded
      console.log('[FileEditor] File already loaded, skipping request');
      return;
    }

    console.log('[FileEditor] Requesting file from server');
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
