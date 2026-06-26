/**
 * WebSocket connection handler - dispatches messages to relay or local services.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RelayClient = require('./relay-client');
const SlashCommandHandler = require('./slash-command-handler');
const FileWatcher = require('./file-watcher');
const RateLimiter = require('./rate-limiter');
const { splitIntoChunks, cleanChunkText } = require('./tts-chunker');
const { Director } = require('./tts-director');

const slashCommandHandler = new SlashCommandHandler();

// Per-connection rate limit for expensive operations (CPU/memory heavy or
// fan-out to relay/STT/TTS). Generous enough for a human driving the UI, low
// enough to cap abuse from a hijacked or scripted client. Tunable via env.
// See docs/security-audit-frontend.md (M3).
const EXPENSIVE_OPS = new Set([
  'create_session',
  'search_project',
  'search_ai_summarize',
  'module_invoke_ai',
  'transcribe_audio',
  'tts_speak',
]);
const EXPENSIVE_WINDOW_MS = parseInt(process.env.EVE_RATELIMIT_WINDOW_MS || '10000', 10);
const EXPENSIVE_MAX = parseInt(process.env.EVE_RATELIMIT_MAX || '30', 10);

// Device diagnostics (relayClient native audio): the iOS app streams its
// cold-start / background-survival trace here as { type:'device_log', line|lines }
// so it can be collected with no USB cable. Appended to a file for tailing.
const DEVICE_LOG_PATH = path.join(__dirname, 'relay-device.log');
function appendDeviceLog(message, req) {
  try {
    const lines = Array.isArray(message.lines)
      ? message.lines
      : (typeof message.line === 'string' ? [message.line] : []);
    if (!lines.length) return;
    const recv = new Date().toISOString();
    const src = (req && req.socket && req.socket.remoteAddress) || '?';
    const text = lines
      .map((l) => `${recv} ${src} ${typeof l === 'string' ? l : JSON.stringify(l)}`)
      .join('\n') + '\n';
    fs.appendFile(DEVICE_LOG_PATH, text, () => {});
  } catch (_) { /* diagnostics must never break the socket */ }
}

