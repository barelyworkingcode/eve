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
    this.scrollToBottom();
  }

  updateAssistantMessage(text) {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage(text);
    } else {
      this.currentAssistantMessage.innerHTML = this.formatText(text);
      this.scrollToBottom();
    }
  }

  appendToAssistantMessage(text) {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage(text);
    } else {
      const currentText = this.currentAssistantMessage.dataset.rawText || '';
      const newText = currentText + text;
      this.currentAssistantMessage.dataset.rawText = newText;
      this.currentAssistantMessage.innerHTML = this.formatText(newText);
      this.scrollToBottom();
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
      }
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

    let filesHtml = '';
    if (files.length > 0) {
      filesHtml = `<div class="message-files">${files.map(f =>
        `<span class="message-file">${this.escapeHtml(f.name)}</span>`
      ).join('')}</div>`;
    }

    messageEl.innerHTML = `<div class="message-content">${filesHtml}${this.escapeHtml(text)}</div>`;
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

  renderHistory(messages) {
    this.app.isRenderingHistory = true;
    this.app.elements.messages.innerHTML = '';
    this.currentAssistantMessage = null;

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.appendUserMessage(msg.content, msg.files || []);
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
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

    this.scrollToBottom();
    this.app.isRenderingHistory = false;
  }

  showThinkingIndicator(text = 'Thinking...') {
    this.hideThinkingIndicator();
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

  markToolComplete() {
    if (this.currentToolBlock) {
      this.currentToolBlock.classList.remove('tool-active');
      const spinner = this.currentToolBlock.querySelector('.tool-spinner');
      if (spinner) spinner.remove();
      this.currentToolBlock = null;
    }
  }

  // --- Formatting utilities ---

  formatText(text) {
    let formatted = this.escapeHtml(text);

    // Complete think blocks: <think>content</think>
    formatted = formatted.replace(
      /&lt;think&gt;([\s\S]*?)&lt;\/think&gt;/g,
      (match, content) => {
        const trimmed = content.trim();
        if (!trimmed) return '';
        const openAttr = this.isStreaming ? ' open' : '';
        return `<details class="think-block"${openAttr}><summary>Thinking</summary><div class="think-content">${trimmed}</div></details>`;
      }
    );

    // Unclosed think block (still streaming)
    formatted = formatted.replace(
      /&lt;think&gt;([\s\S]*)$/,
      (match, content) => {
        const trimmed = content.trim();
        if (!trimmed) return '';
        return '<details class="think-block" open><summary>Thinking...</summary><div class="think-content">' + trimmed + '</div></details>';
      }
    );

    formatted = formatted.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\n/g, '<br>');
    return formatted;
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
