/**
 * Module routes — list, serve static files, and broker AI invocations
 * for static-HTML modules living under <project>/modules/<name>/.
 *
 * The invoke endpoint creates an ephemeral relayLLM session, sends a
 * non-streamed prompt, awaits the full response, and deletes the session.
 * The session name is prefixed with "__module:" so the GET /api/sessions
 * proxy can filter it out — modules must not pollute the sidebar.
 */
const path = require('path');
const crypto = require('crypto');

const { ModuleError } = require('../module-service');

const HIDDEN_SESSION_PREFIX = '__module:';

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

function register(app, { requireAuth, moduleService, fileService, resolveProject, relayTransport, log }) {
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

  // --- Invoke AI on behalf of a module ---
  app.post('/api/modules/invoke', requireAuth, async (req, res) => {
    const { projectId, moduleName, prompt, files = [], schema, model } = req.body || {};
    if (!projectId || !moduleName || !prompt) {
      return res.status(400).json({ error: 'projectId, moduleName, and prompt are required' });
    }
    const project = resolveProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let manifest;
    try {
      manifest = await moduleService.getModule(project.path, moduleName);
    } catch (err) {
      return res.status(404).json({ error: err.message });
    }

    // Verify every requested file is in the module's permission list.
    const denied = [];
    for (const f of files) {
      if (!moduleService.isFilePermitted(manifest, f)) denied.push(f);
    }
    if (denied.length > 0) {
      return res.status(403).json({
        error: 'Permission denied for files',
        deniedFiles: denied,
      });
    }

    // Read file contents server-side so we can inline them in the system
    // prompt. Modules thus never need tool-use access for plain reads.
    let fileBlocks;
    try {
      const reads = await Promise.all(files.map(f =>
        fileService.readFile(project.path, f).then(({ content }) => ({ f, content }))
      ));
      fileBlocks = reads.map(({ f, content }) => `<file path="${f}">\n${content}\n</file>`);
    } catch (err) {
      return res.status(400).json({ error: `Failed to read context files: ${err.message}` });
    }

    const resolvedModel = model || manifest.model || (project.allowedModels || [])[0] || '';

    const systemPrompt = buildSystemPrompt({
      moduleName,
      displayName: manifest.displayName,
      files: fileBlocks,
      schema,
    });

    let sessionId = null;
    const t0 = Date.now();
    routeLog.info(`invoke ${moduleName} model=${resolvedModel || '(default)'} files=[${files.join(',')}] prompt=${JSON.stringify(prompt).slice(0, 120)}`);

    try {
      // 1. Create the ephemeral session. Hidden via name prefix.
      const sessionName = `${HIDDEN_SESSION_PREFIX}${moduleName}:${crypto.randomBytes(6).toString('hex')}`;
      const create = await relayTransport.fetch('POST', '/api/sessions', {
        projectId,
        directory: project.path,
        name: sessionName,
        model: resolvedModel,
        systemPrompt: '',
        appendClaudeMd: false,
        mcpToken: '',
        settings: null,
      });
      if (create.status < 200 || create.status >= 300) {
        return res.status(502).json({
          error: (create.data && create.data.error) || 'Failed to create session',
        });
      }
      sessionId = create.data.sessionId;

      // 2. Use relayLLM's built-in synchronous send endpoint — it blocks until
      // the response is complete and returns the accumulated text. Avoids
      // re-implementing the streaming event-collection logic on our side.
      const fullPrompt = systemPrompt
        ? `${systemPrompt}\n\n---\n\n${prompt}`
        : prompt;

      const send = await relayTransport.fetch(
        'POST', `/api/sessions/${sessionId}/message`,
        { text: fullPrompt, files: [] }
      );
      if (send.status < 200 || send.status >= 300) {
        return res.status(send.status === 504 ? 504 : 502).json({
          error: (send.data && send.data.error) || 'Module invocation failed',
        });
      }
      const reply = (send.data && send.data.response) || '';
      routeLog.info(`invoke ${moduleName} ← ${reply.length} chars in ${Date.now() - t0}ms (session ${sessionId.slice(0, 8)})`);

      // 3. Parse the reply — JSON if a schema was requested, raw otherwise.
      let result = reply;
      if (schema) {
        try {
          result = extractJson(reply);
        } catch (err) {
          return res.status(502).json({
            error: 'Model did not return parseable JSON',
            raw: reply,
          });
        }
      }

      res.json({ result, sessionId, model: resolvedModel });
    } catch (err) {
      routeLog.error(`POST /api/modules/invoke failed:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: err.message || 'Module invocation failed' });
      }
    } finally {
      if (sessionId) {
        relayTransport.fetch('DELETE', `/api/sessions/${sessionId}`).catch(err => {
          routeLog.error(`Failed to delete ephemeral session ${sessionId}:`, err.message);
        });
      }
    }
  });
}

/**
 * Build the system prompt sent to the ephemeral session. Inlines requested
 * files so the model never needs read tools. When a schema is requested,
 * instructs the model to return JSON only.
 */
function buildSystemPrompt({ moduleName, displayName, files, schema }) {
  const parts = [
    `You are the AI backend for the "${displayName}" module (id: ${moduleName}) running inside the Eve workspace.`,
    `Respond directly and concisely. Do not explain your reasoning unless asked.`,
  ];
  if (files.length > 0) {
    parts.push(`\nContext files (relative to the project root):\n${files.join('\n\n')}`);
  }
  if (schema) {
    parts.push(
      `\nYou MUST respond with a single JSON value matching this schema. Output ONLY the JSON, no prose, no markdown fences:\n` +
      JSON.stringify(schema, null, 2)
    );
  }
  return parts.join('\n');
}

/**
 * Pull a JSON value out of a model reply. The model is instructed to return
 * pure JSON, but sometimes wraps it in ```json fences — strip those first.
 */
function extractJson(text) {
  let s = String(text || '').trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenceMatch) s = fenceMatch[1].trim();
  return JSON.parse(s);
}

module.exports = { register, HIDDEN_SESSION_PREFIX };