function createWsHandler({ authService, trustedNetwork, relayTransport, fileHandlers, moduleService, moduleInvoker, searchSummarizer, claudeConfig, resolveProject, ttsService, sttService, uiBus, log }) {
  return (ws, req) => {
    // Trust is decided by the raw TCP source address via TrustedNetworkService.
    // Never consult req.headers.host or X-Forwarded-For here — both are
    // attacker-controllable. See docs/security-review-auth-transport.md Section A.
    const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !trustedNetwork.isTrusted(req);
    let isAuthenticated = !requiresAuth;

    const relayClient = new RelayClient(relayTransport, ws, ttsService, log?.child('Relay'));

    // Heartbeat liveness (graceful-reconnect, Issue 1): the server pings every
    // client on an interval (see server.js); a live browser auto-replies with a
    // protocol pong, which marks the socket alive. The reaper terminates any
    // socket still marked dead on the next tick — this is how a zombie
    // connection left behind by a phone network switch gets cleaned up instead
    // of lingering for the OS TCP timeout and holding a ghost relay session.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Track this connection so the eve-control MCP can target ui_command pushes
    // by project (project set is populated from message.projectId below).
    uiBus?.register(relayClient);
    const fileWatcher = new FileWatcher(ws, fileHandlers.fileService, resolveProject);
    // Per-connection in-flight tracking — used to cancel everything cleanly
    // if the browser drops mid-search. Both SearchService and SearchSummarizer
    // track by requestId only, so we need to know which IDs belong to us.
    const inflightSearchIds = new Set();
    const inflightAiIds = new Set();
    const expensiveLimiter = new RateLimiter({ windowMs: EXPENSIVE_WINDOW_MS, max: EXPENSIVE_MAX });

    // Connect to relayLLM immediately
    relayClient.connect().catch(err => {
      log?.error('Failed to connect to relayLLM:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot connect to relay service' }));
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle auth message first
        if (message.type === 'auth') {
          if (!requiresAuth) {
            ws.send(JSON.stringify({ type: 'auth_success' }));
            return;
          }
          if (authService.validateSession(message.token)) {
            isAuthenticated = true;
            ws.send(JSON.stringify({ type: 'auth_success' }));
          } else {
            ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid or expired token' }));
            ws.close(4001, 'Unauthorized');
          }
          return;
        }

        // App-level heartbeat (graceful-reconnect, Issue 1): the browser
        // WebSocket API cannot send protocol pings, so the client pings at the
        // app layer to detect a dead link fast after a network change. Answer
        // before the auth gate and rate-limiter so the probe is always cheap
        // and never blocked. See public/ws-client.js _heartbeat().
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        // Block all other messages until authenticated
        if (!isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
          return;
        }

        // Throttle expensive operations per connection.
        if (EXPENSIVE_OPS.has(message.type) && !expensiveLimiter.allow()) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Rate limit exceeded — too many requests, please slow down.',
            requestId: message.requestId,
          }));
          return;
        }

        // Remember which project(s) this browser is viewing so LLM-initiated UI
        // commands (eve-control MCP) reach it. Most project-scoped messages
        // carry projectId; setting it repeatedly is idempotent.
        if (message.projectId) uiBus?.setProject(relayClient, message.projectId);

        switch (message.type) {
          case 'device_log':
            appendDeviceLog(message, req);
            break;

          case 'create_session':
            await handleCreateSession(ws, relayClient, relayTransport, message, resolveProject, log);
            break;

          case 'join_session':
            relayClient.joinSession(message.sessionId);
            break;

          case 'user_input':
            handleUserInput(ws, relayClient, message, log);
            break;

          case 'leave_session':
            relayClient.leaveSession(message.sessionId);
            break;

          case 'end_session':
            relayClient.endSession(message.sessionId || relayClient.currentSessionId);
            break;

          case 'delete_session':
            relayClient.deleteSession(message.sessionId);
            break;

          case 'rename_session':
            relayClient.renameSession(message.sessionId, message.name);
            break;

          case 'set_session_folder':
            relayClient.setSessionFolder(message.sessionId, message.folder);
            break;

          case 'stop_generation':
            relayClient.stopGeneration(message.sessionId);
            break;

          case 'permission_response':
            relayClient.sendPermissionResponse(
              message.permissionId,
              message.approved,
              message.reason || ''
            );
            break;

          case 'set_permission_mode':
            relayClient.setPermissionMode(message.sessionId, message.mode);
            break;

          // --- File operations (local) ---
          case 'list_directory':
            // Listing a directory expresses interest in the project's tree;
            // start its recursive watcher so external structural changes
            // (new/removed files & folders) are surfaced live.
            fileWatcher.watchProject(message.projectId);
            fileHandlers.listDirectory(ws, message);
            break;

          case 'read_file':
            fileHandlers.readFile(ws, message);
            break;

          case 'write_file': {
            const project = resolveProject(message.projectId);
            if (project) {
              try {
                const absPath = fileHandlers.fileService.validatePath(project.path, message.path);
                fileWatcher.markSelfWrite(absPath);
              } catch { /* path validation failed, writeFile will handle the error */ }
            }
            fileHandlers.writeFile(ws, message);
            break;
          }

          case 'rename_file':
            fileHandlers.renameFile(ws, message);
            break;

          case 'move_file':
            fileHandlers.moveFile(ws, message);
            break;

          case 'delete_file':
            fileHandlers.deleteFile(ws, message);
            break;

          case 'upload_file':
            fileHandlers.uploadFile(ws, message);
            break;

          case 'create_directory':
            fileHandlers.createDirectory(ws, message);
            break;

          case 'search_project':
            if (message.requestId) inflightSearchIds.add(message.requestId);
            fileHandlers.searchProject(ws, message).finally(() => {
              if (message.requestId) inflightSearchIds.delete(message.requestId);
            });
            break;

          case 'search_cancel':
            if (fileHandlers.searchService && message.requestId) {
              fileHandlers.searchService.cancel(message.requestId);
              inflightSearchIds.delete(message.requestId);
            }
            break;

          case 'search_ai_summarize':
            if (message.requestId) inflightAiIds.add(message.requestId);
            handleSearchAiSummarize(ws, relayClient, searchSummarizer, message, log, () => {
              if (message.requestId) inflightAiIds.delete(message.requestId);
            });
            break;

          case 'search_ai_stop':
            if (searchSummarizer && message.requestId) {
              searchSummarizer.stop(message.requestId);
              inflightAiIds.delete(message.requestId);
            }
            break;

          case 'watch_file':
            fileWatcher.watch(message.projectId, message.path, { binary: !!message.binary });
            break;

          case 'unwatch_file':
            fileWatcher.unwatch(message.projectId, message.path);
            break;

          // --- Module file ops (server-side permission check) ---
          case 'module_read_file':
            await handleModuleFileOp(ws, { moduleService, fileHandlers, resolveProject, fileWatcher },
              message, 'read');
            break;

          case 'module_write_file':
            await handleModuleFileOp(ws, { moduleService, fileHandlers, resolveProject, fileWatcher },
              message, 'write');
            break;

          // --- Module AI invocation (streaming via hidden ephemeral session) ---
          case 'module_invoke_ai':
            handleModuleInvokeAi(ws, relayClient, moduleInvoker, message, log);
            break;

          case 'module_ai_stop':
            if (moduleInvoker && message.requestId) {
              moduleInvoker.stop(message.requestId);
            }
            break;

          // --- Terminal operations (proxied to relayLLM) ---
          case 'terminal_create':
            // Forward projectId so relay can resolve a project-scoped token for
            // the PTY (validating directory against the project). Empty/absent
            // projectId yields a token-free ad-hoc terminal.
            relayClient.send({ type: 'terminal_create', templateId: message.templateId, name: message.name, directory: message.directory, projectId: message.projectId || '', cols: message.cols, rows: message.rows });
            break;

          case 'terminal_input':
            relayClient.send({ type: 'terminal_input', terminalId: message.terminalId, data: message.data });
            break;

          case 'terminal_resize':
            relayClient.send({ type: 'terminal_resize', terminalId: message.terminalId, cols: message.cols, rows: message.rows });
            break;

          case 'terminal_close':
            relayClient.send({ type: 'terminal_close', terminalId: message.terminalId });
            break;

          case 'terminal_list':
            relayClient.send({ type: 'terminal_list' });
            break;

          case 'terminal_reconnect':
            relayClient.send({ type: 'terminal_reconnect', terminalId: message.terminalId, cols: message.cols, rows: message.rows });
            break;

          case 'join_terminal':
            relayClient.send({ type: 'join_terminal', terminalId: message.terminalId });
            break;

          case 'leave_terminal':
            relayClient.send({ type: 'leave_terminal', terminalId: message.terminalId });
            break;

          case 'terminal_templates':
            relayClient.send({ type: 'terminal_templates' });
            break;

          case 'voice_mode':
            relayClient.setVoiceMode(message.enabled, message.voice, message.speed);
            break;

          case 'tts_speak': {
            // Serialize a connection's read-aloud requests so rapid play-button
            // clicks don't fan out into overlapping synthesis. The daemon's own
            // gen_lock is the crash-safety boundary (it serializes globally,
            // across all sessions); this per-connection chain just keeps one
            // client's requests ordered and avoids piling up in-flight work.
            //
            // Read-aloud now streams sentence-by-sentence, so a new request (or
            // a stop) bumps _ttsSpeakGen; the streaming loop checks the gen
            // before each chunk and bails, abandoning the rest. This request
            // owns the generation captured here.
            const speakGen = (ws._ttsSpeakGen = (ws._ttsSpeakGen || 0) + 1);
            ws._ttsSpeakChain = (ws._ttsSpeakChain || Promise.resolve())
              .then(() => handleTtsSpeak(ws, ttsService, message, log, () => ws._ttsSpeakGen === speakGen))
              .catch((err) => log?.error('tts_speak chain error:', err.message));
            break;
          }

          case 'tts_speak_cancel':
            // Browser stopped read-aloud playback. Bump the generation so an
            // in-flight streaming loop abandons its remaining chunks instead of
            // synthesizing audio nobody will hear (and holding the daemon's
            // global gen_lock against other sessions).
            ws._ttsSpeakGen = (ws._ttsSpeakGen || 0) + 1;
            break;

          case 'transcribe_audio':
            handleTranscribeAudio(ws, sttService, message, log);
            break;

          case 'read_plan_file':
            handleReadPlanFile(ws, message.path);
            break;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      // Kill anything this browser kicked off — ripgrep children and hidden
      // relay sessions both stay alive until their own timeouts otherwise.
      for (const id of inflightSearchIds) {
        fileHandlers.searchService?.cancel(id);
      }
      inflightSearchIds.clear();
      for (const id of inflightAiIds) {
        searchSummarizer?.stop(id);
      }
      inflightAiIds.clear();
      relayClient.close();
      fileWatcher.closeAll();
      uiBus?.unregister(relayClient);
    });
  };
}

