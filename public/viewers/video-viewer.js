/**
 * VideoViewer - renders video files with native HTML5 <video> controls.
 */
class VideoViewer {
  constructor() {
    this.extensions = new Set(['mp4', 'webm', 'ogv', 'mov']);
  }

  canHandle(ext) {
    return this.extensions.has(ext);
  }

  render(canvas, { url, filename }) {
    canvas.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-video';

    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.preload = 'metadata';
    video.title = filename;

    video.addEventListener('error', () => {
      wrapper.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'viewer-error';
      err.textContent = 'Failed to load video';
      wrapper.appendChild(err);
    });

    wrapper.appendChild(video);
    canvas.appendChild(wrapper);
  }

  destroy(canvas) {
    // Pause video to stop playback when switching away
    const video = canvas.querySelector('video');
    if (video) video.pause();
    canvas.innerHTML = '';
  }
}
