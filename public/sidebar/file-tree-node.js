/**
 * FileTreeNode - renders a file/folder tree for a project.
 * Handles lazy-load directories, expand/collapse, drag-drop, context menu.
 */
class FileTreeNode {
  constructor(container) {
    this.bus = container.get('bus');
    this.ws = container.get('ws');
    this.log = container.get('logger').child('FileTree');
    this.state = container.get('state');

    // projectId -> { path -> entries[] }
    this.dirCache = new Map();
    // projectId -> Set of expanded paths
    this.expandedPaths = new Map();
    // Drag state
    this.dragState = null;
  }

  init() {
    this.bus.on(EVT.DIRECTORY_LISTING, (data) => this._onDirectoryListing(data));
    this.bus.on(EVT.FILE_RENAMED, (data) => this._refreshParent(data.projectId, data.oldPath));
    this.bus.on(EVT.FILE_MOVED, (data) => this._refreshParent(data.projectId, data.oldPath));
    this.bus.on(EVT.FILE_DELETED, (data) => this._refreshParent(data.projectId, data.path));
    this.bus.on(EVT.FILE_UPLOADED, (data) => this._refreshDir(data.projectId, data.destDirectory));
    this.bus.on(EVT.DIRECTORY_CREATED, (data) => this._refreshDir(data.projectId, data.path));

    // Close context menu on any click (handled by shared closeContextMenu)
  }

  /**
   * Render the file tree for a project into the given container element.
   */
  renderTree(projectId, containerEl) {
    containerEl.innerHTML = '';
    const entries = this._getCachedDir(projectId, '/');
    if (!entries) {
      this._loadDirectory(projectId, '/');
      const loading = document.createElement('div');
      loading.className = 'file-tree__loading';
      loading.textContent = 'Loading...';
      containerEl.appendChild(loading);
      // Store the container ref so we can re-render when data arrives
      containerEl.dataset.projectId = projectId;
      return;
    }
    this._renderEntries(projectId, '/', entries, containerEl, 0);
  }