/**
 * Create session via relayLLM HTTP POST, then join via WS.
 * Resolves the project for its directory and permission policy only. The
 * project token is brokered entirely by relay — relayLLM resolves the scoped
 * token from relay's bridge by projectId at spawn time, so eve never handles it.
 */
async function handleCreateSession(ws, relayClient, relayTransport, message, resolveProject, log) {
  try {
    // Resolve project for directory and permission policy (never the token).
    let directory = message.directory || '';
    let projectPolicy = null;
    if (message.projectId) {
      const project = resolveProject(message.projectId);
      if (project) {
        directory = directory || project.path;
        projectPolicy = project.permissionPolicy || null;
      }
    }

    // Merge project policy into the session settings. The client may set
    // permissionMode in message.settings to override the project default
    // (e.g. "Start in plan mode" checkbox). The policy itself (allowed/denied)
    // always comes from the project — clients can't widen it.
    const settings = { ...(message.settings || {}) };
    if (projectPolicy) {
      settings.permissionPolicy = {
        allowedTools: projectPolicy.allowedTools || [],
        deniedTools: projectPolicy.deniedTools || [],
        defaultMode: projectPolicy.defaultMode || 'default',
      };
      if (!settings.permissionMode && projectPolicy.defaultMode && projectPolicy.defaultMode !== 'default') {
        settings.permissionMode = projectPolicy.defaultMode;
      }
    }

    const { status, data } = await relayTransport.fetch('POST', '/api/sessions', {
      projectId: message.projectId || '',
      directory,
      name: message.name || '',
      model: message.model || '',
      settings: Object.keys(settings).length > 0 ? settings : null,
      systemPrompt: message.systemPrompt || '',
      appendClaudeMd: message.appendClaudeMd || false,
    });

    if (status < 200 || status >= 300) {
      ws.send(JSON.stringify({ type: 'error', message: (data && data.error) || 'Failed to create session' }));
      return;
    }

    // Send session_created to browser
    ws.send(JSON.stringify({
      type: 'session_created',
      sessionId: data.sessionId,
      directory: data.directory,
      projectId: data.projectId || null,
      model: data.model,
      name: data.name || null,
      metadata: data.directory,
      sessionType: message.sessionType || null,
      voice: message.voice || null,
    }));

    // Voice mode is controlled by the client via syncVoiceMode.
    // Server TTS backend sends voice_mode enabled; on-device backends don't.
    // Don't force it here — that would cause double speech when using native/browser TTS.

    // Suppress the session_joined that relayLLM will send when we join
    relayClient.setSuppressNextJoin(data.sessionId);
    relayClient.currentSessionId = data.sessionId;
    relayClient.sessionDirectory = data.directory;
    relayClient.joinSession(data.sessionId);

  } catch (err) {
    log?.error('Create session failed:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to create session: relay unavailable' }));
  }
}

