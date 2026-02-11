import { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

const ENV_FILE = path.join(__dirname, '.test-env.json');
const SERVER_PORT = 3001;
const LM_STUDIO_URL = 'http://localhost:1234/v1/models';
const SERVER_READY_URL = `http://localhost:${SERVER_PORT}/api/auth/status`;

async function globalSetup(_config: FullConfig) {
  // 1. Create temp directory and copy showcase data
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-'));
  const showcaseDir = path.join(__dirname, '..', 'showcase');
  fs.cpSync(showcaseDir, tmpDir, { recursive: true });

  // Create projects subdir for E2E test projects
  const projectsDir = path.join(tmpDir, 'projects', 'e2e-test');
  fs.mkdirSync(projectsDir, { recursive: true });

  // 2. Check LM Studio availability
  try {
    const res = await fetch(LM_STUDIO_URL);
    if (!res.ok) throw new Error(`LM Studio returned ${res.status}`);
  } catch (err) {
    throw new Error(
      `LM Studio is not available at ${LM_STUDIO_URL}. ` +
      `Ensure LM Studio is running with Qwen 3 4B loaded. Error: ${err}`
    );
  }

  // 3. Spawn server with temp data directory
  const serverPath = path.join(__dirname, '..', 'server.js');
  const serverProcess = spawn('node', [serverPath, '--data', tmpDir], {
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Capture server output for debugging
  serverProcess.stdout.on('data', (data: Buffer) => {
    process.stdout.write(`[server] ${data}`);
  });
  serverProcess.stderr.on('data', (data: Buffer) => {
    process.stderr.write(`[server:err] ${data}`);
  });

  // 4. Wait for server to be ready
  const maxWait = 15_000;
  const start = Date.now();
  let ready = false;

  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(SERVER_READY_URL);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!ready) {
    serverProcess.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Server did not become ready within ${maxWait}ms`);
  }

  // 5. Write env file for tests and teardown
  const envData = {
    dataDir: tmpDir,
    serverPid: serverProcess.pid,
    projectsDir,
  };
  fs.writeFileSync(ENV_FILE, JSON.stringify(envData, null, 2));

  console.log(`[e2e] Server running on port ${SERVER_PORT}, PID ${serverProcess.pid}`);
  console.log(`[e2e] Data dir: ${tmpDir}`);
}

export default globalSetup;
