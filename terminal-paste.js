'use strict';

/**
 * Saves an image pasted into a terminal pane to a temp file on the machine
 * the terminal runs on, so the pane can type that path into the PTY. xterm
 * only carries text, and a CLI on an SSH host (Claude Code) reads the host's
 * clipboard, never the browser's — a file path is the one thing that crosses.
 *
 * Console terminals get eve's own os.tmpdir(), not /tmp: relay's sandbox
 * grants the session TMPDIR read-write but denies reads under /tmp. Host
 * terminals get /tmp on the host, written by remote-fs-agent.js's `pastetmp`.
 */

const crypto = require('crypto');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const MAX_PASTE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

class PasteError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Unique per paste: both write paths open with O_EXCL, so a collision (or a
// pre-planted symlink in a shared /tmp) fails rather than being followed.
function pasteFileName(mimeType, now = Date.now()) {
  const ext = IMAGE_EXTENSIONS[mimeType];
  if (!ext) throw new PasteError(`Unsupported image type: ${mimeType || 'none'}`, 415);
  return `eve-paste-${now}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
}

async function saveTerminalPaste({ buffer, mimeType, hostId }, { hostPool, localDir = os.tmpdir() } = {}) {
  const name = pasteFileName(mimeType);
  if (!buffer || buffer.length === 0) throw new PasteError('Empty image', 400);
  if (buffer.length > MAX_PASTE_BYTES) throw new PasteError('Image exceeds 10MB limit', 413);

  if (!hostId) {
    const full = path.join(localDir, name);
    await fsp.writeFile(full, buffer, { flag: 'wx', mode: 0o600 });
    return full;
  }

  const agent = hostPool ? hostPool.get(hostId) : null;
  if (!agent) throw new PasteError(`Unknown host: ${hostId}`, 404);
  try {
    const res = await agent.request('pastetmp', { name, data: buffer.toString('base64') });
    return res.path;
  } catch (err) {
    throw new PasteError(`Host write failed: ${err.message}`, 502);
  }
}

module.exports = { saveTerminalPaste, pasteFileName, PasteError, MAX_PASTE_BYTES, IMAGE_EXTENSIONS };
