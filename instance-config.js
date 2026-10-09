const path = require('path');

const READY_FILE = 'eve-ready.json';

class InstanceConfigError extends Error {}

const PORT_RE = /^\d+$/;

function isSet(v) {
  return typeof v === 'string' && v !== '';
}

function dataDirFromArgv(argv, cwd) {
  const idx = argv.indexOf('--data');
  if (idx !== -1 && argv[idx + 1]) return path.resolve(cwd, argv[idx + 1]);
  return null;
}

/**
 * Pure: reads nothing but its input. "Isolated" means EVE_DATA_DIR is set and
 * non-empty; then every path derives from it or its own env name, and every
 * port must be explicit, so the instance can never fall back to a live
 * default path or port.
 */
function resolveInstanceConfig({ env, argv, cwd, appDir, homeDir }) {
  const isolated = isSet(env.EVE_DATA_DIR);
  const missing = [];
  const invalid = [];
  const other = [];

  const port = (name, { min, required }) => {
    const raw = env[name];
    if (!isSet(raw)) {
      if (required) missing.push(name);
      return null;
    }
    const n = PORT_RE.test(raw) ? Number(raw) : NaN;
    if (!(n >= min && n <= 65535)) {
      invalid.push(name);
      return null;
    }
    return n;
  };

  const tls = isSet(env.HTTPS_KEY) && isSet(env.HTTPS_CERT);
  const dual = env.DUAL_LISTEN === 'true';

  const portValue = port('PORT', { min: 0, required: isolated });
  // An unused HTTP_PORT must not change a production start, so outside
  // isolated mode it is read only when the loopback listener will use it.
  const httpPortValue = (isolated || (tls && dual))
    ? port('HTTP_PORT', { min: 0, required: isolated && tls && dual })
    : null;
  const ttsValue = port('TTS_PORT', { min: 1, required: isolated });
  const sttValue = port('STT_PORT', { min: 1, required: isolated });

  let dataDir;
  const argvDir = dataDirFromArgv(argv, cwd);
  if (isolated) {
    dataDir = path.resolve(cwd, env.EVE_DATA_DIR);
    if (argvDir !== null && argvDir !== dataDir) {
      other.push(`--data (${argvDir}) differs from EVE_DATA_DIR (${dataDir})`);
    }
    if (!isSet(env.RELAY_FRONTEND_SOCKET) && !isSet(env.RELAY_FRONTEND_URL)) {
      missing.push('RELAY_FRONTEND_SOCKET or RELAY_FRONTEND_URL');
    }
  } else {
    dataDir = argvDir !== null ? argvDir : path.join(appDir, 'data');
  }

  const problems = [];
  if (missing.length) {
    problems.push(`EVE_DATA_DIR is set, so ${missing.join(', ')} must be set too`);
  }
  for (const name of invalid) problems.push(`${name} is not a port number`);
  problems.push(...other);
  if (problems.length) throw new InstanceConfigError(problems.join('; '));

  const deviceLogPath = isSet(env.EVE_DEVICE_LOG_PATH)
    ? path.resolve(cwd, env.EVE_DEVICE_LOG_PATH)
    : (isolated ? path.join(dataDir, 'relay-device.log') : path.join(appDir, 'relay-device.log'));
  const plansDir = isSet(env.EVE_PLANS_DIR)
    ? path.resolve(cwd, env.EVE_PLANS_DIR)
    : (isolated ? path.join(dataDir, '.claude', 'plans') : path.join(homeDir, '.claude', 'plans'));

  return {
    isolated,
    dataDir,
    readyFile: path.join(dataDir, READY_FILE),
    port: portValue !== null ? portValue : 3000,
    httpPort: httpPortValue !== null ? httpPortValue : 3000,
    ttsPort: ttsValue !== null ? ttsValue : 9997,
    sttPort: sttValue !== null ? sttValue : 9998,
    deviceLogPath,
    plansDir,
  };
}

module.exports = { resolveInstanceConfig, InstanceConfigError, READY_FILE };
