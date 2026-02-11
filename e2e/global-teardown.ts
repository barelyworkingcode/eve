import { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ENV_FILE = path.join(__dirname, '.test-env.json');

async function globalTeardown(_config: FullConfig) {
  if (!fs.existsSync(ENV_FILE)) {
    console.warn('[e2e] No .test-env.json found, nothing to clean up');
    return;
  }

  const env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf-8'));

  // Kill server process
  if (env.serverPid) {
    try {
      process.kill(env.serverPid, 'SIGTERM');
      console.log(`[e2e] Sent SIGTERM to server PID ${env.serverPid}`);

      // Wait briefly for graceful shutdown
      await new Promise((r) => setTimeout(r, 2000));

      // Force kill if still alive
      try {
        process.kill(env.serverPid, 0); // Check if alive
        process.kill(env.serverPid, 'SIGKILL');
        console.log(`[e2e] Sent SIGKILL to server PID ${env.serverPid}`);
      } catch {
        // Process already exited
      }
    } catch {
      // Process already exited
    }
  }

  // Clean up temp directory
  if (env.dataDir && fs.existsSync(env.dataDir)) {
    fs.rmSync(env.dataDir, { recursive: true, force: true });
    console.log(`[e2e] Removed temp dir: ${env.dataDir}`);
  }

  // Remove env file
  fs.unlinkSync(ENV_FILE);
  console.log('[e2e] Cleanup complete');
}

export default globalTeardown;
