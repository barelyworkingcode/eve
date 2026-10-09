const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChiefOfStaff } = require('../../chief-of-staff');

const dirs = [];
let h;
afterEach(async () => {
  await h?.cos.stop();
  for (const d of dirs.splice(0)) if (d && d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  h = null;
});

describe('refused or failing reader', () => {
  const http = require('http');
  const WebSocket = require('ws');

  // A real server that answers the upgrade with a plain HTTP status, as relay does.
  async function refusingServer(status) {
    const server = http.createServer();
    server.on('upgrade', (req, socket) => {
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server;
  }

  async function against(status) {
    jest.useRealTimers();
    const server = await refusingServer(status);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-unit-'));
    dirs.push(dir);
    const url = `ws://127.0.0.1:${server.address().port}/ws`;
    const cos = new ChiefOfStaff({
      relayTransport: { fetch: jest.fn(async () => ({ status: 200, data: { sessions: [] } })), createWebSocket: jest.fn(() => new WebSocket(url)) },
      model: { turn: jest.fn() }, dataDir: dir, settings: { model: 'haiku' },
    });
    h = { cos };
    cos.start();
    return { cos, server };
  }

  const until = async (ok) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(ok()).toBe(true);
  };

  it('a 403 on the upgrade turns the thread off and does not retry', async () => {
    const { cos, server } = await against(403);
    try {
      await until(() => cos.off?.reason === 'scope_refused');
      expect(cos._reconnectTimer).toBeNull();
      expect(cos._stopped).toBe(true);
    } finally { cos.stop(); server.close(); }
  });

  it('a 503 on the upgrade schedules a reconnect', async () => {
    const { cos, server } = await against(503);
    try {
      await until(() => cos._reconnectTimer !== null);
      expect(cos.off).toBeNull();
      expect(cos._stopped).toBe(false);
      expect(cos._ws).toBeNull();
    } finally { cos.stop(); server.close(); }
  });
});
