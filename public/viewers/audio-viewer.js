/**
 * AudioViewer - renders audio files with native HTML5 <audio> controls
 * and a visual icon centered in the canvas.
 */
class AudioViewer {
  constructor() {
    this.extensions = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma']);
  }

  canHandle(ext) {
    return this.extensions.has(ext);
  }

  render(canvas, { url, filename }) {
    canvas.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-audio';

    // Audio icon
    const icon = document.createElement('div');
    icon.className = 'viewer-audio__icon';
    icon.innerHTML = `<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>`;

    const name = document.createElement('div');
    name.className = 'viewer-audio__name';
    name.textContent = filename;

    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    audio.preload = 'metadata';

    audio.addEventListener('error', () => {
      wrapper.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'viewer-error';
      err.textContent = 'Failed to load audio';
      wrapper.appendChild(err);
    });

    wrapper.appendChild(icon);
    wrapper.appendChild(name);
    wrapper.appendChild(audio);
    canvas.appendChild(wrapper);
  }

  destroy(canvas) {
    const audio = canvas.querySelector('audio');
    if (audio) audio.pause();
    canvas.innerHTML = '';
  }
}