/**
 * Handle user input: check for local slash commands first, else relay.
 */
// Voice mode: tell the model to (a) write for the ear and (b) sprinkle the
// inline cue vocabulary the Director (tts-director.js) parses into per-utterance
// emotion/delivery. Brackets are the ONE markup we allow precisely because the
// Director consumes them and strips them before synthesis.
const VOICE_MODE_INSTRUCTION = [
  '[VOICE MODE] Your reply is spoken aloud by an expressive voice — perform it, don\'t just answer.',
  'Talk like a real person: conversational, concise (a sentence or three unless asked for more), with natural rhythm and contractions.',
  'No markdown, headings, bullet or numbered lists, tables, code blocks, emojis, or URLs — none of it reads aloud. Spell things as spoken ("twenty bucks", not "$20"; "doctor Reyes", not "Dr. Reyes").',
  'Shape delivery with cues in square brackets — the ONLY markup allowed. Never narrate actions any other way (no "*laughs*", no "(softly)").',
  'Emotion cues (a momentary feeling, right where it lands): [laugh] [giggle] [chuckle] [sigh] [gasp] [groan] [yawn] [sniffle] [cry] [gulp].',
  'Delivery cues (change HOW you sound and persist until you change them; return to normal with [normal]): [whisper] [soft] [normal] [loud] [shout] [fast] [slow] [excited] [flat].',
  'Use them like a voice actor: lead with a delivery cue when it fits, then [normal] to come back; drop an emotion cue exactly where the feeling hits; vary your delivery but stay believable (don\'t laugh every line or shout every sentence); one cue per spot — don\'t stack them or invent new ones.',
  'Example — User: I got the job!! / You: [gasp] Shut up! [excited] You GOT it?! [laugh] I knew it. [normal] Okay, tell me everything.',
].join(' ');

