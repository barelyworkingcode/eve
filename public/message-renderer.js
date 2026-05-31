/**
 * Chat message rendering: user messages, assistant messages, tool use,
 * system messages, thinking indicator, text formatting.
 */

// Placeholder rendered in place of an Anthropic redacted_thinking block, whose
// body is an opaque encrypted blob. Wrapped in <think> tags so the existing
// think-block parser folds it.
const REDACTED_THINKING_PLACEHOLDER =
  '<think>\n_[redacted thinking — content filtered by Anthropic safety review]_\n</think>\n\n';

// URL prefix that relayLLM serves generated images from. Keep in sync with
// relayLLM/comfyui_client.go RegisterGeneratedImageRoutes and
// relayComfy/mcp/main.go RELAY_IMAGE_BASE default.
const GENERATED_PATH = '/api/generated/';

class MessageRenderer {
  /**
   * @param {Container} container - DI container
   * @param {Object} [opts]
   * @param {HTMLElement} [opts.targetEl] - container element to render into.
   *   Defaults to the main #messages element. Sub-agent renderers pass the
   *   parent Agent block's body so sidechain events render nested.
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.bus = container.get('bus');
    this.log = container.get('logger').child('Renderer');
    this.messagesEl = opts.targetEl || this.app.elements.messages;
    this.currentAssistantMessage = null;
    this.currentToolBlock = null;
    this.isStreaming = false;
    this.isRenderingHistory = false;
    this.thinkBlockOpenStates = new Map(); // messageEl -> Set of open indices
    this._speakingMessageEl = null;

    // Delegated mousedown handler for think-block summaries.
    // Uses mousedown (not click) because during streaming, innerHTML replacement
    // destroys elements between mousedown and mouseup, preventing click from firing.
    // The native <details> toggle still works for completed messages via the
    // normal click path; during streaming, _applyThinkBlockStates() restores
    // the tracked state after each innerHTML replacement.
    this.messagesEl.addEventListener('mousedown', (e) => {
      const summary = e.target.closest('.think-block > summary');
      if (!summary) return;
      const details = summary.parentElement;
      const content = details.closest('.message-content');
      if (!content) return;
      const blocks = Array.from(content.querySelectorAll('.think-block'));
      const idx = blocks.indexOf(details);
      if (idx === -1) return;

      if (!this.thinkBlockOpenStates.has(content)) {
        this.thinkBlockOpenStates.set(content, new Set());
      }
      const openSet = this.thinkBlockOpenStates.get(content);
      if (openSet.has(idx)) {
        openSet.delete(idx);
      } else {
        openSet.add(idx);
      }
    });

    // Delegated click handler for TTS play/stop buttons on assistant messages.
    this.messagesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.tts-play-btn');
      if (!btn) return;
      const messageEl = btn.closest('.message.assistant');
      if (!messageEl) return;
      const tts = this.app.ttsManager;
      if (!tts) return;

      // If this message is currently speaking, stop it
      if (this._speakingMessageEl === messageEl) {
        tts.stop();
        this._clearSpeakingState();
        return;
      }

      // Stop any current playback first
      if (this._speakingMessageEl) {
        tts.stop();
        this._clearSpeakingState();
      }

      const rawText = messageEl.querySelector('.message-content')?.dataset.ttsText;
      if (!rawText) return;

      this._speakingMessageEl = messageEl;
      btn.classList.add('tts-play-btn--active');
      btn.setAttribute('aria-label', 'Stop speaking');
      tts.speakText(rawText);
    });

    // Clear play button state when TTS playback finishes naturally
    this.bus.on(EVT.TTS_PLAYBACK_ENDED, () => this._clearSpeakingState());
  }

  _clearSpeakingState() {
    if (this._speakingMessageEl) {
      const btn = this._speakingMessageEl.querySelector('.tts-play-btn');
      if (btn) {
        btn.classList.remove('tts-play-btn--active');
        btn.setAttribute('aria-label', 'Read aloud');
      }
      this._speakingMessageEl = null;
    }
  }

  startAssistantMessage(text) {
    this.hideThinkingIndicator();
    this.markToolComplete();
    this.finishAssistantMessage();

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    messageEl.dataset.testid = 'message-assistant';
    messageEl.innerHTML = `<div class="message-content">${this.formatText(text)}</div>`;
    this.messagesEl.appendChild(messageEl);
    this.currentAssistantMessage = messageEl.querySelector('.message-content');
    this.currentAssistantMessage.dataset.rawText = text;
    this.isStreaming = true;
    this._saveStreamingText(text);
    this.scrollToBottom();
  }

  updateAssistantMessage(text) {
    if (this._streamRestoreTimer) {
      clearTimeout(this._streamRestoreTimer);
      this._streamRestoreTimer = null;
    }
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage(text);
    } else {
      this.currentAssistantMessage.innerHTML = this.formatText(text);
      this._applyThinkBlockStates();
      this.scrollToBottom();
    }
  }

  appendToAssistantMessage(text) {
    if (this._streamRestoreTimer) {
      clearTimeout(this._streamRestoreTimer);
      this._streamRestoreTimer = null;
    }
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage(text);
    } else {
      const currentText = this.currentAssistantMessage.dataset.rawText || '';
      const newText = currentText + text;
      this.currentAssistantMessage.dataset.rawText = newText;
      this.currentAssistantMessage.innerHTML = this.formatText(newText);
      this._applyThinkBlockStates();
      this._saveStreamingText(newText);
      this.scrollToBottom();
    }
  }

  _saveStreamingText(text) {
    const sid = this.app.state.currentSessionId;
    if (sid && !this.isRenderingHistory) {
      try { sessionStorage.setItem(`eve-stream-${sid}`, text); } catch {}
    }
  }

  _clearStreamingText() {
    const sid = this.app.state.currentSessionId;
    if (sid && !this.isRenderingHistory) {
      try { sessionStorage.removeItem(`eve-stream-${sid}`); } catch {}
    }
  }

  _applyThinkBlockStates() {
    if (!this.currentAssistantMessage) return;
    const openSet = this.thinkBlockOpenStates.get(this.currentAssistantMessage);
    if (!openSet || openSet.size === 0) return;
    const blocks = this.currentAssistantMessage.querySelectorAll('.think-block');
    for (const idx of openSet) {
      if (blocks[idx]) blocks[idx].open = true;
    }
  }

  finishAssistantMessage(metrics) {
    this.markToolComplete();
    if (this.currentAssistantMessage) {
      const text = this.currentAssistantMessage.dataset.rawText;
      if (text && this.app.state.currentSessionId && !this.isRenderingHistory) {
        const history = this.app.state.sessionHistories.get(this.app.state.currentSessionId) || [];
        history.push({
          role: 'assistant',
          content: [{ type: 'text', text }]
        });
        this.app.state.sessionHistories.set(this.app.state.currentSessionId, history);
      }
      // Re-render with isStreaming=false to collapse think blocks
      if (text) {
        this.isStreaming = false;
        this.currentAssistantMessage.innerHTML = this.formatText(text);
        this._applyThinkBlockStates();
        this._upgradeGeneratedImages(this.currentAssistantMessage);
        this.renderMermaidBlocks(this.currentAssistantMessage);
      }
      // Append metrics subline (TTFT / TPS) below the message content.
      if (metrics && (metrics.ttft || metrics.tps)) {
        const parts = [];
        if (metrics.ttft) parts.push(`TTFT ${metrics.ttft.toFixed(1)}s`);
        if (metrics.tps) parts.push(`${metrics.tps.toFixed(1)} tps`);
        const metricsEl = document.createElement('div');
        metricsEl.className = 'message-metrics';
        metricsEl.textContent = `(${parts.join(', ')})`;
        this.currentAssistantMessage.parentElement.appendChild(metricsEl);
      }
      // Store cleaned text for TTS play button and append the button
      if (text) {
        this.currentAssistantMessage.dataset.ttsText = text;
        const playBtn = document.createElement('button');
        playBtn.className = 'tts-play-btn';
        playBtn.setAttribute('aria-label', 'Read aloud');
        playBtn.innerHTML = UI_ICONS.speaker(14);
        this.currentAssistantMessage.parentElement.appendChild(playBtn);
      }
      this.thinkBlockOpenStates.delete(this.currentAssistantMessage);
      this._clearStreamingText();
      delete this.currentAssistantMessage.dataset.rawText;
      this.currentAssistantMessage = null;
    }
  }

  appendToolUse(toolName, input, toolUseId) {
    this.hideThinkingIndicator();
    this.finishAssistantMessage();

    // Server contract says tool_use blocks always carry a name; omitempty
    // drops empty strings on the wire and Eve would otherwise interpolate
    // `undefined`. Fall back to a generic label.
    const displayName = toolName || 'tool';

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    messageEl.dataset.testid = 'message-tool-use';

    const inputDetail = input ? this._prettyJson(input) : '';

    messageEl.innerHTML = `
      <div class="message-content">
        <details class="tool-block tool-active">
          <summary>
            <div class="tool-spinner"></div>
            <span class="tool-name">${this.escapeHtml(displayName)}</span>
          </summary>
          ${inputDetail ? `<div class="tool-detail"><pre>${this.escapeHtml(inputDetail)}</pre></div>` : ''}
        </details>
      </div>
    `;
    this.messagesEl.appendChild(messageEl);
    this.currentToolBlock = messageEl.querySelector('.tool-block');
    if (toolUseId) {
      this.currentToolBlock.dataset.toolUseId = toolUseId;
    }
    this.updateThinkingIndicator(`Running ${displayName}...`);
    this.scrollToBottom();
  }

  /**
   * Create a parent Agent (sub-agent dispatch) block. Returns the body element
   * that a sub-renderer will target so all sidechain rendering nests inside.
   *
   * The block starts in the "open + running" state — header carries the
   * persona name and a spinner, body is empty until the sub-renderer starts
   * appending. Caller must invoke finalizeAgentBlock when the sidechain
   * completes to swap in the summary and auto-collapse.
   */
  appendAgentBlock(toolUseId, persona, description) {
    this.hideThinkingIndicator();
    this.finishAssistantMessage();

    const personaText = persona || 'sub-agent';

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    messageEl.dataset.testid = 'message-agent-block';

    messageEl.innerHTML = `
      <div class="message-content">
        <details class="tool-block agent-block agent-running" open>
          <summary>
            <div class="tool-spinner"></div>
            <span class="tool-name">Agent</span>
            <span class="agent-sep">·</span>
            <span class="agent-persona">${this.escapeHtml(personaText)}</span>
            <span class="agent-sep">·</span>
            <span class="agent-status">running…</span>
            <span class="agent-summary"></span>
          </summary>
          <div class="agent-body"></div>
        </details>
      </div>
    `;
    this.messagesEl.appendChild(messageEl);

    const blockEl = messageEl.querySelector('.tool-block');
    if (toolUseId) blockEl.dataset.toolUseId = toolUseId;
    blockEl.dataset.agentDescription = description || '';

    // Mark the block as user-toggled once the human clicks the summary, so
    // finalizeAgentBlock won't override their explicit open/closed state.
    blockEl.addEventListener('toggle', () => {
      if (blockEl.classList.contains('agent-complete')) {
        blockEl.dataset.userToggled = '1';
      }
    });

    const bodyEl = blockEl.querySelector('.agent-body');
    this.scrollToBottom();
    return { blockEl, bodyEl };
  }

