/**
 * Session message descriptors — session lifecycle (create/join/leave/end/
 * delete/rename/folder), user input (with slash-command interception, voice
 * mode and dictation prompts) and mid-session controls (stop, permission
 * response, permission mode). See ws/message-registry.js for the registry
 * these are registered into.
 *
 * `create_session` is the only `async handle` in this file (and the first in
 * the registry outside the pilot): its `case` arm is `await`ed today, so its
 * rejections must keep reaching the dispatcher's `try/catch` the same way.
 * Every other descriptor here must NOT be async — see C2 in
 * ws/message-registry.js.
 */
const SlashCommandHandler = require('../slash-command-handler');
const { EMOTION, DELIVERY } = require('../tts-director');

// Stateless (see C5 in ws/message-registry.js) — takes ws/relayClient as
// call-time arguments on every invocation, so a single process-wide instance
// never captures a per-connection object.
const slashCommandHandler = new SlashCommandHandler();

/**
 * Create session via relayLLM HTTP POST, then join via WS.
 * Resolves the project for its directory and permission policy only. The
 * project token is brokered entirely by relay — relayLLM resolves the scoped
 * token from relay's bridge by projectId at spawn time, so eve never handles it.
 */
async function handleCreateSession(ctx) {
  const { ws, relayClient, message, log } = ctx;
  const { relayTransport, resolveProject } = ctx.deps;
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
    // Don't force it here — that would cause double speech when using native TTS.

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
// The advertised cue vocabulary is generated from the Director's own
// EMOTION/DELIVERY tables, so the prompt and the parser can't drift apart.
const cueTags = (cues) => Object.keys(cues).map(c => `[${c}]`).join(' ');
const VOICE_MODE_INSTRUCTION = [
  '[VOICE MODE] Your reply is spoken aloud by an expressive voice — perform it, don\'t just answer.',
  'Talk like a real person: conversational, concise (a sentence or three unless asked for more), with natural rhythm and contractions.',
  'No markdown, headings, bullet or numbered lists, tables, code blocks, emojis, or URLs — none of it reads aloud. Spell things as spoken ("twenty bucks", not "$20"; "doctor Reyes", not "Dr. Reyes").',
  'Shape delivery with cues in square brackets — the ONLY markup allowed. Never narrate actions any other way (no "*laughs*", no "(softly)").',
  `Emotion cues (a momentary feeling, right where it lands): ${cueTags(EMOTION)}.`,
  `Delivery cues (change HOW you sound and persist until you change them; return to normal with [normal]): ${cueTags(DELIVERY)}.`,
  'Use them like a voice actor: lead with a delivery cue when it fits, then [normal] to come back; drop an emotion cue exactly where the feeling hits; vary your delivery but stay believable (don\'t laugh every line or shout every sentence); one cue per spot — don\'t stack them or invent new ones.',
  'Example — User: I got the job!! / You: [gasp] Shut up! [excited] You GOT it?! [laugh] I knew it. [normal] Okay, tell me everything.',
].join(' ');

const DICTATION_NOTICE = '[DICTATED] The following was spoken aloud and transcribed via speech-to-text. Minor transcription errors may be present; please interpret the intended meaning.\n\n';

function handleUserInput(ctx) {
  const { ws, relayClient, message, log } = ctx;
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

module.exports = [
  { type: 'create_session', expensive: true, async handle(ctx) { await handleCreateSession(ctx); } },

  { type: 'join_session', handle(ctx) { ctx.relayClient.joinSession(ctx.message.sessionId); } },

  { type: 'user_input', handle(ctx) { handleUserInput(ctx); } },

  { type: 'leave_session', handle(ctx) { ctx.relayClient.leaveSession(ctx.message.sessionId); } },

  {
    type: 'end_session',
    handle(ctx) {
      ctx.relayClient.endSession(ctx.message.sessionId || ctx.relayClient.currentSessionId);
    },
  },

  { type: 'delete_session', handle(ctx) { ctx.relayClient.deleteSession(ctx.message.sessionId); } },

  {
    type: 'rename_session',
    handle(ctx) {
      ctx.relayClient.renameSession(ctx.message.sessionId, ctx.message.name);
    },
  },

  {
    type: 'set_session_folder',
    handle(ctx) {
      ctx.relayClient.setSessionFolder(ctx.message.sessionId, ctx.message.folder);
    },
  },

  { type: 'stop_generation', handle(ctx) { ctx.relayClient.stopGeneration(ctx.message.sessionId); } },

  {
    type: 'permission_response',
    handle(ctx) {
      ctx.relayClient.sendPermissionResponse(
        ctx.message.permissionId,
        ctx.message.approved,
        ctx.message.reason || ''
      );
    },
  },

  {
    type: 'set_permission_mode',
    handle(ctx) {
      ctx.relayClient.setPermissionMode(ctx.message.sessionId, ctx.message.mode);
    },
  },
];