const DICTATION_NOTICE = '[DICTATED] The following was spoken aloud and transcribed via speech-to-text. Minor transcription errors may be present; please interpret the intended meaning.\n\n';

function handleUserInput(ws, relayClient, message, log) {
  const text = (message.text || '').trim();

  if (slashCommandHandler.handle(ws, relayClient, text)) {
    return;
  }

  const files = (message.files || []).map(parseFileAttachment);

  let finalText = message.text;

  // Prepend dictation notice for voice-transcribed input
  if (message.dictated) {
    finalText = DICTATION_NOTICE + finalText;
  }

  // Prepend voice mode instruction when voice mode is active
  if (relayClient.voiceMode) {
    finalText = VOICE_MODE_INSTRUCTION + '\n\n' + finalText;
  }

  log?.debug('→ LLM:', finalText);
  relayClient.sendMessage(finalText, files, message.sessionId);
}

/**
 * Read a Claude plan file with strict path validation.
 */
async function handleReadPlanFile(ws, filePath) {
  try {
    if (!filePath || typeof filePath !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid plan file path' }));
      return;
    }

    const resolved = path.resolve(filePath);
    const plansDir = path.resolve(os.homedir(), '.claude', 'plans');

    if (!resolved.startsWith(plansDir + path.sep) || !resolved.endsWith('.md')) {
      ws.send(JSON.stringify({ type: 'error', message: 'Plan file path not allowed' }));
      return;
    }

    // Defeat a symlink inside plansDir pointing outside it: re-check the
    // realpath. ENOENT falls through to the readFile error below.
    try {
      const real = await fs.promises.realpath(resolved);
      if (!real.startsWith(plansDir + path.sep)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Plan file path not allowed' }));
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    const content = await fs.promises.readFile(resolved, 'utf8');
    ws.send(JSON.stringify({ type: 'plan_file_content', path: filePath, content }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: `Failed to read plan file: ${err.message}` }));
  }
}

/**
 * Convert a client file attachment to the relay format.
 * Extracts mime type and raw base64 from data URLs.
 */
function parseFileAttachment(f) {
  if (f.type === 'image' && f.content && f.content.startsWith('data:')) {
    const match = f.content.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { name: f.name, mimeType: match[1], data: match[2] };
    }
  }
  return { name: f.name, mimeType: f.mediaType || '', data: f.content || '' };
}

/**
 * Transcribe audio via the Whisper STT daemon.
 */
