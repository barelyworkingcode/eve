const fs = require('fs');
const os = require('os');
const path = require('path');

async function handleReadPlanFile(ws, filePath) {
  try {
    if (!filePath || typeof filePath !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid plan file path' }));
      return;
    }

    const resolved = path.resolve(filePath);
    const plansDir = path.resolve(os.homedir(), '.claude', 'plans');

    if (!resolved.startsWith(plansDir + path.sep) || !resolved.endsWith('.md')) {
      ws.send(JSON.stringify({ type: 'error', message: 'Plan file path not allowed' }));
      return;
    }

    // Defeat a symlink inside plansDir pointing outside it: re-check the
    // realpath. ENOENT falls through to the readFile error below.
    try {
      const real = await fs.promises.realpath(resolved);
      if (!real.startsWith(plansDir + path.sep)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Plan file path not allowed' }));
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    const content = await fs.promises.readFile(resolved, 'utf8');
    ws.send(JSON.stringify({ type: 'plan_file_content', path: filePath, content }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: `Failed to read plan file: ${err.message}` }));
  }
}

module.exports = [
  {
    type: 'list_directory',
    handle(ctx) {
      // Listing a directory expresses interest in the project's tree;
      // start its recursive watcher so external structural changes
      // (new/removed files & folders) are surfaced live.
      ctx.fileWatcher.watchProject(ctx.message.projectId);
      ctx.deps.fileHandlers.listDirectory(ctx.ws, ctx.message);
    },
  },

  {
    type: 'read_file',
    handle(ctx) {
      ctx.deps.fileHandlers.readFile(ctx.ws, ctx.message);
    },
  },

  {
    type: 'write_file',
    handle(ctx) {
      const project = ctx.deps.resolveProject(ctx.message.projectId);
      if (project) {
        try {
          const fs = ctx.deps.fileHandlers.fileServiceFor(project);
          const absPath = fs.validatePath(project.path, ctx.message.path);
          ctx.fileWatcher.markSelfWrite(absPath);
        } catch { /* path validation failed, writeFile will handle the error */ }
      }
      ctx.deps.fileHandlers.writeFile(ctx.ws, ctx.message);
    },
  },

  {
    type: 'rename_file',
    handle(ctx) {
      ctx.deps.fileHandlers.renameFile(ctx.ws, ctx.message);
    },
  },

  {
    type: 'move_file',
    handle(ctx) {
      ctx.deps.fileHandlers.moveFile(ctx.ws, ctx.message);
    },
  },

  {
    type: 'delete_file',
    handle(ctx) {
      ctx.deps.fileHandlers.deleteFile(ctx.ws, ctx.message);
    },
  },

  {
    type: 'upload_file',
    handle(ctx) {
      ctx.deps.fileHandlers.uploadFile(ctx.ws, ctx.message);
    },
  },

  {
    type: 'create_directory',
    handle(ctx) {
      ctx.deps.fileHandlers.createDirectory(ctx.ws, ctx.message);
    },
  },

  {
    type: 'watch_file',
    handle(ctx) {
      ctx.fileWatcher.watch(ctx.message.projectId, ctx.message.path, { binary: !!ctx.message.binary });
    },
  },

  {
    type: 'unwatch_file',
    handle(ctx) {
      ctx.fileWatcher.unwatch(ctx.message.projectId, ctx.message.path);
    },
  },

  {
    type: 'read_plan_file',
    handle(ctx) {
      handleReadPlanFile(ctx.ws, ctx.message.path);
    },
  },
];
