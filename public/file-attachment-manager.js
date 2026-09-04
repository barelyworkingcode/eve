/**
 * FileAttachmentManager - handles file selection, reading, drag/drop, paste,
 * and rendering of attached files for chat input.
 */
class FileAttachmentManager {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.container = container;
    this.files = [];
    this.button = null;
  }

  /**
   * Wires the attach button and the static input-row markup it depends on.
   * Called from the render closure at renderSlots() time, when #fileInput,
   * #userInput and #attachedFiles (static index.html markup) and #attachBtn
   * (just created) all exist.
   */
  init(button) {
    this.button = button;
    this.fileInput = document.getElementById('fileInput');
    this.input = document.getElementById('userInput');
    this.attachedFilesEl = document.getElementById('attachedFiles');

    this.button.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => {
      this.addFiles(Array.from(e.target.files));
      e.target.value = '';
    });

    // Paste images
    this.input.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const ext = item.type.split('/')[1] || 'png';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            file.customName = `pasted-${timestamp}.${ext}`;
            this.addFiles([file]);
          }
        }
      }
    });

    // Drag and drop on input
    this.input.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.input.classList.add('dragover');
    });
    this.input.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.input.classList.remove('dragover');
    });
    this.input.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.input.classList.remove('dragover');
      this.addFiles(Array.from(e.dataTransfer.files));
    });
  }

  /** State-sync: called by app._updateChatInputCapabilities. */
  setAvailable(available) {
    if (this.button) this.button.hidden = !available;
  }

  async addFiles(files) {
    for (const file of files) {
      if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
        this.container.get('messageRenderer').appendSystemMessage(`Skipped unsupported file type: ${file.name}`, 'error');
        continue;
      }
      try {
        const isImage = file.type.startsWith('image/');
        const content = isImage
          ? await this.readFileAsDataURL(file)
          : await this.readFileAsText(file);
        this.files.push({
          name: file.customName || file.name,
          content,
          type: isImage ? 'image' : 'text',
          mediaType: file.type
        });
      } catch (err) {
        this.container.get('messageRenderer').appendSystemMessage(`Failed to read file: ${file.name}`, 'error');
      }
    }
    this.render();
  }

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  render() {
    const container = this.attachedFilesEl;
    if (this.files.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = this.files.map((f, i) => {
      const isImage = f.type === 'image';
      const thumbnail = isImage ? `<img class="file-thumbnail" src="${f.content}" alt="">` : '';
      const icon = isImage ? '' : '<span class="file-icon">&#128196;</span>';
      return `
        <div class="attached-file ${isImage ? 'attached-image' : ''}">
          ${thumbnail}${icon}
          <span class="file-name">${this.container.get('messageRenderer').escapeHtml(f.name)}</span>
          <button type="button" class="file-remove" data-index="${i}">&times;</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.file-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.files.splice(index, 1);
        this.render();
      });
    });
  }

  /** Returns current files and clears the list */
  consumeFiles() {
    const files = [...this.files];
    this.files = [];
    this.render();
    return files;
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileAttachmentManager;
}
