/**
 * SearchService - spawns ripgrep against a project directory and streams
 * structured match results.
 *
 * Security: query and globs are passed via spawn() argv (never a shell string).
 * A `--` separator precedes the query so a leading `-` can't be parsed as a flag.
 * The caller is responsible for passing a project path that has already gone
 * through FileService.validatePath().
 */
const { spawn } = require('child_process');
const { rgPath } = require('@vscode/ripgrep');

const MAX_MATCHES = 500;          // hard cap on results returned per search
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB stdout cap
const TIMEOUT_MS = 5000;          // hard timeout per search
const MAX_GLOBS = 5;
const MAX_GLOB_LEN = 200;
const MAX_QUERY_LEN = 1000;

class SearchService {
  constructor() {
    this._inflight = new Map(); // requestId -> child process
  }

  /**
   * Run a search. Resolves with { matches, truncated, durationMs }.
   * Each match: { file, lineNumber, lineText, submatches: [{start, end}] }
   *
   * Options:
   *   regex    — if true, query is a regex; otherwise --fixed-strings
   *   word     — if true, --word-regexp
   *   globs    — array of strings forwarded as --glob (validated)
   *   requestId — opaque id used by cancel()
   */
  run(projectPath, query, options = {}) {
    if (typeof query !== 'string' || !query.length) {
      return Promise.reject(new Error('Search query is empty'));
    }
    if (query.length > MAX_QUERY_LEN) {
      return Promise.reject(new Error(`Query too long (max ${MAX_QUERY_LEN} chars)`));
    }

    const args = ['--json', '--smart-case', '--max-count', '50', '--max-filesize', '5M'];
    if (!options.regex) args.push('--fixed-strings');
    if (options.word) args.push('--word-regexp');

    let globs;
    try {
      globs = this._validateGlobs(options.globs);
    } catch (err) {
      return Promise.reject(err);
    }
    for (const g of globs) {
      args.push('--glob', g);
    }

    // Belt-and-suspenders: ripgrep already obeys --max-count per file, but the
    // global cap is enforced by us when streaming output.
    args.push('--', query);

    const start = Date.now();
    return new Promise((resolve, reject) => {
      const proc = spawn(rgPath, args, {
        cwd: projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const matches = [];
      let truncated = false;
      let bytesRead = 0;
      let stdoutBuf = '';
      let stderrBuf = '';
      let killed = false;

      const kill = (reason) => {
        if (killed) return;
        killed = true;
        truncated = truncated || reason === 'cap' || reason === 'timeout';
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      };

      // Expose the internal kill() to cancel() so user cancellation flips the
      // killed flag and the close handler treats it as truncation, not error.
      if (options.requestId) {
        this._inflight.set(options.requestId, { proc, kill });
      }

      const timer = setTimeout(() => kill('timeout'), TIMEOUT_MS);

      proc.stdout.on('data', (chunk) => {
        // SIGTERM is async, so data events can keep arriving after kill.
        if (killed) return;
        // Check the cap before decoding/appending so a single huge chunk
        // can't spike memory before we tear down.
        if (bytesRead + chunk.length > MAX_OUTPUT_BYTES) {
          kill('cap');
          return;
        }
        bytesRead += chunk.length;
        stdoutBuf += chunk.toString('utf8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;

          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type !== 'match') continue;

          const match = this._normalizeMatch(evt.data);
          if (!match) continue;

          matches.push(match);
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            kill('cap');
            return;
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        // Buffer stderr but never grow unbounded
        if (stderrBuf.length < 8192) {
          stderrBuf += chunk.toString('utf8');
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (options.requestId) this._inflight.delete(options.requestId);
        reject(new Error(`Failed to launch ripgrep: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (options.requestId) this._inflight.delete(options.requestId);

        // Exit codes: 0 = matches found, 1 = no matches (not an error),
        // 2 = error. Treat SIGTERM-from-us as success-with-truncation.
        if (killed) {
          return resolve({ matches, truncated: true, durationMs: Date.now() - start });
        }
        if (code === 0 || code === 1) {
          return resolve({ matches, truncated, durationMs: Date.now() - start });
        }
        const err = stderrBuf.trim() || `ripgrep exited with code ${code}`;
        reject(new Error(err.split('\n')[0]));
      });
    });
  }

  /**
   * Cancel an in-flight search by requestId. No-op if not running.
   */
  cancel(requestId) {
    const entry = this._inflight.get(requestId);
    if (!entry) return false;
    this._inflight.delete(requestId);
    entry.kill('cancel');
    return true;
  }

  _normalizeMatch(data) {
    if (!data || !data.path || !data.lines || typeof data.line_number !== 'number') return null;
    const file = data.path.text || '';
    // ripgrep returns the matched line including trailing newline — trim it.
    const lineText = (data.lines.text || '').replace(/\r?\n$/, '');
    const submatches = Array.isArray(data.submatches)
      ? data.submatches.map(s => ({ start: s.start, end: s.end }))
      : [];
    return { file, lineNumber: data.line_number, lineText, submatches };
  }

  _validateGlobs(globs) {
    if (!Array.isArray(globs)) return [];
    const out = [];
    for (const g of globs) {
      if (typeof g !== 'string') continue;
      const trimmed = g.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_GLOB_LEN) {
        throw new Error(`Glob too long (max ${MAX_GLOB_LEN} chars)`);
      }
      // Reject absolute paths and parent-dir escapes. ripgrep would handle
      // these by interpreting them relative to cwd, but rejecting at the
      // boundary keeps the contract explicit.
      if (trimmed.startsWith('/') || trimmed.includes('..')) {
        throw new Error(`Invalid glob: ${trimmed}`);
      }
      out.push(trimmed);
      if (out.length >= MAX_GLOBS) {
        throw new Error(`Too many globs (max ${MAX_GLOBS})`);
      }
    }
    return out;
  }
}

module.exports = SearchService;