  /**
   * Finalize a previously-created Agent block. Removes the spinner, rewrites
   * the header with summary stats, optionally adds a one-line preview of the
   * sub-agent's final result, and auto-collapses unless the user has already
   * manually toggled the block.
   */
  finalizeAgentBlock(toolUseId, finalContent, durationMs, toolCount) {
    const blockEl = this.findToolBlockById(toolUseId);
    if (!blockEl || !blockEl.classList.contains('agent-block')) return;
    blockEl.classList.remove('agent-running');
    blockEl.classList.add('agent-complete');

    // Spinner gone, status pill flips to checkmark.
    const spinner = blockEl.querySelector('.tool-spinner');
    if (spinner) spinner.remove();

    const statusEl = blockEl.querySelector('.agent-status');
    if (statusEl) {
      const tools = toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : '';
      const dur = (typeof durationMs === 'number' && durationMs > 0) ? `${(durationMs / 1000).toFixed(1)}s` : '';
      const stats = [tools, dur].filter(Boolean).join(', ');
      statusEl.textContent = stats || 'done';
    }

    // Pull a short preview of the final summary into the header.
    const summaryEl = blockEl.querySelector('.agent-summary');
    if (summaryEl) {
      const preview = this._extractAgentSummaryPreview(finalContent);
      if (preview) {
        summaryEl.textContent = ` — "${preview}"`;
      }
    }

    // Auto-collapse, but only if the user hasn't already explicitly toggled.
    if (!blockEl.dataset.userToggled) {
      blockEl.removeAttribute('open');
    }
  }