async function handleTranscribeAudio(ws, sttService, message, log) {
  try {
    const { audio, language } = message;
    if (!audio) {
      ws.send(JSON.stringify({ type: 'transcription_error', error: 'No audio data' }));
      return;
    }
    const audioBytes = Math.round(audio.length * 3 / 4); // approximate decoded size
    log?.debug(`Transcribing audio: ~${audioBytes} bytes, language=${language || 'auto'}`);
    if (audioBytes < 100) {
      ws.send(JSON.stringify({ type: 'transcription_error', error: 'Audio recording too short' }));
      return;
    }
    const result = await sttService.transcribe(audio, language || null);
    log?.debug('STT result:', result.text);
    ws.send(JSON.stringify({
      type: 'transcription_result',
      text: result.text,
      language: result.language,
      duration: result.duration
    }));
  } catch (err) {
    log?.error('Transcription failed:', err.message);
    // Strip verbose ffmpeg output — show a clean error to the user
    let errorMsg = err.message;
    if (errorMsg.includes('ffmpeg') || errorMsg.includes('EBML') || errorMsg.includes('End of file')) {
      errorMsg = 'Failed to process audio. The recording may be too short or corrupted.';
    }
    ws.send(JSON.stringify({ type: 'transcription_error', error: errorMsg }));
  }
}

/**
 * On-demand TTS (read-aloud button): synthesize text and stream audio back to
 * the browser sentence-by-sentence so the first word plays after the first
 * sentence is generated, not the whole message. Each chunk goes out as a
 * binary WS frame; the browser plays them in arrival order
 * (enqueueServerAudioBuffer) and finalizes on the tts_done control frame.
 *
 * @param {() => boolean} isActive — false once this read-aloud has been
 *   superseded or cancelled; the loop bails before its next chunk so we stop
 *   holding the daemon's global gen_lock for audio nobody will hear.
 */
const TTS_SPEAK_MAX_CHARS = 10000;

async function handleTtsSpeak(ws, ttsService, message, log, isActive = () => true) {
  const { text, voice, speed } = message;
  if (!text || !ttsService) {
    ws.send(JSON.stringify({ type: 'tts_error', message: 'TTS unavailable' }));
    return;
  }
  if (text.length > TTS_SPEAK_MAX_CHARS) {
    ws.send(JSON.stringify({ type: 'tts_error', message: `Text too long (max ${TTS_SPEAK_MAX_CHARS} characters)` }));
    return;
  }

  // Full-sentence chunks, synthesized one at a time. Synthesis stays serial:
  // the daemon's gen_lock serializes globally anyway, and at RTF ~0.05
  // generation outpaces playback, so chunk N+1 is ready before N finishes.
  const chunks = splitIntoChunks(text);
  log?.debug(`TTS speak: ${chunks.length} chunk(s), ${text.length} chars (voice: ${voice})`);

  // Fresh Director per read-aloud: parse inline cues into expressive spans (and
  // strip the tags so they're never spoken literally). Delivery persists across
  // this message's chunks; a play button starts a clean turn.
  const director = new Director();
  const baseSpeed = speed || 1.0;

  try {
    for (const chunk of chunks) {
      for (const span of director.plan(chunk)) {
        if (!isActive()) return; // cancelled — browser already finalized via stop()
        const cleaned = cleanChunkText(span.text);
        if (!cleaned) continue;
        const result = await ttsService.synthesize(
          cleaned, voice || 'af_heart', baseSpeed * span.speed, span.instruct, span.gain);
        if (!isActive()) return; // cancelled while this span was generating
        // Audio goes out as a binary WS frame (no base64 inflation / atob); only
        // control frames (tts_done/tts_error) stay JSON. See RelayClient._sendAudioToBrowser.
        // Opaque/already-compact audio — skip permessage-deflate (net-negative CPU).
        ws.send(Buffer.from(result.audio_base64, 'base64'), { compress: false });
      }
    }
  } catch (err) {
    log?.error('TTS speak failed:', err.message);
    if (isActive()) ws.send(JSON.stringify({ type: 'tts_error', message: 'Speech synthesis failed' }));
  }
  // Finalize on success or partial failure so the browser leaves the speaking
  // state. Skipped on cancel (early return) — the browser already cleaned up.
  if (isActive()) ws.send(JSON.stringify({ type: 'tts_done' }));
}

/**
 * Bridge module SDK file ops (readFile/writeFile) through the server-side
 * permission check before delegating to FileHandlers. The iframe is untrusted
 * (AI-authored content); client-side checks are advisory only.
 */
