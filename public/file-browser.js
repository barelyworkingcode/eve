class FileBrowser {
  constructor(container) {
    this.app = container.get('app');
    this.log = container.get('logger').child('FileBrowser');
    this.projectTrees = new Map();
    this.dragState = null;
    this.renameState = null;
    this.contextMenuEl = null;

    this.initContextMenu();
  }

  initContextMenu() {
    this.contextMenuEl = document.createElement('div');
    this.contextMenuEl.className = 'file-context-menu hidden';
    this.contextMenuEl.innerHTML = `
      <button data-action="rename">Rename</button>
      <button data-action="delete">Delete</button>
      <button data-action="new-folder">New Folder</button>
    `;
    document.body.appendChild(this.contextMenuEl);

    document.addEventListener('click', (e) => {
      if (!this.contextMenuEl.contains(e.target)) {
        this.hideContextMenu();
      }
    });

    this.contextMenuEl.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (action) {
        this.handleContextAction(action);
      }
    });
  }

  showContextMenu(x, y, projectId, path, type) {
    this.contextMenuProjectId = projectId;
    this.contextMenuPath = path;
    this.contextMenuType = type;

    this.contextMenuEl.style.left = `${x}px`;
    this.contextMenuEl.style.top = `${y}px`;
    this.contextMenuEl.classList.remove('hidden');

    const rect = this.contextMenuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      this.contextMenuEl.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      this.contextMenuEl.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  }

  hideContextMenu() {
    this.contextMenuEl.classList.add('hidden');
  }

  handleContextAction(action) {
    this.hideContextMenu();

    switch (action) {
      case 'rename':
        this.startRename(this.contextMenuProjectId, this.contextMenuPath);
        break;
      case 'delete':
        this.confirmDelete(this.contextMenuProjectId, this.contextMenuPath);
        break;
      case 'new-folder':
        this.promptNewFolder(this.contextMenuProjectId, this.contextMenuPath, this.contextMenuType);
        break;
    }
  }

  startRename(projectId, path) {
    const container = document.querySelector(`[data-project-id="${projectId}"] .file-tree`);
    if (!container) return;

    const item = container.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (!item) return;

    const nameEl = item.querySelector('.file-tree-name');
    if (!nameEl) return;

    const currentName = nameEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-rename-input';
    input.value = currentName;

    this.renameState = { projectId, path, originalName: currentName };

    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        this.app.ws.send(JSON.stringify({
          type: 'rename_file',
          projectId,
          path,
          newName
        }));
      }
      // Reverts to old name even on success; handleFileRenamed re-renders once the server confirms.
      nameEl.textContent = currentName;
      this.renameState = null;
    };

    const cancel = () => {
      nameEl.textContent = currentName;
      this.renameState = null;
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

    input.addEventListener('blur', commit);
  }

  confirmDelete(projectId, path) {
    const filename = path.split('/').pop();
    this.app.modalManager.showConfirmModal(`Delete "${filename}"?`, () => {
      this.app.ws.send(JSON.stringify({
        type: 'delete_file',
        projectId,
        path
      }));
    });
  }

  promptNewFolder(projectId, path, type) {
    const parentPath = type === 'directory' ? path : path.substring(0, path.lastIndexOf('/')) || '/';

    const name = prompt('New folder name:');
    if (name && name.trim()) {
      this.app.ws.send(JSON.stringify({
        type: 'create_directory',
        projectId,
        parentPath,
        name: name.trim()
      }));
    }
  }

  toggleFileTree(projectId) {
    const tree = this.projectTrees.get(projectId);

    if (!tree) {
      this.projectTrees.set(projectId, {
        expanded: true,
        entries: null,
        loading: false,
        expandedPaths: new Set()
      });

      this.loadDirectory(projectId, '/');
    } else {
      tree.expanded = !tree.expanded;
      this.renderFileTree(projectId);
    }
  }

  loadDirectory(projectId, path) {
    const tree = this.projectTrees.get(projectId);
    if (!tree) return;

    tree.loading = true;
    this.renderFileTree(projectId);

    this.app.ws.send(JSON.stringify({
      type: 'list_directory',
      projectId,
      path
    }));
  }

  handleDirectoryListing(projectId, path, entries) {
    const tree = this.projectTrees.get(projectId);
    if (!tree) return;

    tree.loading = false;

    if (path === '/' || path === '') {
      tree.entries = entries;
    } else {
      if (!tree.subdirectories) {
        tree.subdirectories = new Map();
      }
      tree.subdirectories.set(path, entries);
    }

    this.renderFileTree(projectId);
  }

  handleFileError(projectId, path, error) {
    this.log.error(`File error for ${projectId}:${path}:`, error);

    const project = this.app.projects.get(projectId);
    const projectName = project?.name || 'Unknown project';
    this.app.messageRenderer.appendSystemMessage(`File error in ${projectName}: ${error}`, 'error');

    const tree = this.projectTrees.get(projectId);
    if (tree) {
      tree.loading = false;
      this.renderFileTree(projectId);
    }
  }

  handleFileRenamed(projectId, oldPath, newPath) {
    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
    this.refreshDirectory(projectId, parentPath);
  }

  handleFileMoved(projectId, oldPath, newPath) {
    const oldParent = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
    const newParent = newPath.substring(0, newPath.lastIndexOf('/')) || '/';

    this.refreshDirectory(projectId, oldParent);
    if (oldParent !== newParent) {
      this.refreshDirectory(projectId, newParent);
    }
  }

  handleFileDeleted(projectId, path) {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    this.refreshDirectory(projectId, parentPath);
  }

  handleDirectoryCreated(projectId, path, name) {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    this.refreshDirectory(projectId, parentPath);
  }

  refreshDirectory(projectId, path) {
    const tree = this.projectTrees.get(projectId);
    if (!tree) return;

    if (path === '/' || path === '') {
      tree.entries = null;
    } else if (tree.subdirectories) {
      tree.subdirectories.delete(path);
    }

    this.loadDirectory(projectId, path);
  }

  renderFileTree(projectId) {
    const container = document.querySelector(`[data-project-id="${projectId}"] .file-tree`);

    if (!container) return;

    const tree = this.projectTrees.get(projectId);

    if (!tree) {
      container.style.display = 'none';
      return;
    }

    container.style.display = tree.expanded ? 'block' : 'none';

    if (tree.loading && !tree.entries) {
      container.innerHTML = '<div class="file-tree-loading">Loading...</div>';
      return;
    }

    if (!container.dataset.dropInitialized) {
      container.dataset.dropInitialized = 'true';

      container.addEventListener('dragover', (e) => {
        if (e.target !== container) return;
        if (!this.dragState && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          container.classList.add('drop-target');
        }
      });

      container.addEventListener('dragleave', (e) => {
        if (e.target !== container) return;
        container.classList.remove('drop-target');
      });

      container.addEventListener('drop', (e) => {
        if (e.target !== container) return;
        e.preventDefault();
        container.classList.remove('drop-target');
        if (!this.dragState && e.dataTransfer.files.length > 0) {
          this.handleExternalDrop(projectId, '/', e.dataTransfer.files);
        }
      });
    }

    if (!tree.entries || tree.entries.length === 0) {
      container.innerHTML = '<div class="file-tree-empty">Empty directory</div>';
      return;
    }

    container.innerHTML = '';
    this.renderDirectoryContents(container, projectId, '/', tree.entries, 0);
  }

  renderDirectoryContents(container, projectId, dirPath, entries, depth) {
    const tree = this.projectTrees.get(projectId);

    for (const entry of entries) {
      const entryPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
      const item = document.createElement('div');
      item.className = 'file-tree-item';
      item.style.paddingLeft = `${depth * 12 + 8}px`;
      item.dataset.path = entryPath;
      item.dataset.projectId = projectId;
      item.dataset.type = entry.type;
      // draggable rows hijack touch-scroll on mobile; HTML5 DnD is inert on touch anyway
      item.draggable = !IS_TOUCH;

      if (entry.type === 'directory') {
        const isExpanded = tree.expandedPaths.has(entryPath);
        const toggle = document.createElement('span');
        toggle.className = 'file-tree-toggle';
        toggle.textContent = isExpanded ? '▼' : '▶';

        const icon = document.createElement('span');
        icon.className = 'file-tree-icon';
        icon.textContent = '📁';

        const name = document.createElement('span');
        name.className = 'file-tree-name';
        name.textContent = entry.name;

        item.appendChild(toggle);
        item.appendChild(icon);
        item.appendChild(name);
        item.classList.add('folder');

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleDirectory(projectId, entryPath);
        });

        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.dragState && this.dragState.path !== entryPath) {
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('drop-target');
          } else if (!this.dragState && e.dataTransfer.types.includes('Files')) {
            e.dataTransfer.dropEffect = 'copy';
            item.classList.add('drop-target');
          }
        });

        item.addEventListener('dragleave', (e) => {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('drop-target');
        });

        item.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('drop-target');
          if (this.dragState && this.dragState.projectId === projectId) {
            this.handleDrop(projectId, this.dragState.path, entryPath);
            this.dragState = null;
          } else if (!this.dragState && e.dataTransfer.files.length > 0) {
            this.handleExternalDrop(projectId, entryPath, e.dataTransfer.files);
          }
        });

        container.appendChild(item);

        if (isExpanded && tree.subdirectories?.has(entryPath)) {
          const subEntries = tree.subdirectories.get(entryPath);
          this.renderDirectoryContents(container, projectId, entryPath, subEntries, depth + 1);
        }
      } else {
        const icon = document.createElement('span');
        icon.className = 'file-tree-icon';
        icon.textContent = this.getFileIcon(entry.name);

        const name = document.createElement('span');
        name.className = 'file-tree-name';
        name.textContent = entry.name;

        item.appendChild(icon);
        item.appendChild(name);
        item.classList.add('file');

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openFile(projectId, entryPath, entry.name);
        });

        container.appendChild(item);
      }

      item.addEventListener('dragstart', (e) => {
        this.dragState = { projectId, path: entryPath, type: entry.type };
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', entryPath);
      });

      item.addEventListener('dragend', (e) => {
        item.classList.remove('dragging');
        this.dragState = null;
        container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      });

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showContextMenu(e.clientX, e.clientY, projectId, entryPath, entry.type);
      });
    }
  }

  handleDrop(projectId, sourcePath, destDirectory) {
    const sourceParent = sourcePath.substring(0, sourcePath.lastIndexOf('/')) || '/';
    if (sourceParent === destDirectory) return;

    if (destDirectory.startsWith(sourcePath + '/')) return;

    this.app.ws.send(JSON.stringify({
      type: 'move_file',
      projectId,
      sourcePath,
      destDirectory
    }));
  }

  async handleExternalDrop(projectId, destDirectory, fileList) {
    const maxSize = 10 * 1024 * 1024;

    for (const file of fileList) {
      if (file.size > maxSize) {
        this.app.messageRenderer.appendSystemMessage(
          `Skipped "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit)`,
          'error'
        );
        continue;
      }

      try {
        const { data, encoding } = await this.readFileForUpload(file);
        this.app.ws.send(JSON.stringify({
          type: 'upload_file',
          projectId,
          destDirectory,
          fileName: file.name,
          content: data,
          encoding
        }));
      } catch (err) {
        this.app.messageRenderer.appendSystemMessage(`Failed to read "${file.name}": ${err.message}`, 'error');
      }
    }
  }

  readFileForUpload(file) {
    const textTypes = [
      'text/', 'application/json', 'application/xml', 'application/javascript',
      'application/typescript', 'application/x-yaml', 'application/x-sh'
    ];
    const textExtensions = new Set([
      'txt', 'md', 'json', 'yaml', 'yml', 'js', 'ts', 'jsx', 'tsx',
      'css', 'scss', 'html', 'xml', 'svg', 'py', 'rb', 'go', 'rs',
      'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'sql', 'toml',
      'ini', 'conf', 'config', 'log', 'csv', 'env', 'gitignore', 'lock'
    ]);

    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    const isText = textTypes.some(t => file.type.startsWith(t)) || textExtensions.has(ext);

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('FileReader error'));

      if (isText) {
        reader.onload = (e) => resolve({ data: e.target.result, encoding: 'utf8' });
        reader.readAsText(file);
      } else {
        reader.onload = (e) => {
          const base64 = e.target.result.split(',')[1];
          resolve({ data: base64, encoding: 'base64' });
        };
        reader.readAsDataURL(file);
      }
    });
  }

  handleFileUploaded(projectId, destDirectory, fileName) {
    this.refreshDirectory(projectId, destDirectory);
  }

  toggleDirectory(projectId, path) {
    const tree = this.projectTrees.get(projectId);
    if (!tree) return;

    const isExpanded = tree.expandedPaths.has(path);

    if (isExpanded) {
      tree.expandedPaths.delete(path);
      this.renderFileTree(projectId);
    } else {
      tree.expandedPaths.add(path);

      if (!tree.subdirectories?.has(path)) {
        this.loadDirectory(projectId, path);
      } else {
        this.renderFileTree(projectId);
      }
    }
  }

  openFile(projectId, path, filename) {
    this.app.ws.send(JSON.stringify({
      type: 'read_file',
      projectId,
      path
    }));
  }

  getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
      'js': '📜',
      'ts': '📘',
      'jsx': '⚛️',
      'tsx': '⚛️',
      'json': '📋',
      'md': '📝',
      'html': '🌐',
      'css': '🎨',
      'py': '🐍',
      'rb': '💎',
      'go': '🐹',
      'rs': '🦀',
      'java': '☕',
      'c': '©️',
      'cpp': '©️',
      'h': '©️',
      'sh': '🐚',
      'yml': '⚙️',
      'yaml': '⚙️',
      'toml': '⚙️',
      'txt': '📄'
    };
    return icons[ext] || '📄';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileBrowser;
}
