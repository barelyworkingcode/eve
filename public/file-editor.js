class FileEditor {
  constructor(container) {
    this.app = container.get('app');
    this.log = container.get('logger').child('FileEditor');
    this.editor = null;
    this.currentFile = null;
    this.viewMode = 'split';
    this._previewDebounce = null;

    this._monacoLoaded = false;
    this.initElements();
    this.initEventListeners();
    this._listenForSettingsChanges();
  }

  _listenForSettingsChanges() {
    this.app.bus.on(EVT.SETTINGS_CHANGED, () => {
      if (!this.editor) return;
      const settings = this.app.settings;
      monaco.editor.setTheme(settings.isLight() ? 'vs' : 'vs-dark');
      this.editor.updateOptions({
        fontSize: settings.get('fontSize'),
        fontFamily: settings.getTerminalFontStack(),
      });
    });
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
    this.saveBtn.addEventListener('click', () => {
      this.saveCurrentFile();
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (this.currentFile) {
          this.saveCurrentFile();
        }
      }
    });

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

  isHtmlFile() {
    if (!this.currentFile) return false;
    return /\.html?$/i.test(this.currentFile.path);
  }

  isPreviewableFile() {
    return this.isMarkdownFile() || this.isHtmlFile();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.editorContentEl.setAttribute('data-view-mode', mode);

    this.viewModeToggle.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    this.editorContainer.style.flex = '';
    this.editorContainer.style.width = '';
    this.markdownPreview.style.flex = '';
    this.markdownPreview.style.width = '';

    if (mode !== 'preview' && this.editor) {
      this.editor.layout();
    }

    if (mode !== 'edit') {
      this.updatePreview();
    }
  }

  updatePreview() {
    if (!this.currentFile || !this.editor) return;

    if (this.isHtmlFile()) {
      this.renderHtmlPreview();
      return;
    }

    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return;

    const content = this.editor.getValue();
    this._teardownHtmlPreview();
    this.markdownPreview.innerHTML = DOMPurify.sanitize(marked.parse(content));
    this.app.messageRenderer.renderMermaidBlocks(this.markdownPreview);
  }

  renderHtmlPreview() {
    if (!this.currentFile) return;

    if (!this._htmlPreviewIframe) {
      this.markdownPreview.classList.add('markdown-preview--html');
      this.markdownPreview.innerHTML = '';

      const iframe = document.createElement('iframe');
      // No allow-same-origin → unique opaque origin; iframe cannot reach Eve's
      // DOM, cookies, or session token even though its own scripts run (the
      // server serves the file with a `sandbox allow-scripts` CSP via ?preview=1).
      iframe.setAttribute('sandbox', 'allow-scripts');
      this.markdownPreview.appendChild(iframe);
      this._htmlPreviewIframe = iframe;
    }

    // Loaded via `src`, not `srcdoc`: a srcdoc frame inherits Eve's strict
    // app-shell CSP and would block the file's scripts from running.
    const url = this._buildHtmlPreviewUrl();

    // Skip src reassignment when unchanged: reassigning is a navigation and would
    // reload the frame on every keystroke, restarting the page and its timers.
    if (this._htmlPreviewIframe.getAttribute('src') !== url) {
      this._htmlPreviewIframe.setAttribute('src', url);
    }
  }

  _buildHtmlPreviewUrl() {
    const { projectId, path: filePath } = this.currentFile;
    const cleanPath = filePath
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const v = this._previewVersion || 0;
    return `/api/files/${encodeURIComponent(projectId)}/${cleanPath}?preview=1&v=${v}`;
  }

  _refreshHtmlPreview() {
    this._previewVersion = (this._previewVersion || 0) + 1;
    if (this.isHtmlFile() && this.viewMode !== 'edit') {
      this.updatePreview();
    }
  }

  _teardownHtmlPreview() {
    if (!this._htmlPreviewIframe) return;
    this.markdownPreview.classList.remove('markdown-preview--html');
    this._htmlPreviewIframe = null;
    // innerHTML is overwritten by the caller (markdown render)
  }

  loadMonaco() {
    if (!window.require) {
      this.showEditorError('Monaco editor failed to load');
      return;
    }

    require.config({
      paths: {
        'vs': '/monaco/vs'
      }
    });

    require(['vs/editor/editor.main'], () => {
      this.createEditor();
    }, (err) => {
      this.log.error('Monaco editor failed to load:', err);
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
    const settings = this.app.settings;

    this.editor = monaco.editor.create(this.editorContainer, {
      value: '',
      language: 'plaintext',
      theme: settings.isLight() ? 'vs' : 'vs-dark',
      automaticLayout: true,
      fontSize: settings.get('fontSize'),
      fontFamily: settings.getTerminalFontStack(),
      tabSize: 2,
      insertSpaces: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      lineNumbers: 'on'
    });

    this.editor.onDidChangeModelContent(() => {
      if (this.currentFile) {
        const currentContent = this.editor.getValue();
        const isModified = currentContent !== this.currentFile.originalContent;

        this.saveBtn.disabled = !isModified;
        this.app.tabManager.setFileModified(
          this.currentFile.projectId,
          this.currentFile.path,
          isModified
        );

        if (this.isPreviewableFile() && this.viewMode !== 'edit') {
          clearTimeout(this._previewDebounce);
          this._previewDebounce = setTimeout(() => this.updatePreview(), 150);
        }
      }
    });
  }

  /**
   * Opens a file in the editor. Optional 1-based `lineNumber` jumps the
   * cursor + scrolls into view once content loads.
   */
  openFile(projectId, path, content, lineNumber) {
    // Set currentFile immediately to prevent duplicate requests from showFile
    this.currentFile = {
      projectId,
      path,
      content,
      originalContent: content,
      pendingLineNumber: typeof lineNumber === 'number' ? lineNumber : null,
    };

    if (!this._monacoLoaded) {
      this._monacoLoaded = true;
      this.loadMonaco();
    }

    if (!this.editor) {
      setTimeout(() => this.loadContentIntoEditor(), 100);
      return;
    }

    this.loadContentIntoEditor();
  }

  loadContentIntoEditor() {
    if (!this.editor) {
      setTimeout(() => this.loadContentIntoEditor(), 100);
      return;
    }

    if (!this.currentFile) return;

    const { path, content } = this.currentFile;

    this.editor.setValue(content);

    const language = this.detectLanguage(path);
    const model = this.editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, language);
    }

    this.editorPath.textContent = path;
    this.saveBtn.disabled = true;

    const isPlan = isPlanProject(this.currentFile.projectId);
    this.editor.updateOptions({ readOnly: isPlan });
    this.saveBtn.classList.toggle('hidden', isPlan);

    if (this.isPreviewableFile()) {
      this.viewModeToggle.classList.remove('hidden');
      this.setViewMode(isPlan ? 'preview' : this.viewMode);
    } else {
      this.viewModeToggle.classList.add('hidden');
      this.editorContentEl.removeAttribute('data-view-mode');
      this.editorContainer.style.flex = '';
      this.editorContainer.style.width = '';
      this.markdownPreview.style.flex = '';
      this.markdownPreview.style.width = '';
    }

    const pendingLine = this.currentFile.pendingLineNumber;
    if (typeof pendingLine === 'number' && pendingLine > 0) {
      this.currentFile.pendingLineNumber = null;
      this.editor.setPosition({ lineNumber: pendingLine, column: 1 });
      this.editor.revealLineInCenter(pendingLine);
      this.editor.focus();
    }
  }

  showFile(projectId, path) {
    if (this.currentFile?.projectId === projectId && this.currentFile?.path === path) {
      return;
    }

    if (isPlanProject(projectId)) {
      this.app.ws.send(JSON.stringify({ type: 'read_plan_file', path }));
    } else {
      this.app.ws.send(JSON.stringify({ type: 'read_file', projectId, path }));
    }
  }

  saveCurrentFile() {
    if (!this.currentFile) return;
    if (isPlanProject(this.currentFile.projectId)) return;

    const content = this.editor.getValue();

    this.app.ws.send(JSON.stringify({
      type: 'write_file',
      projectId: this.currentFile.projectId,
      path: this.currentFile.path,
      content
    }));

    this.currentFile.originalContent = content;
    this.saveBtn.disabled = true;

    this._refreshHtmlPreview();
  }

  handleExternalChange(projectId, path, content) {
    if (!this.currentFile) return;
    if (this.currentFile.projectId !== projectId || this.currentFile.path !== path) return;

    // Guards against FSEvents replaying a recent change right after the watcher
    // starts, which would otherwise pop a spurious "modified externally" bar.
    if (content === this.currentFile.originalContent) return;

    const currentContent = this.editor ? this.editor.getValue() : this.currentFile.content;
    const isClean = currentContent === this.currentFile.originalContent;

    if (isClean) {
      this._applyExternalContent(content);
    } else {
      this._showExternalChangeNotification(content);
    }
  }

  _applyExternalContent(content) {
    this.currentFile.content = content;
    this.currentFile.originalContent = content;

    if (this.editor) {
      const position = this.editor.getPosition();
      this.editor.setValue(content);
      if (position) this.editor.setPosition(position);
    }

    this.saveBtn.disabled = true;
    this.app.tabManager.setFileModified(
      this.currentFile.projectId,
      this.currentFile.path,
      false
    );

    this._refreshHtmlPreview();
  }

  _showExternalChangeNotification(newContent) {
    this.editorContentEl.querySelector('.external-change-bar')?.remove();

    const bar = document.createElement('div');
    bar.className = 'external-change-bar';
    bar.innerHTML = `
      <span>This file has been modified externally.</span>
      <div class="external-change-actions">
        <button class="btn-sm btn-primary external-change-reload">Reload</button>
        <button class="btn-sm btn-secondary external-change-keep">Keep Mine</button>
      </div>
    `;

    bar.querySelector('.external-change-reload').addEventListener('click', () => {
      this._applyExternalContent(newContent);
      bar.remove();
    });

    bar.querySelector('.external-change-keep').addEventListener('click', () => {
      this.currentFile.originalContent = newContent;
      bar.remove();
    });

    this.editorContentEl.insertBefore(bar, this.editorContentEl.firstChild);
  }

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileEditor;
}
