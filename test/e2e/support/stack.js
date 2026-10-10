'use strict';

// One isolated eve stack per test: fakerelay (which launches relayScheduler
// and eve with the fd 3 secret), fake TTS and STT, all under one temp root.
// No port is fixed and nothing is shared with another test or the developer's
// shell. Waits are on signals: fakerelay's ready line, eve-ready.json, and
// fakerelay's own service events.

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startVoiceFakes } = require('./voice-fakes');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SOCKET_MAX = 103;
const KILL_AFTER_MS = 15_000;

function tail(text, lines = 8) {
  return String(text).trim().split('\n').slice(-lines).join(' | ');
}

function runToEnd(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

class Stack {
  constructor({ fakerelay, relayscheduler, world, network, scheduler }) {
    this.bins = { fakerelay, relayscheduler };
    this.world = world;
    this.network = network;
    this.scheduler = scheduler;
    this.watchers = new Set();
    this.exited = null;
    this.child = null;
    this.overrun = null;
    this.voiceFakes = null;
  }

  get relayDir() { return path.join(this.root, 'r'); }

  childEnv() {
    return { PATH: process.env.PATH, HOME: path.join(this.root, 'home'), TMPDIR: path.join(this.root, 'tmp'), TZ: 'UTC' };
  }

  // Appends the two service records the fixture owns. A world that names its
  // own services would race the fixture for eve's launch.
  buildWorld() {
    if (this.world.services !== undefined) throw new Error('world.services is owned by the fixture');
    const world = structuredClone(this.world);
    world.schema = world.schema ?? 1;
    world.listeners = { api: '', ...(world.listeners || {}) };
    const eveEnv = {
      EVE_DATA_DIR: path.join(this.root, 'eve'),
      PORT: '0',
      EVE_BIND_HOST: '127.0.0.1',
      TTS_PORT: String(this.voiceFakes.ttsPort),
      STT_PORT: String(this.voiceFakes.sttPort),
    };
    if (this.network === 'untrusted') eveEnv.EVE_DISABLE_SUBNET_BYPASS = '1';
    world.services = [];
    if (this.scheduler) {
      const dir = path.join(this.root, 'sched');
      world.services.push({
        id: 'relayscheduler', name: 'relayScheduler', command: this.bins.relayscheduler, args: [],
        working_dir: dir, capabilities: ['frontend', 'manifest'], autostart: true,
        env: { RELAY_SCHEDULER_DATA: dir },
      });
    }
    world.services.push({
      id: 'eve', name: 'Eve', command: process.execPath, args: ['server.js'],
      working_dir: REPO_ROOT, capabilities: ['frontend'], autostart: true, env: eveEnv,
    });
    return world;
  }

  checkSocketPaths() {
    const candidates = [
      path.join(this.relayDir, 'relay-frontend-9999999.sock'),
      path.join(this.relayDir, 'fakerelay-control.sock'),
      path.join(this.root, 'sched', 'relayscheduler.sock'),
    ];
    for (const p of candidates) {
      if (Buffer.byteLength(p) > SOCKET_MAX) {
        throw new Error(`socket path is ${Buffer.byteLength(p)} bytes, over ${SOCKET_MAX}: ${p}; set TMPDIR to a shorter directory`);
      }
    }
  }

  async start() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    for (const d of ['r', 'eve', 'sched', 'home', 'tmp']) fs.mkdirSync(path.join(this.root, d));
    this.checkSocketPaths();

    this.voiceFakes = await startVoiceFakes();
    this.voice = this.voiceFakes.voice;
    fs.writeFileSync(path.join(this.relayDir, 'world.json'), JSON.stringify(this.buildWorld()));

    this.stderrPath = path.join(this.root, 'fakerelay.stderr');
    const stderrFile = fs.openSync(this.stderrPath, 'w');
    this.child = spawn(this.bins.fakerelay, ['--config-dir', this.relayDir, 'serve'], {
      env: this.childEnv(), stdio: ['ignore', 'pipe', stderrFile],
    });
    fs.closeSync(stderrFile);
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve({ code, signal })));
    this.child.on('error', () => {});

    await this.waitReadyLine();
    await Promise.all([
      this.waitEveReady(),
      this.scheduler ? this.waitSchedulerReady() : null,
    ]);
  }

  stderrTail() {
    try { return tail(fs.readFileSync(this.stderrPath, 'utf8')); } catch { return ''; }
  }

  // fakerelay prints one line, the ready.json path, once it is serving.
  async waitReadyLine() {
    const line = new Promise((resolve) => {
      let buf = '';
      this.child.stdout.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1) resolve(buf.slice(0, nl).trim());
      });
    });
    const outcome = await Promise.race([line, this.exited]);
    if (typeof outcome !== 'string') {
      throw new Error(`fakerelay exited ${outcome.code ?? outcome.signal} before ready: ${this.stderrTail()}`);
    }
  }

  // Delivers each fakerelay event line of one kind to `onLine`, once: the lines
  // already written, then every new one. `logs --follow` ends at its first
  // match, so a predicate could not keep it open. This subscribes to fakerelay's
  // append notices on the control socket instead, and re-reads the log on each
  // notice. The notice stream answers at once, so nothing written after the
  // initial read can be missed.
  watch(event, { since } = {}, onLine) {
    const seen = new Set();
    let closed = false;
    let reading = false;
    let again = false;
    const read = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        do {
          again = false;
          const argv = ['logs', '--json', '--event', event];
          if (since) argv.push('--since', since);
          const r = await this.cli(...argv);
          for (const raw of r.stdout.split('\n')) {
            if (closed) return;
            if (!raw.trim() || seen.has(raw)) continue;
            seen.add(raw);
            onLine(JSON.parse(raw));
          }
        } while (again && !closed);
      } finally {
        reading = false;
      }
    };
    const req = http.get({ socketPath: path.join(this.relayDir, 'fakerelay-control.sock'), path: '/v1/follow' }, (res) => {
      read();
      res.on('data', read);
      res.on('error', () => {});
    });
    req.on('error', () => {});
    const watcher = { close() { closed = true; req.destroy(); } };
    this.watchers.add(watcher);
    return watcher;
  }

  waitForEvent(event, { since, match } = {}) {
    return new Promise((resolve) => {
      const watcher = this.watch(event, { since }, (line) => {
        if (match && !match(line)) return;
        watcher.close();
        this.watchers.delete(watcher);
        resolve(line);
      });
    });
  }

  // Races a success signal against the service's failed state and fakerelay's exit.
  async raceReady({ id, label, logName, success }) {
    const cleanup = [];
    try {
      const failed = new Promise((resolve) => {
        const f = this.watch('service.state', {}, (l) => {
          if (l.service_id === id && l.phase === 'failed') resolve(l);
        });
        cleanup.push(() => f.close());
      });
      const ok = success(cleanup).then(() => null);
      const gone = this.exited.then((e) => ({ fakerelayExit: e }));
      const outcome = await Promise.race([ok, failed, gone]);
      if (outcome && outcome.fakerelayExit) {
        throw new Error(`fakerelay exited ${outcome.fakerelayExit.code ?? outcome.fakerelayExit.signal} before ${label}: ${this.stderrTail()}`);
      }
      if (outcome) {
        const code = outcome.exit_code ?? outcome.code ?? outcome.error ?? 'unknown';
        throw new Error(`${id === 'eve' ? 'eve' : 'relayScheduler'} exited ${code} before ${label}; see ${logName}`);
      }
    } finally {
      for (const c of cleanup) c();
    }
  }

  waitEveReady() {
    const readyFile = path.join(this.root, 'eve', 'eve-ready.json');
    return this.raceReady({
      id: 'eve', label: 'eve-ready.json', logName: 'eve.log',
      success: (cleanup) => new Promise((resolve) => {
        // Arm the watch first, then look: a file written in between is seen either way.
        const check = () => {
          try {
            this.eveReady = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
            watcher.close();
            resolve();
          } catch { /* not there yet, or mid-rename */ }
        };
        const watcher = fs.watch(path.dirname(readyFile), check);
        cleanup.push(() => watcher.close());
        check();
      }),
    }).then(() => { this.url = this.eveReady.url; });
  }

  waitSchedulerReady() {
    return this.raceReady({
      id: 'relayscheduler', label: 'its manifest was registered', logName: 'relayscheduler.log',
      success: (cleanup) => new Promise((resolve) => {
        const f = this.watch('service.manifest.register', {}, (l) => {
          if (l.service_id === 'relayscheduler' && l.status === 'ok') resolve();
        });
        cleanup.push(() => f.close());
      }),
    });
  }

  cli(...argv) {
    return runToEnd(this.bins.fakerelay, ['--config-dir', this.relayDir, ...argv], this.childEnv());
  }

  ctl(...argv) { return this.cli('ctl', ...argv); }

  async json(...argv) {
    const r = await this.cli(...argv);
    try {
      if (r.code !== 0) throw new Error('non-zero exit');
      return JSON.parse(r.stdout);
    } catch (err) {
      throw new Error(`relay ${argv.join(' ')} (exit ${r.code}): ${err.message}; stderr: ${tail(r.stderr)}`);
    }
  }

  async logs({ event, since } = {}) {
    const argv = ['logs', '--json'];
    if (event) argv.push('--event', event);
    if (since) argv.push('--since', since);
    const r = await this.cli(...argv);
    // `logs` exits 1 when nothing matches.
    if (r.code !== 0 && (r.stdout.trim() || r.stderr.trim())) {
      throw new Error(`relay ${argv.join(' ')} (exit ${r.code}): ${tail(r.stderr)}`);
    }
    return r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  // Files the fixture attaches to a failed test, by name.
  logFiles() {
    const logs = path.join(this.relayDir, 'logs');
    return [
      ['eve.log', path.join(logs, 'eve.log')],
      ['fakerelay.log', path.join(logs, 'relay.log')],
      ['relaysessions.log', path.join(logs, 'relaysessions.log')],
      ['relayscheduler.log', path.join(logs, 'relayscheduler.log')],
      ['fakerelay.stderr', this.stderrPath],
    ].filter(([, p]) => p && fs.existsSync(p));
  }

  async stop() {
    if (!this.root) return;
    for (const w of this.watchers) w.close();
    this.watchers.clear();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      // The bound is a fallback for a hung fakerelay, not a wait: the exit event is the signal.
      const timer = setTimeout(() => {
        this.overrun = `fakerelay still running ${KILL_AFTER_MS} ms after SIGTERM; sent SIGKILL`;
        this.child.kill('SIGKILL');
      }, KILL_AFTER_MS);
      timer.unref();
      await this.exited;
      clearTimeout(timer);
    }
    if (this.voiceFakes) await this.voiceFakes.close();
  }

  remove() {
    if (this.root) fs.rmSync(this.root, { recursive: true, force: true });
  }
}

module.exports = { Stack };
