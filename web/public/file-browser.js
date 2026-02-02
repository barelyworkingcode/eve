class FileBrowser {
  constructor(client) {
    this.client = client;
    this.projectTrees = new Map(); // projectId -> { expanded, entries, loading, expandedPaths }
  }

  /**
   * Toggles file tree visibility for a project
   */
  toggleFileTree(projectId) {
    console.log('toggleFileTree called for project:', projectId);
    const tree = this.projectTrees.get(projectId);

    if (!tree) {
      // Initialize tree state
      this.projectTrees.set(projectId, {
        expanded: true,
        entries: null,
        loading: false,
        expandedPaths: new Set() // Track which subdirectories are expanded
      });

      console.log('Loading root directory for project:', projectId);
      // Load root directory
      this.loadDirectory(projectId, '/');
    } else {
      // Toggle visibility
      tree.expanded = !tree.expanded;
      console.log('Toggling tree visibility to:', tree.expanded);
      this.renderFileTree(projectId);
    }
  }

  /**
   * Loads directory contents from server
   */
  loadDirectory(projectId, path) {
    const tree = this.projectTrees.get(projectId);
    if (!tree) return;

    tree.loading = true;
    this.renderFileTree(projectId);

    this.client.ws.send(JSON.stringify({
      type: 'list_directory',
      projectId,
      path
    }));
  }

  /**
   * Handles directory listing response from server
   */
  handleDirectoryListing(projectId, path, entries) {
    console.log('handleDirectoryListing:', projectId, path, entries);
    const tree = this.projectTrees.get(projectId);
    if (!tree) {
      console.warn('No tree state found for project:', projectId);
      return;
    }

    tree.loading = false;

    if (path === '/' || path === '') {
      // Root directory
      tree.entries = entries;
      console.log('Set root entries:', entries.length, 'items');
    } else {
      // Subdirectory - need to store in nested structure
      if (!tree.subdirectories) {
        tree.subdirectories = new Map();
      }
      tree.subdirectories.set(path, entries);
      console.log('Set subdirectory entries for', path, ':', entries.length, 'items');
    }

    this.renderFileTree(projectId);
  }

  /**
   * Handles file error from server
   */
  handleFileError(projectId, path, error) {
    console.error(`File error for ${projectId}:${path}:`, error);

    // Show error to user
    const project = this.client.projects.get(projectId);
    const projectName = project?.name || 'Unknown project';
    this.client.appendSystemMessage(`File error in ${projectName}: ${error}`, 'error');

    const tree = this.projectTrees.get(projectId);
    if (tree) {
      tree.loading = false;
      this.renderFileTree(projectId);
    }
  }

  /**
   * Renders the file tree for a project
   */
  renderFileTree(projectId) {
    console.log('renderFileTree called for project:', projectId);
    const container = document.querySelector(`[data-project-id="${projectId}"] .file-tree`);
    console.log('File tree container:', container);

    if (!container) {
      console.warn(`File tree container not found for project ${projectId}`);
      return;
    }

    const tree = this.projectTrees.get(projectId);
    console.log('Tree state:', tree);

    if (!tree) {
      container.style.display = 'none';
      return;
    }

    container.style.display = tree.expanded ? 'block' : 'none';

    if (tree.loading && !tree.entries) {
      container.innerHTML = '<div class="file-tree-loading">Loading...</div>';
      return;
    }

    if (!tree.entries || tree.entries.length === 0) {
      container.innerHTML = '<div class="file-tree-empty">Empty directory</div>';
      return;
    }

    container.innerHTML = '';
    this.renderDirectoryContents(container, projectId, '/', tree.entries, 0);
  }

  /**
   * Recursively renders directory contents
   */
  renderDirectoryContents(container, projectId, dirPath, entries, depth) {
    const tree = this.projectTrees.get(projectId);

    for (const entry of entries) {
      const entryPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
      const item = document.createElement('div');
      item.className = 'file-tree-item';
      item.style.paddingLeft = `${depth * 12 + 8}px`;

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

        container.appendChild(item);

        // Render subdirectory contents if expanded
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
    }
  }

  /**
   * Toggles a directory expanded/collapsed
   */
  toggleDirectory(projectId, path) {
    const tree = this.projectTrees.get(projectId);
    if (!tree) return;

    const isExpanded = tree.expandedPaths.has(path);

    if (isExpanded) {
      tree.expandedPaths.delete(path);
      this.renderFileTree(projectId);
    } else {
      tree.expandedPaths.add(path);

      // Load directory contents if not already loaded
      if (!tree.subdirectories?.has(path)) {
        this.loadDirectory(projectId, path);
      } else {
        this.renderFileTree(projectId);
      }
    }
  }

  /**
   * Opens a file in the editor
   */
  openFile(projectId, path, filename) {
    // Request file content from server
    this.client.ws.send(JSON.stringify({
      type: 'read_file',
      projectId,
      path
    }));

    // Tab will be created when file content is received
  }

  /**
   * Returns an icon for a file based on extension
   */
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

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileBrowser;
}
