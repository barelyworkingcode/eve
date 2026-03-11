/**
 * FileAttachmentManager - handles file selection, reading, drag/drop, paste,
 * and rendering of attached files for chat input.
 */
class FileAttachmentManager {
  constructor(client) {
    this.client = client;
    this.files = [];
    this.initEventListeners();
  }

  initEventListeners() {
    const els = this.client.elements;

    els.attachBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', (e) => {
      this.addFiles(Array.from(e.target.files));
      e.target.value = '';
    });

    // Paste images
    els.userInput.addEventListener('paste', (e) => {
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
    els.userInput.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.userInput.classList.add('dragover');
    });
    els.userInput.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.userInput.classList.remove('dragover');
    });
    els.userInput.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.userInput.classList.remove('dragover');
      this.addFiles(Array.from(e.dataTransfer.files));
    });
  }

  async addFiles(files) {
    for (const file of files) {
      if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
        this.client.messageRenderer.appendSystemMessage(`Skipped unsupported file type: ${file.name}`, 'error');
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
        this.client.messageRenderer.appendSystemMessage(`Failed to read file: ${file.name}`, 'error');
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
    const container = this.client.elements.attachedFiles;
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
          <span class="file-name">${this.client.messageRenderer.escapeHtml(f.name)}</span>
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
