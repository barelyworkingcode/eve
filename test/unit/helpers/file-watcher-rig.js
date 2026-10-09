/**
 * A FileWatcher over a real RelayFileClient whose relay is replaced by an
 * in-memory tree. The client emits synchronously (`emitFs`), so a test drives
 * the debounce with jest fake timers and never touches a socket or a disk.
 * Only the client's own relay-facing calls are stubbed: watch/unwatch (which
 * would write to /ws/files) and the project's readFile/stat (which would
 * fetch).
 */
const { NullLogger } = require('../../../logger');
const mod = require('../../../relay-file-client');
const FileWatcher = require('../../../file-watcher');

const RelayFileClient = mod.RelayFileClient || mod;

const canon = (p) => String(p).replace(/^\/+/, '').replace(/\/+$/, '');

function makeRig(projects) {
  const client = new RelayFileClient({
    relayTransport: { fetch: jest.fn(), stream: jest.fn(), createWebSocket: jest.fn() },
    log: new NullLogger(),
  });
  client.watch = jest.fn();
  client.unwatch = jest.fn();

  const tree = new Map(); // `${projectId}:${rel}` -> string (file) | null (directory)
  const key = (projectId, rel) => `${projectId}:${canon(rel)}`;
  const byId = new Map(projects.map((p) => [p.id, p]));

  for (const project of projects) {
    const pf = client.forProject(project);
    pf.readFile = jest.fn(async (_root, rel) => {
      const v = tree.get(key(project.id, rel));
      if (typeof v !== 'string') throw new Error('File not found');
      return { content: v, size: Buffer.byteLength(v) };
    });
    pf.stat = jest.fn(async (_root, rel) => {
      const k = key(project.id, rel);
      if (canon(rel) === '' || tree.get(k) === null) return { type: 'directory', size: 0, mtime: 0 };
      if (tree.has(k)) return { type: 'file', size: 1, mtime: 0 };
      throw new Error('File not found');
    });
  }

  const ws = { sent: [], send(d) { this.sent.push(JSON.parse(d)); } };
  const watcher = new FileWatcher(ws, client, (id) => byId.get(id));

  return {
    client,
    ws,
    watcher,
    setFile: (projectId, rel, content) => tree.set(key(projectId, rel), content),
    setDir: (projectId, rel) => tree.set(key(projectId, rel), null),
    removeEntry: (projectId, rel) => tree.delete(key(projectId, rel)),
    emitFs: (projectId, p, kind) => client.emit('fs_event', { projectId, path: p, kind }),
    framesOf: (type) => ws.sent.filter((m) => m.type === type),
    // Absolute-looking key the watcher derives for a self-write, as the save path does.
    selfKey: (projectId, rel) => client.forProject(byId.get(projectId)).validatePath(byId.get(projectId).path, rel),
  };
}

module.exports = { makeRig };