  /** Extract a short single-line preview from the sub-agent's tool_result content. */
  _extractAgentSummaryPreview(content) {
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const firstText = content.find(b => b?.type === 'text');
      text = firstText?.text || '';
    }
    if (!text) return '';
    const firstLine = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    return firstLine.length === 80 ? firstLine + '…' : firstLine;
  }

  appendUserMessage(text, files = []) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message user';
    messageEl.dataset.testid = 'message-user';

    // Strip voice mode instruction and dictation notice prefixes from display
    const displayText = text.replace(/^\[VOICE MODE\][^\n]*\n\n/, '').replace(/^\[DICTATED\][^\n]*\n\n/, '');

    let filesHtml = '';
    if (files.length > 0) {
      filesHtml = `<div class="message-files">${files.map(f =>
        `<span class="message-file">${this.escapeHtml(f.name)}</span>`
      ).join('')}</div>`;
    }

    messageEl.innerHTML = `<div class="message-content">${filesHtml}${this.escapeHtml(displayText)}</div>`;
    this.messagesEl.appendChild(messageEl);
    this.scrollToBottom();

    if (this.app.state.currentSessionId && !this.isRenderingHistory) {
      const history = this.app.state.sessionHistories.get(this.app.state.currentSessionId) || [];
      history.push({ role: 'user', content: text, files });
      this.app.state.sessionHistories.set(this.app.state.currentSessionId, history);
    }
  }

  appendSystemMessage(text, type = '') {
    const messageEl = document.createElement('div');
    messageEl.className = `message system ${type}`;
    messageEl.dataset.testid = 'message-system';
    messageEl.innerHTML = `<div class="message-content">${this.escapeHtml(text)}</div>`;
    this.messagesEl.appendChild(messageEl);
    this.scrollToBottom();
  }

  appendRawOutput(text) {
    if (this.currentAssistantMessage) {
      this.appendToAssistantMessage(text);
    } else {
      this.startAssistantMessage(text);
    }
  }

  clearMessages() {
    this._speakingMessageEl = null;
    this.messagesEl.innerHTML = '';
    this.currentAssistantMessage = null;
    this.currentToolBlock = null;
    this.thinkBlockOpenStates.clear();
    // Permission mode is per-session — clear the banner on session switches.
    this.setPermissionModeBanner('default');
  }

  /**
   * Show a banner indicating the active Claude Code permission mode. Hidden
   * for the default mode; visible (and color-coded) for bypass/plan/acceptEdits.
   * Called when the session emits a permission-mode event.
   */
  setPermissionModeBanner(mode) {
    if (this._lastPermissionMode === mode) return;
    this._lastPermissionMode = mode;
    const banner = document.getElementById('permissionModeBanner');
    if (!banner) return;
    const labels = {
      bypassPermissions: { text: '⚠ Bypass mode — all tools auto-approved', cls: 'mode-bypass' },
      acceptEdits:       { text: '✎ Accept-edits mode — file writes auto-approved', cls: 'mode-accept' },
      plan:              { text: '◇ Plan mode — model must propose a plan before acting', cls: 'mode-plan' },
    };
    banner.classList.remove('mode-bypass', 'mode-accept', 'mode-plan');
    const meta = labels[mode];
    if (!meta) {
      banner.classList.add('hidden');
      banner.textContent = '';
      return;
    }
    banner.classList.remove('hidden');
    banner.classList.add(meta.cls);
    banner.textContent = meta.text;
  }

  renderHistory(messages) {
    this.isRenderingHistory = true;
    this.clearMessages();

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.appendUserMessage(msg.content, msg.files || []);
      } else if (msg.role === 'assistant') {
        // v2: tool calls live inside content as tool_use blocks; there is no
        // separate toolCalls field. _renderAssistantBlocks renders all block
        // types (text, thinking, tool_use, agent_transcript).
        if (typeof msg.content === 'string') {
          this.startAssistantMessage(msg.content);
          this.finishAssistantMessage();
        } else if (Array.isArray(msg.content)) {
          this._renderAssistantBlocks(msg.content);
        }
      } else if (msg.role === 'tool') {
        // Pair the tool result back to its tool_use block (if rendered) and
        // append result content. Falls back to the historical generated-image
        // path when no tool_use_id is present.
        if (msg.toolUseId) {
          const content = this._parseStringMaybeJson(msg.content);
          this.appendToolResult(content, msg.toolUseId);
          this.markToolCompleteById(msg.toolUseId);
        } else {
          const imageResult = this._parseImageResult(msg.content);
          if (imageResult) {
            this._renderHistoryImage(imageResult);
          }
        }
      }
    }

    // Complete any trailing tool block and remove thinking indicator from history
    this.hideThinkingIndicator();
    this.renderMermaidBlocks(this.messagesEl);
    this.scrollToBottom();
    this.isRenderingHistory = false;

    // Restore in-progress assistant message saved before page refresh.
    // Rendered as a started (not finished) message so new streaming deltas
    // append to it if the model is still running.
    const sid = this.app.state.currentSessionId;
    if (sid) {
      try {
        const saved = sessionStorage.getItem(`eve-stream-${sid}`);
        if (saved) {
          this.startAssistantMessage(saved);
          // If model is still running, new deltas or message_complete will
          // continue/finalize. If model finished while disconnected, finalize
          // after a short grace period.
          this._streamRestoreTimer = setTimeout(() => {
            if (this.currentAssistantMessage &&
                this.currentAssistantMessage.dataset.rawText === saved) {
              this.finishAssistantMessage();
            }
          }, 5000);
        }
      } catch {}
    }
  }

  /**
   * Render an assistant message's content blocks during history replay.
   * Combines consecutive text and thinking blocks into a single message bubble
   * (with thinking wrapped in <think>…</think> tags so the existing parser
   * folds it). Tool_use blocks render as separate tool pills with their id
   * preserved so subsequent tool_result messages can pair correctly.
   * Agent_transcript blocks render as collapsed nested agent blocks with
   * their full sub-agent transcript replayed inside.
   */
  _renderAssistantBlocks(blocks) {
    let textBuf = '';
    const flushText = () => {
      if (!textBuf) return;
      this.startAssistantMessage(textBuf);
      this.finishAssistantMessage();
      textBuf = '';
    };
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'text':
          textBuf += block.text || '';
          break;
        case 'thinking':
          textBuf += '<think>\n' + (block.thinking || '') + '\n</think>\n\n';
          break;
        case 'redacted_thinking':
          textBuf += REDACTED_THINKING_PLACEHOLDER;
          break;
        case 'tool_use':
          flushText();
          this.appendToolUse(block.name, block.input, block.id);
          // Don't mark complete — a tool message will arrive with the result.
          break;
        case 'agent_transcript':
          flushText();
          this._renderAgentTranscript(block);
          break;
        // Other block types (server_tool_use, etc.) silently skipped for now.
      }
    }
    flushText();
  }

  /**
   * Render a persisted sub-agent transcript as a collapsed Agent block with
   * its full nested thread reconstructed inside. Replays each sub-message
   * through the same renderer logic via a sub-renderer targeting the agent
   * block's body.
   */
  _renderAgentTranscript(block) {
    const persona = block.persona || 'sub-agent';
    // Synthesize a deterministic toolUseId for replayed agent blocks if the
    // backend didn't pair this transcript to its parent tool_use_id (the
    // current backend doesn't — temporal pairing happens server-side via
    // mtime). Use the agentId as a stable identifier.
    const fakeToolUseId = `replay-agent-${block.agentId || ''}`;
    const { bodyEl } = this.appendAgentBlock(fakeToolUseId, persona, '');

    const subRenderer = new MessageRenderer(this.container, { targetEl: bodyEl });
    subRenderer.isRenderingHistory = true;

    const messages = Array.isArray(block.messages) ? block.messages : [];
    let toolCount = 0;
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const content = m.content;
      if (m.role === 'assistant') {
        if (typeof content === 'string') {
          subRenderer.startAssistantMessage(content);
          subRenderer.finishAssistantMessage();
        } else if (Array.isArray(content)) {
          subRenderer._renderAssistantBlocks(content);
          for (const b of content) {
            if (b?.type === 'tool_use') toolCount++;
          }
        }
      } else if (m.role === 'user') {
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool_result' && b.tool_use_id) {
              const inner = (typeof b.content === 'string') ? b.content : b.content;
              subRenderer.appendToolResult(inner, b.tool_use_id);
              subRenderer.markToolCompleteById(b.tool_use_id);
            }
          }
        }
      }
    }

    // Finalize the agent block: collapsed by default with a tool count.
    // Final summary preview is best-effort — pull last assistant text block.
    const finalSummary = this._extractFinalSummary(messages);
    this.finalizeAgentBlock(fakeToolUseId, finalSummary, 0, toolCount);
  }

  /** Pull the most recent assistant text out of a sidechain transcript. */
  _extractFinalSummary(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== 'assistant') continue;
      if (Array.isArray(m.content)) {
        for (let j = m.content.length - 1; j >= 0; j--) {
          if (m.content[j]?.type === 'text' && m.content[j].text) return m.content[j].text;
        }
      } else if (typeof m.content === 'string') {
        return m.content;
      }
    }
    return '';
  }

  /** Best-effort coerce a tool result content into either a string or an
   *  Anthropic content array. Pass strings through; parse JSON arrays. */
  _parseStringMaybeJson(content) {
    if (Array.isArray(content)) return content;
    if (typeof content !== 'string') return content;
    if (content.startsWith('[') || content.startsWith('{')) {
      try { return JSON.parse(content); } catch {}
    }
    return content;
  }

  showThinkingIndicator(text = 'Thinking...') {
    // Only remove the DOM element — don't call hideThinkingIndicator() which
    // also calls markToolComplete() and would clear the active tool block.
    const existing = document.getElementById('thinkingIndicator');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'thinking-indicator';
    el.id = 'thinkingIndicator';
    el.dataset.testid = 'thinking-indicator';
    el.innerHTML = `<div class="thinking-spinner"></div><span class="thinking-text">${this.escapeHtml(text)}</span>`;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  updateThinkingIndicator(text) {
    const el = document.getElementById('thinkingIndicator');
    if (el) {
      const textEl = el.querySelector('.thinking-text');
      if (textEl) textEl.textContent = text;
    } else {
      this.showThinkingIndicator(text);
    }
  }

  hideThinkingIndicator() {
    this.markToolComplete();
    const el = document.getElementById('thinkingIndicator');
    if (el) el.remove();
  }

  updateToolInput(input) {
    if (!this.currentToolBlock || !input) return;
    const existing = this.currentToolBlock.querySelector('.tool-input');
    let summary = '';
    if (typeof input === 'string') {
      summary = input.substring(0, 100);
    } else if (input.command) {
      summary = input.command.substring(0, 100);
    } else if (input.file_path) {
      summary = input.file_path;
    } else if (input.pattern) {
      summary = input.pattern;
    } else {
      const firstVal = Object.values(input).find(v => typeof v === 'string');
      if (firstVal) summary = firstVal.substring(0, 100);
    }
    if (!summary) return;
    if (existing) {
      existing.textContent = summary;
    } else {
      const span = document.createElement('span');
      span.className = 'tool-input';
      span.textContent = summary;
      this.currentToolBlock.appendChild(span);
    }
  }

  renderQuestionBlock(questions, onSelect) {
    this.hideThinkingIndicator();

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';

    let html = '<div class="message-content">';
    for (const q of questions) {
      html += `<p>${this.escapeHtml(q.question)}</p>`;
      html += '<div class="question-options">';
      for (const opt of (q.options || [])) {
        html += `<button class="question-option" data-label="${this.escapeHtml(opt.label)}">`;
        html += `<span class="question-option-label">${this.escapeHtml(opt.label)}</span>`;
        if (opt.description) {
          html += `<span class="question-option-desc">${this.escapeHtml(opt.description)}</span>`;
        }
        html += '</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    messageEl.innerHTML = html;

    // Wire up option buttons
    messageEl.querySelectorAll('.question-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const label = btn.dataset.label;
        // Disable all option buttons
        messageEl.querySelectorAll('.question-option').forEach(b => {
          b.disabled = true;
          if (b === btn) b.classList.add('selected');
        });
        onSelect(label);
      });
    });

    this.messagesEl.appendChild(messageEl);
    this.scrollToBottom();
  }

  /**
   * Append a tool_result panel to the matching tool block. If toolUseId is
   * provided, the block is found by data-tool-use-id (Claude path); otherwise
   * we use the currently-active tool block (chat-base path).
   *
   * Content can be:
   *   - a string (plain text result, possibly JSON)
   *   - an array of Anthropic content blocks: [{type:"text"}, {type:"image", source:{...}}]
   */
  appendToolResult(content, toolUseId) {
    const block = this.findToolBlockById(toolUseId) || this.currentToolBlock;
    if (!block) return;
    if (block.querySelector('.tool-result')) return;

    const el = document.createElement('div');
    el.className = 'tool-result';

    let renderedImage = false;

    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'image' && part.source?.type === 'base64' && part.source?.data) {
          const img = document.createElement('img');
          img.className = 'tool-result-image';
          const mime = part.source.media_type || 'image/png';
          img.src = `data:${mime};base64,${part.source.data}`;
          img.loading = 'lazy';
          img.addEventListener('click', () => this._openImageFullscreen(img.src, 'Tool result'));
          el.appendChild(img);
          renderedImage = true;
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          // Wrapped CLIs (Claude, pi) deliver generate_image's JSON inside a
          // text block; same shape relayLLM-native sessions deliver as plain
          // string content. _renderResultText handles both.
          renderedImage = this._renderResultText(el, part.text) || renderedImage;
        } else {
          const pre = document.createElement('pre');
          pre.textContent = this._prettyJson(part);
          el.appendChild(pre);
        }
      }
    } else {
      renderedImage = this._renderResultText(el, content) || renderedImage;
    }
    block.appendChild(el);
    // Auto-expand the collapsed <details> tool block when a generated image
    // was rendered — otherwise the user sees a clickable pill with no hint
    // that a picture is hidden inside. `open` is a no-op on non-<details>.
    if (renderedImage) {
      block.open = true;
    }
  }

  /** Render a tool_result text payload, detecting the ComfyUI generate_image
   *  JSON shape and rendering it inline. Returns true if an image was rendered,
   *  false if it fell through to the raw-text/JSON-pretty fallback. */
  _renderResultText(el, text) {
    const imageResult = this._parseImageResult(text);
    if (imageResult) {
      this._renderInlineImage(el, imageResult);
      return true;
    }
    const pre = document.createElement('pre');
    pre.textContent = (typeof text === 'string') ? text : this._prettyJson(text);
    el.appendChild(pre);
    return false;
  }

  updateToolProgress(toolName, message) {
    if (!this.currentToolBlock) return;
    const spinner = this.currentToolBlock.querySelector('.tool-spinner');
    if (spinner) {
      const textEl = spinner.parentElement?.querySelector('.tool-status-text') ||
                     spinner.nextElementSibling;
      if (textEl) {
        textEl.textContent = message;
      }
    }
    // Also update the thinking indicator if visible
    const thinkingText = document.querySelector('#thinkingIndicator .thinking-text');
    if (thinkingText) {
      thinkingText.textContent = message;
    }
  }

  /** Locate a rendered tool block by its tool_use_id. Scoped to this
   *  renderer's container so sub-renderers find their own blocks. */
  findToolBlockById(toolUseId) {
    if (!toolUseId) return null;
    return this.messagesEl.querySelector(
      `.tool-block[data-tool-use-id="${CSS.escape(toolUseId)}"]`
    );
  }

  markToolComplete() {
    this._clearToolBlockSpinner(this.currentToolBlock);
    this.currentToolBlock = null;
  }

  /** Mark a specific tool block complete by tool_use_id. Required when the
   *  matching tool isn't the most recent one (multi-tool assistant turns). */
  markToolCompleteById(toolUseId) {
    const block = this.findToolBlockById(toolUseId);
    if (!block) return;
    this._clearToolBlockSpinner(block);
    if (block === this.currentToolBlock) this.currentToolBlock = null;
  }

  /** Indicate to the user which tool block triggered a permission request,
   *  scrolling it into view. Pair with clearToolPermissionPending. */
  markToolPermissionPending(toolUseId) {
    const block = this.findToolBlockById(toolUseId);
    if (!block) return;
    block.classList.add('tool-permission-pending');
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  clearToolPermissionPending(toolUseId) {
    const block = this.findToolBlockById(toolUseId);
    if (block) block.classList.remove('tool-permission-pending');
  }

  _clearToolBlockSpinner(block) {
    if (!block) return;
    block.classList.remove('tool-active');
    const spinner = block.querySelector('.tool-spinner');
    if (spinner) spinner.remove();
  }

  // --- Image generation helpers ---

  _parseImageResult(content) {
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      if (parsed && parsed.image_url && parsed.status === 'success') {
        return parsed;
      }
    } catch {}
    return null;
  }

  _renderInlineImage(container, imageResult) {
    const img = document.createElement('img');
    img.className = 'generated-image';
    img.src = imageResult.image_url;
    img.alt = imageResult.prompt || 'Generated image';
    img.loading = 'lazy';
    img.addEventListener('click', () => this._openImageFullscreen(img.src, imageResult.prompt));
    img.addEventListener('error', () => {
      img.replaceWith(this._createImageErrorPlaceholder());
    });
    container.appendChild(img);

    const parts = [];
    if (imageResult.generation_time) parts.push(imageResult.generation_time);
    if (imageResult.width && imageResult.height) parts.push(`${imageResult.width}x${imageResult.height}`);
    if (imageResult.seed && imageResult.seed !== -1) parts.push(`seed: ${imageResult.seed}`);
    if (parts.length > 0) {
      const meta = document.createElement('div');
      meta.className = 'generated-image-meta';
      meta.textContent = parts.join(' | ');
      container.appendChild(meta);
    }
  }

  _renderHistoryImage(imageResult) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    const content = document.createElement('div');
    content.className = 'message-content';
    this._renderInlineImage(content, imageResult);
    messageEl.appendChild(content);
    this.messagesEl.appendChild(messageEl);
  }

  _openImageFullscreen(src, alt) {
    const overlay = document.createElement('div');
    overlay.className = 'image-fullscreen-overlay';
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt || 'Generated image';
    overlay.appendChild(img);
    const cleanup = () => {
      overlay.remove();
      document.removeEventListener('keydown', keyHandler);
    };
    overlay.addEventListener('click', cleanup);
    const keyHandler = (e) => { if (e.key === 'Escape') cleanup(); };
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(overlay);
  }

  _createImageErrorPlaceholder() {
    const div = document.createElement('div');
    div.className = 'generated-image-error';
    div.textContent = 'Image no longer available';
    return div;
  }

  _upgradeGeneratedImages(container) {
    container.querySelectorAll(`img[src*="${GENERATED_PATH}"]`).forEach(img => {
      img.className = 'generated-image';
      img.loading = 'lazy';
      img.addEventListener('click', () => this._openImageFullscreen(img.src, img.alt));
      // If the model mis-transcribed the URL the image will 404. Silently
      // drop the broken element (and its empty wrapping <p>) so the prose
      // doesn't leave a broken-image icon or a paragraph-shaped gap. The
      // real fix is server-side filename stability (see SaveOutput).
      img.addEventListener('error', () => {
        const parent = img.parentElement;
        img.remove();
        if (parent && parent.tagName === 'P' && parent.children.length === 0 && !parent.textContent.trim()) {
          parent.remove();
        }
      });
    });
    // Wrapped CLIs (Claude Haiku) phrase the result as a "View image" link
    // rather than an inline `![](url)`. Hijack the click so it opens our
    // fullscreen overlay (ESC to close) instead of a separate browser tab —
    // visually consistent with how clicking the inline image behaves.
    container.querySelectorAll(`a[href^="${GENERATED_PATH}"]`).forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        this._openImageFullscreen(a.href, a.textContent || 'Generated image');
      });
    });
  }

  async renderMermaidBlocks(container) {
    if (typeof mermaid === 'undefined') return;
    const nodes = container.querySelectorAll('code[class*="mermaid"]');
    if (nodes.length === 0) return;
    for (const node of nodes) {
      const pre = node.parentElement;
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = node.textContent;
      pre.replaceWith(div);
    }
    try {
      await mermaid.run({ nodes: container.querySelectorAll('.mermaid') });
    } catch (err) {
      this.log.error('Mermaid render failed:', err);
    }
  }

  // --- Formatting utilities ---

  formatText(text) {
    // Fallback if marked/DOMPurify not loaded
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      let safe = this.escapeHtml(text);
      safe = safe.replace(/\n/g, '<br>');
      return safe;
    }

    // Extract think blocks before markdown parsing
    const thinkBlocks = [];
    let processed = text;

    // Repair lost <think> tag (e.g., page refresh mid-stream loses the opening tag)
    if (!processed.includes('<think>') && processed.includes('</think>')) {
      processed = '<think>' + processed;
    }

    // Complete think blocks
    processed = processed.replace(
      /<think>([\s\S]*?)<\/think>/g,
      (match, content) => {
        const trimmed = content.trim();
        if (!trimmed) return '';
        const idx = thinkBlocks.length;
        thinkBlocks.push(
          `<details class="think-block"><summary>Thinking</summary><div class="think-content">${this.escapeHtml(trimmed)}</div></details>`
        );
        return `\n%%THINK_${idx}%%\n`;
      }
    );

    // Unclosed think block (still streaming)
    processed = processed.replace(
      /<think>([\s\S]*)$/,
      (match, content) => {
        const trimmed = content.trim();
        if (!trimmed) return '';
        const idx = thinkBlocks.length;
        const label = this.isStreaming ? 'Thinking...' : 'Thinking';
        thinkBlocks.push(
          `<details class="think-block"><summary>${label}</summary><div class="think-content">${this.escapeHtml(trimmed)}</div></details>`
        );
        return `\n%%THINK_${idx}%%\n`;
      }
    );

    // Auto-inline /api/generated/ URLs that models mention in prose. Skip
    // markdown link URLs `[label](/api/generated/foo.png)` — the leading `(`
    // would otherwise match as a prefix and we'd rewrite the inner URL into
    // `![](url)`, producing `[label](![](url))` which marked then mangles
    // into a URL-encoded broken link.
    processed = processed.replace(
      /(^|[\s(\[])(\/api\/generated\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif))(?![A-Za-z0-9._-])/g,
      (match, prefix, url, offset, full) => {
        if (prefix === '(' && offset > 0 && full[offset - 1] === ']') return match;
        return `${prefix}![](${url})`;
      }
    );

    // Parse markdown and sanitize. Only allow images from our own generated
    // image endpoint — LLMs sometimes hallucinate external URLs (imgur, etc.)
    // which are not real and should not be rendered.
    let html = marked.parse(processed, { breaks: true, gfm: true });
    html = DOMPurify.sanitize(html, {
      ADD_TAGS: ['img'],
      ADD_ATTR: ['src', 'alt', 'loading'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
    // Remove any <img> not pointing at our own /api/generated/ path,
    // and force generated-image links to open in a new tab so the chat
    // session isn't replaced when the user clicks through.
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith(GENERATED_PATH)) {
        img.remove();
      }
    });
    // Open every link in a new tab and sever the opener reference. Protects
    // against reverse tabnabbing (window.opener hijack) and stops a click from
    // navigating the SPA away from the live session. See audit L4.
    tmp.querySelectorAll('a[href]').forEach(a => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    html = tmp.innerHTML;

    // Restore think block placeholders
    for (let i = 0; i < thinkBlocks.length; i++) {
      html = html.replace(`%%THINK_${i}%%`, thinkBlocks[i]);
    }

    return html;
  }

  _prettyJson(value) {
    if (typeof value === 'string') {
      try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
    }
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
