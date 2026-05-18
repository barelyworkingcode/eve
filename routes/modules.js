/**
 * Module routes — list and serve static files for static-HTML modules
 * living under <project>/modules/<name>/.
 *
 * AI invocation does NOT live here anymore — it's driven over the WebSocket
 * by ModuleInvoker (see module-invoker.js) so the orb can stream tool-use
 * and thinking events while the model is working. The hidden-session
 * `__module:` prefix is still the load-bearing filter for /api/sessions.
 */
const path = require('path');

const { ModuleError } = require('../module-service');

const SERVE_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

function register(app, { requireAuth, moduleService, resolveProject, log }) {
  const routeLog = log?.child ? log.child('ModuleRoutes') : { error: () => {}, info: () => {}, debug: () => {} };

  // --- List modules ---
  app.get('/api/modules', requireAuth, async (req, res) => {
    const projectId = req.query.projectId;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = resolveProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try {
      const modules = await moduleService.listModules(project.path);
      res.json({ modules });
    } catch (err) {
      routeLog.error(`GET /api/modules failed for ${projectId}:`, err.message);
      res.status(500).json({ error: 'Failed to list modules' });
    }
  });

  // --- Get a single module's manifest (for ModuleHost validation) ---
  app.get('/api/modules/:projectId/:moduleName', requireAuth, async (req, res) => {
    const { projectId, moduleName } = req.params;
    const project = resolveProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    try {
      const manifest = await moduleService.getModule(project.path, moduleName);
      res.json(moduleService.publicView(manifest));
    } catch (err) {
      const status = err instanceof ModuleError && err.code === 'MISSING_MANIFEST' ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // --- Static module file serving (loaded into iframe) ---
  app.get('/api/modules/serve/:projectId/:moduleName/*', requireAuth, async (req, res) => {
    const { projectId, moduleName } = req.params;
    const project = resolveProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      // Only parse the manifest when we need its default entry (root request).
      // Asset requests under the module (`/index.html`, `/style.css`, images)
      // skip the JSON parse + schema check — path traversal/symlink defense
      // lives in resolveModuleFile and doesn't depend on the manifest.
      let relPath = req.params[0];
      if (!relPath) {
        const manifest = await moduleService.getModule(project.path, moduleName);
        relPath = manifest.entry || 'index.html';
      }
      const resolved = await moduleService.resolveModuleFile(project.path, moduleName, relPath);

      const ext = path.extname(resolved).toLowerCase();
      const mime = SERVE_MIME[ext];
      if (!mime) {
        return res.status(415).json({ error: `Disallowed file type: ${ext || '(none)'}` });
      }

      res.set('Content-Type', mime);
      res.set('Cache-Control', 'no-store');
      // Prevent the iframe page from framing other origins or being framed
      // outside Eve. Module content is AI-authored — treat it as untrusted.
      res.set('X-Content-Type-Options', 'nosniff');

      res.sendFile(resolved, { dotfiles: 'deny' }, (err) => {
        if (err && !res.headersSent) {
          const status = err.code === 'ENOENT' ? 404 : 500;
          res.status(status).json({ error: 'File not found' });
        }
      });
    } catch (err) {
      const status = err instanceof ModuleError
        ? (err.code === 'MISSING_MANIFEST' || err.code === 'ENOENT' ? 404
            : err.code === 'PATH_TRAVERSAL' || err.code === 'SYMLINK_ESCAPE' ? 403
            : 400)
        : 500;
      res.status(status).json({ error: err.message });
    }
  });

}

module.exports = { register };
// HIDDEN_SESSION_PREFIX moved to module-invoker.js — it's the load-bearing
// marker for the sessions-list filter in routes/index.js. Update both files
// in lockstep if you ever rename it.
