// <iframe>, not <embed>/<object>: Chrome, Safari and Firefox all give it
// native PDF rendering, which is what this relies on.
class PdfViewer {
  constructor() {
    this.extensions = new Set(['pdf']);
  }

  canHandle(ext) {
    return this.extensions.has(ext);
  }

  render(canvas, { url }) {
    canvas.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-pdf';

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = 'PDF Viewer';

    wrapper.appendChild(iframe);
    canvas.appendChild(wrapper);
  }

  destroy(canvas) {
    canvas.innerHTML = '';
  }
}
