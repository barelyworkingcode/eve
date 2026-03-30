/**
 * Chat message rendering: user messages, assistant messages, tool use,
 * system messages, thinking indicator, text formatting.
 */
class MessageRenderer {
  constructor(app) {
    this.app = app;
    this.currentAssistantMessage = null;
    this.currentToolBlock = null;
    this.isStreaming = false;
    this.thinkBlockOpenStates = new Map(); // messageEl -> Set of open indices

    // Delegated mousedown handler for think-block summaries.
    // Uses mousedown (not click) because during streaming, innerHTML replacement
    // destroys elements between mousedown and mouseup, preventing click from firing.
    // The native <details> toggle still works for completed messages via the
    // normal click path; during streaming, _applyThinkBlockStates() restores
    // the tracked state after each innerHTML replacement.
    this.app.elements.messages.addEventListener('mousedown', (e) => {
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
  }

  startAssistantMessage(text) {
    this.hideThinkingIndicator();
    this.markToolComplete();
    this.finishAssistantMessage();

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    messageEl.innerHTML = `<div class="message-content">${this.formatText(text)}</div>`;
    this.app.elements.messages.appendChild(messageEl);
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
    const sid = this.app.currentSessionId;
    if (sid && !this.app.isRenderingHistory) {
      try { sessionStorage.setItem(`eve-stream-${sid}`, text); } catch {}
    }
  }

  _clearStreamingText() {
    const sid = this.app.currentSessionId;
    if (sid && !this.app.isRenderingHistory) {
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

  finishAssistantMessage() {
    this.markToolComplete();
    if (this.currentAssistantMessage) {
      const text = this.currentAssistantMessage.dataset.rawText;
      if (text && this.app.currentSessionId && !this.app.isRenderingHistory) {
        const history = this.app.sessionHistories.get(this.app.currentSessionId) || [];
        history.push({
          role: 'assistant',
          content: [{ type: 'text', text }]
        });
        this.app.sessionHistories.set(this.app.currentSessionId, history);
      }
      // Re-render with isStreaming=false to collapse think blocks
      if (text) {
        this.isStreaming = false;
        this.currentAssistantMessage.innerHTML = this.formatText(text);
        this._applyThinkBlockStates();
        this.renderMermaidBlocks(this.currentAssistantMessage);
      }
      this.thinkBlockOpenStates.delete(this.currentAssistantMessage);
      this._clearStreamingText();
      delete this.currentAssistantMessage.dataset.rawText;
      this.currentAssistantMessage = null;
    }
  }

  appendToolUse(toolName, input) {
    this.hideThinkingIndicator();
    this.finishAssistantMessage();

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';

    let inputSummary = '';
    if (input) {
      if (typeof input === 'string') {
        inputSummary = input.substring(0, 100);
      } else if (input.command) {
        inputSummary = input.command.substring(0, 100);
      } else if (input.file_path) {
        inputSummary = input.file_path;
      } else if (input.pattern) {
        inputSummary = input.pattern;
      }
    }

    messageEl.innerHTML = `
      <div class="message-content">
        <div class="tool-use tool-active">
          <div class="tool-spinner"></div>
          <span class="tool-name">${this.escapeHtml(toolName)}</span>
          ${inputSummary ? `<span class="tool-input">${this.escapeHtml(inputSummary)}</span>` : ''}
        </div>
      </div>
    `;
    this.app.elements.messages.appendChild(messageEl);
    this.currentToolBlock = messageEl.querySelector('.tool-use');
    this.updateThinkingIndicator(`Running ${toolName}...`);
    this.scrollToBottom();
  }

  appendUserMessage(text, files = []) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message user';

    // Strip voice mode instruction prefix from display
    const displayText = text.replace(/^\[VOICE MODE\][^\n]*\n\n/, '');

    let filesHtml = '';
    if (files.length > 0) {
      filesHtml = `<div class="message-files">${files.map(f =>
        `<span class="message-file">${this.escapeHtml(f.name)}</span>`
      ).join('')}</div>`;
    }

    messageEl.innerHTML = `<div class="message-content">${filesHtml}${this.escapeHtml(displayText)}</div>`;
    this.app.elements.messages.appendChild(messageEl);
    this.scrollToBottom();

    if (this.app.currentSessionId && !this.app.isRenderingHistory) {
      const history = this.app.sessionHistories.get(this.app.currentSessionId) || [];
      history.push({ role: 'user', content: text, files });
      this.app.sessionHistories.set(this.app.currentSessionId, history);
    }
  }

  appendSystemMessage(text, type = '') {
    const messageEl = document.createElement('div');
    messageEl.className = `message system ${type}`;
    messageEl.innerHTML = `<div class="message-content">${this.escapeHtml(text)}</div>`;
    this.app.elements.messages.appendChild(messageEl);
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
    this.app.elements.messages.innerHTML = '';
    this.currentAssistantMessage = null;
    this.currentToolBlock = null;
    this.thinkBlockOpenStates.clear();
  }

  renderHistory(messages) {
    this.app.isRenderingHistory = true;
    this.clearMessages();

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.appendUserMessage(msg.content, msg.files || []);
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          this.startAssistantMessage(msg.content);
          this.finishAssistantMessage();
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              this.startAssistantMessage(block.text);
              this.finishAssistantMessage();
            } else if (block.type === 'tool_use') {
              this.appendToolUse(block.name, block.input);
            }
          }
        }
      }
    }

    // Complete any trailing tool block and remove thinking indicator from history
    this.hideThinkingIndicator();
    this.renderMermaidBlocks(this.app.elements.messages);
    this.scrollToBottom();
    this.app.isRenderingHistory = false;

    // Restore in-progress assistant message saved before page refresh.
    // Rendered as a started (not finished) message so new streaming deltas
    // append to it if the model is still running.
    const sid = this.app.currentSessionId;
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

  showThinkingIndicator(text = 'Thinking...') {
    // Only remove the DOM element — don't call hideThinkingIndicator() which
    // also calls markToolComplete() and would clear the active tool block.
    const existing = document.getElementById('thinkingIndicator');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'thinking-indicator';
    el.id = 'thinkingIndicator';
    el.innerHTML = `<div class="thinking-spinner"></div><span class="thinking-text">${this.escapeHtml(text)}</span>`;
    this.app.elements.messages.appendChild(el);
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

    this.app.elements.messages.appendChild(messageEl);
    this.scrollToBottom();
  }

  markToolComplete() {
    if (this.currentToolBlock) {
      this.currentToolBlock.classList.remove('tool-active');
      const spinner = this.currentToolBlock.querySelector('.tool-spinner');
      if (spinner) spinner.remove();
      this.currentToolBlock = null;
    }
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
      console.error('Mermaid render failed:', err);
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

    // Parse markdown and sanitize
    let html = marked.parse(processed, { breaks: true, gfm: true });
    html = DOMPurify.sanitize(html);

    // Restore think block placeholders
    for (let i = 0; i < thinkBlocks.length; i++) {
      html = html.replace(`%%THINK_${i}%%`, thinkBlocks[i]);
    }

    return html;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    this.app.elements.messages.scrollTop = this.app.elements.messages.scrollHeight;
  }
}