async function handleModuleFileOp(ws, { moduleService, fileHandlers, resolveProject, fileWatcher }, message, op) {
  const { requestId, projectId, moduleName, path: relPath, content } = message;

  const reply = (payload) => ws.send(JSON.stringify({
    type: 'module_file_response', requestId, op, ...payload,
  }));

  const project = resolveProject(projectId);
  if (!project) return reply({ ok: false, error: 'Project not found' });

  let manifest;
  try {
    manifest = await moduleService.getModule(project.path, moduleName);
  } catch (err) {
    return reply({ ok: false, error: err.message });
  }

  if (!moduleService.isFilePermitted(manifest, relPath)) {
    return reply({ ok: false, error: `Permission denied: ${relPath} not in module permissions.files` });
  }

  try {
    if (op === 'read') {
      const { content: text, size } = await fileHandlers.fileService.readFile(project.path, relPath);
      reply({ ok: true, content: text, size });
    } else {
      try {
        const absPath = fileHandlers.fileService.validatePath(project.path, relPath);
        fileWatcher.markSelfWrite(absPath);
      } catch { /* writeFile will surface the same error */ }
      await fileHandlers.fileService.writeFile(project.path, relPath, content || '');
      reply({ ok: true });
    }
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
}

/**
 * Drive a streaming module AI invocation. The invoker handles the relay
 * session lifecycle and forwards per-event frames to the browser as it
 * goes; this wrapper just translates the terminal outcome into a single
 * `module_ai_completed`/`module_ai_failed` frame the client can resolve its
 * pending Promise against. The invoke is fire-and-forget from the WS
 * handler's perspective — errors must never throw past this boundary or
 * they'd bubble up and disconnect the socket.
 */
function handleModuleInvokeAi(ws, relayClient, moduleInvoker, message, log) {
  const { requestId, projectId, moduleName, prompt, files, schema, model } = message;
  if (!moduleInvoker) {
    ws.send(JSON.stringify({
      type: 'module_ai_failed', requestId, error: 'Module invoker not initialized',
    }));
    return;
  }
  if (!requestId) {
    ws.send(JSON.stringify({
      type: 'module_ai_failed', requestId: null, error: 'requestId required',
    }));
    return;
  }

  moduleInvoker.invoke({
    requestId, projectId, moduleName, prompt,
    files: files || [], schema, model,
    relayClient, browserWs: ws,
  }).then(({ result, rawText, model: usedModel, sessionId }) => {
    ws.send(JSON.stringify({
      type: 'module_ai_completed',
      requestId, sessionId, result, rawText, model: usedModel,
    }));
  }).catch(err => {
    log?.error?.(`module_invoke_ai ${requestId} failed: ${err.message}`);
    const payload = {
      type: 'module_ai_failed', requestId, error: err.message || 'Module invocation failed',
    };
    if (err.deniedFiles) payload.deniedFiles = err.deniedFiles;
    ws.send(JSON.stringify(payload));
  });
}

/**
 * Drive a streaming search-summary AI call. Never throws past this boundary —
 * outcomes are already delivered to the browser as `search_ai_*` frames by
 * SearchSummarizer.run() itself; this wrapper just logs and runs the
 * connection-tracking cleanup.
 */
function handleSearchAiSummarize(ws, relayClient, searchSummarizer, message, log, onDone) {
  const { requestId, projectId, query, matches, model } = message;
  const finish = () => { if (onDone) onDone(); };

  if (!searchSummarizer) {
    ws.send(JSON.stringify({
      type: 'search_ai_failed', requestId: requestId || null,
      error: 'Search summarizer not initialized',
    }));
    finish();
    return;
  }
  if (!requestId) {
    ws.send(JSON.stringify({
      type: 'search_ai_failed', requestId: null,
      error: 'requestId required',
    }));
    finish();
    return;
  }

  searchSummarizer.run({
    requestId, projectId, query, matches, model,
    relayClient, browserWs: ws,
  }).catch(err => {
    log?.error?.(`search_ai_summarize ${requestId.slice(0, 8)} failed: ${err.message}`);
  }).finally(finish);
}

module.exports = createWsHandler;
