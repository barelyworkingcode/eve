/**
 * WebSocket connection handler - dispatches messages to relay or local services.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RelayClient = require('./relay-client');
const SlashCommandHandler = require('./slash-command-handler');
const FileWatcher = require('./file-watcher');

const slashCommandHandler = new SlashCommandHandler();

function createWsHandler({ authService, trustedNetwork, relayTransport, fileHandlers, moduleService, moduleInvoker, searchSummarizer, claudeConfig, resolveProject, ttsService, sttService, log }) {
  return (ws, req) => {
    // Trust is decided by the raw TCP source address via TrustedNetworkService.
    // Never consult req.headers.host or X-Forwarded-For here — both are
    // attacker-controllable. See plans/cozy-honking-toast.md Section A.
    const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !trustedNetwork.isTrusted(req);
    let isAuthenticated = !requiresAuth;

    const relayClient = new RelayClient(relayTransport, ws, ttsService, log?.child('Relay'));
    const fileWatcher = new FileWatcher(ws, fileHandlers.fileService, resolveProject);
    // Per-connection in-flight tracking — used to cancel everything cleanly
    // if the browser drops mid-search. Both SearchService and SearchSummarizer
    // track by requestId only, so we need to know which IDs belong to us.
    const inflightSearchIds = new Set();
    const inflightAiIds = new Set();

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

        // Block all other messages until authenticated
        if (!isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
          return;
        }

        switch (message.type) {
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
            relayClient.send({ type: 'terminal_create', templateId: message.templateId, name: message.name, directory: message.directory, cols: message.cols, rows: message.rows });
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
            relayClient.setVoiceMode(message.enabled, message.voice);
            break;

          case 'tts_speak':
            handleTtsSpeak(ws, ttsService, message, log);
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
    });
  };
}

/**
 * Create session via relayLLM HTTP POST, then join via WS.
 * Resolves the project to get the scoped mcpToken and directory.
 */
async function handleCreateSession(ws, relayClient, relayTransport, message, resolveProject, log) {
  try {
    // Resolve project to get token, directory, and permission policy.
    let directory = message.directory || '';
    let mcpToken = '';
    let projectPolicy = null;
    if (message.projectId) {
      const project = resolveProject(message.projectId);
      if (project) {
        directory = directory || project.path;
        mcpToken = project.token || '';
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
      mcpToken,
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
const VOICE_MODE_INSTRUCTION = '[VOICE MODE] Respond conversationally for spoken delivery. Avoid markdown, code blocks, tables, bullet lists, URLs, and technical formatting. Use natural language, spell out numbers and abbreviations. Keep responses concise. Use punctuation for natural pauses.';

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
 * On-demand TTS: synthesize text and send audio back to the browser.
 */
const TTS_SPEAK_MAX_CHARS = 10000;

async function handleTtsSpeak(ws, ttsService, message, log) {
  const { text, voice } = message;
  if (!text || !ttsService) {
    ws.send(JSON.stringify({ type: 'tts_error', message: 'TTS unavailable' }));
    return;
  }
  if (text.length > TTS_SPEAK_MAX_CHARS) {
    ws.send(JSON.stringify({ type: 'tts_error', message: `Text too long (max ${TTS_SPEAK_MAX_CHARS} characters)` }));
    return;
  }
  try {
    log?.debug(`TTS speak: "${text.substring(0, 80)}" (voice: ${voice})`);
    const result = await ttsService.synthesize(text, voice || 'af_heart');
    ws.send(JSON.stringify({ type: 'tts_audio', data: result.audio_base64 }));
    ws.send(JSON.stringify({ type: 'tts_done' }));
  } catch (err) {
    log?.error('TTS speak failed:', err.message);
    ws.send(JSON.stringify({ type: 'tts_error', message: 'Speech synthesis failed' }));
  }
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