  _renderEntries(projectId, parentPath, entries, containerEl, depth) {
    // Sort: folders first, then alphabetical
    const sorted = [...entries].sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const entry of sorted) {
      const entryPath = parentPath === '/' ? `/${entry.name}` : `${parentPath}/${entry.name}`;
      const isDir = entry.type === 'directory';
      const isExpanded = this._isExpanded(projectId, entryPath);

      const item = document.createElement('div');
      item.className = `file-tree__item${isDir ? ' file-tree__item--folder' : ''}${isExpanded ? ' file-tree__item--expanded' : ''}`;
      item.style.paddingLeft = `${12 + depth * 16}px`;
      item.draggable = true;
      item.dataset.testid = `file-tree-item-${entryPath}`;

      // Chevron (folders only)
      if (isDir) {
        const chevron = document.createElement('span');
        chevron.className = 'file-tree__chevron';
        chevron.textContent = isExpanded ? '\u25BC' : '\u25B6';
        item.appendChild(chevron);
      } else {
        // Spacer for alignment
        const spacer = document.createElement('span');
        spacer.className = 'file-tree__chevron-spacer';
        item.appendChild(spacer);
      }

      // Icon
      const icon = document.createElement('span');
      icon.className = 'file-tree__icon';
      if (isDir) {
        icon.appendChild(getFolderIconSVG(isExpanded));
      } else {
        icon.appendChild(getFileIconSVG(entry.name));
      }
      item.appendChild(icon);

      // Name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-tree__name';
      nameSpan.textContent = entry.name;
      item.appendChild(nameSpan);

      // Click handler
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isDir) {
          this._toggleExpand(projectId, entryPath, containerEl);
        } else {
          this.bus.emit(EVT.FILE_CONTENT, { projectId, path: entryPath, filename: entry.name, requestLoad: true });
        }
      });

      // Drag handlers
      item.addEventListener('dragstart', (e) => {
        this.dragState = { projectId, path: entryPath };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', entryPath);
        item.classList.add('file-tree__item--dragging');
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('file-tree__item--dragging');
        this.dragState = null;
        containerEl.querySelectorAll('.file-tree__item--drop-target').forEach(el =>
          el.classList.remove('file-tree__item--drop-target')
        );
      });

      if (isDir) {
        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          item.classList.add('file-tree__item--drop-target');
        });

        item.addEventListener('dragleave', () => {
          item.classList.remove('file-tree__item--drop-target');
        });

        item.addEventListener('drop', (e) => {
          e.preventDefault();
          item.classList.remove('file-tree__item--drop-target');

          if (e.dataTransfer.files.length > 0) {
            this._handleExternalDrop(projectId, entryPath, e.dataTransfer.files);
          } else if (this.dragState) {
            this._handleInternalDrop(projectId, this.dragState.path, entryPath);
          }
        });
      }

      // Context menu
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._showContextMenu(e.clientX, e.clientY, projectId, entryPath, isDir);
      });

      containerEl.appendChild(item);

      // Render children if expanded
      if (isDir && isExpanded) {
        const children = this._getCachedDir(projectId, entryPath);
        if (children) {
          this._renderEntries(projectId, entryPath, children, containerEl, depth + 1);
        } else {
          this._loadDirectory(projectId, entryPath);
        }
      }
    }
  }

  // --- Directory loading ---

  _loadDirectory(projectId, path) {
    this.ws.send({ type: 'list_directory', projectId, path });
  }

  _onDirectoryListing(data) {
    const { projectId, path, entries } = data;
    if (!this.dirCache.has(projectId)) {
      this.dirCache.set(projectId, new Map());
    }
    this.dirCache.get(projectId).set(path, entries);

    // Re-render the tree container for this project
    const containerEl = document.querySelector(`.file-tree[data-project-id="${projectId}"]`);
    if (containerEl) {
      this.renderTree(projectId, containerEl);
    }
  }

  _getCachedDir(projectId, path) {
    return this.dirCache.get(projectId)?.get(path);
  }

  // --- Expand/collapse ---

  _isExpanded(projectId, path) {
    return this.expandedPaths.get(projectId)?.has(path) || false;
  }

  _toggleExpand(projectId, path, containerEl) {
    if (!this.expandedPaths.has(projectId)) {
      this.expandedPaths.set(projectId, new Set());
    }
    const expanded = this.expandedPaths.get(projectId);
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    this._saveExpandState();
    this.renderTree(projectId, containerEl);
  }

  _saveExpandState() {
    const state = {};
    for (const [pid, paths] of this.expandedPaths) {
      state[pid] = Array.from(paths);
    }
    localStorage.setItem('eve-tree-expand', JSON.stringify(state));
  }

  restoreExpandState() {
    try {
      const raw = localStorage.getItem('eve-tree-expand');
      if (!raw) return;
      const state = JSON.parse(raw);
      for (const [pid, paths] of Object.entries(state)) {
        this.expandedPaths.set(pid, new Set(paths));
      }
    } catch { /* ignore corrupt state */ }
  }

  // --- Drag & drop ---

  _handleInternalDrop(projectId, sourcePath, destDirectory) {
    const sourceParent = sourcePath.substring(0, sourcePath.lastIndexOf('/')) || '/';
    if (sourceParent === destDirectory) return;
    if (destDirectory.startsWith(sourcePath + '/')) return;
    this.ws.send({ type: 'move_file', projectId, sourcePath, destDirectory });
  }

  _handleExternalDrop(projectId, destDirectory, fileList) {
    const maxSize = 10 * 1024 * 1024;
    for (const file of fileList) {
      if (file.size > maxSize) continue;
      const reader = new FileReader();
      reader.onerror = () => this.log.error(`Failed to read "${file.name}" for upload`);
      const isText = file.type.startsWith('text/') || /\.(txt|md|json|js|ts|css|html|py|go|rs|rb|sh|yaml|yml|toml|xml|sql|ini|conf|env|log)$/i.test(file.name);
      if (isText) {
        reader.onload = () => {
          this.ws.send({ type: 'upload_file', projectId, destDirectory, fileName: file.name, content: reader.result, encoding: 'utf8' });
        };
        reader.readAsText(file);
      } else {
        reader.onload = () => {
          this.ws.send({ type: 'upload_file', projectId, destDirectory, fileName: file.name, content: reader.result.split(',')[1], encoding: 'base64' });
        };
        reader.readAsDataURL(file);
      }
    }
  }

  // --- Context menu ---

  _showContextMenu(x, y, projectId, path, isDir) {
    const items = [
      { label: 'Rename', action: () => this._startRename(projectId, path) },
      { label: 'Delete', action: () => this._confirmDelete(projectId, path) },
    ];

    if (isDir) {
      items.unshift(
        { label: 'New File', action: () => this._promptNewItem(projectId, path, 'file') },
        { label: 'New Folder', action: () => this._promptNewItem(projectId, path, 'directory') },
        { separator: true },
      );
      items.push(
        { separator: true },
        { label: 'Refresh', action: () => this._refreshDir(projectId, path) },
      );
    }

    showContextMenu(x, y, items);
  }

  // --- File operations ---

  _startRename(projectId, path) {
    const filename = path.split('/').pop();
    const newName = prompt('Rename to:', filename);
    if (newName && newName !== filename) {
      this.ws.send({ type: 'rename_file', projectId, path, newName });
    }
  }

  _confirmDelete(projectId, path) {
    const filename = path.split('/').pop();
    this.bus.emit(EVT.DIALOG_CONFIRM, {
      message: `Delete "${filename}"? This will move it to trash.`,
      onConfirm: () => this.ws.send({ type: 'delete_file', projectId, path }),
    });
  }

  _promptNewItem(projectId, parentPath, type) {
    const label = type === 'directory' ? 'folder' : 'file';
    const name = prompt(`New ${label} name:`);
    if (!name) return;
    if (type === 'directory') {
      this.ws.send({ type: 'create_directory', projectId, path: parentPath, name });
    } else {
      const filePath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
      this.ws.send({ type: 'write_file', projectId, path: filePath, content: '' });
    }
  }

  _refreshDir(projectId, path) {
    const cache = this.dirCache.get(projectId);
    if (cache) cache.delete(path);
    this._loadDirectory(projectId, path);
  }

  _refreshParent(projectId, path) {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    this._refreshDir(projectId, parent);
  }
}
