/**
 * FileWatcher - per-connection file watcher for detecting external changes.
 * One instance per WebSocket connection, same lifecycle as RelayClient.
 */
const fs = require('fs');
const path = require('path');

class FileWatcher {
  constructor(ws, fileService, resolveProject) {
    this.ws = ws;
    this.fileService = fileService;
    this.resolveProject = resolveProject;
    this.watchers = new Map();       // key -> FSWatcher
    this.debounceTimers = new Map(); // key -> timeout
    this.selfWrites = new Set();     // absolute paths written by Eve
  }

  watch(projectId, relativePath) {
    const key = `${projectId}:${relativePath}`;
    if (this.watchers.has(key)) return;

    const project = this.resolveProject(projectId);
    if (!project) return;

    let absolutePath;
    try {
      absolutePath = this.fileService.validatePath(project.path, relativePath);
    } catch {
      return;
    }

    try {
      const watcher = fs.watch(absolutePath, (eventType) => {
        if (eventType === 'change') {
          this._onFileChange(key, projectId, relativePath, absolutePath);
        }
      });

      watcher.on('error', () => {
        this._unwatchKey(key);
      });

      this.watchers.set(key, watcher);
    } catch {
      // File may not exist or be inaccessible
    }
  }

  unwatch(projectId, relativePath) {
    const key = `${projectId}:${relativePath}`;
    this._unwatchKey(key);
  }

  markSelfWrite(absolutePath) {
    this.selfWrites.add(absolutePath);
    setTimeout(() => this.selfWrites.delete(absolutePath), 500);
  }

  _onFileChange(key, projectId, relativePath, absolutePath) {
    if (this.selfWrites.has(absolutePath)) return;

    // Debounce: coalesce rapid fs.watch events
    clearTimeout(this.debounceTimers.get(key));
    this.debounceTimers.set(key, setTimeout(async () => {
      this.debounceTimers.delete(key);
      try {
        const project = this.resolveProject(projectId);
        if (!project) return;
        const { content, size } = await this.fileService.readFile(project.path, relativePath);
        this.ws.send(JSON.stringify({
          type: 'file_changed',
          projectId,
          path: relativePath,
          content,
          size
        }));
      } catch {
        // File may have been deleted or become unreadable
      }
    }, 300));
  }

  _unwatchKey(key) {
    const watcher = this.watchers.get(key);
    if (watcher) {
      watcher.close();
      this.watchers.delete(key);
    }
    const timer = this.debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
  }

  closeAll() {
    for (const [key] of this.watchers) {
      this._unwatchKey(key);
    }
    this.selfWrites.clear();
  }
}

module.exports = FileWatcher;
