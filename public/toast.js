// No other module touches toast DOM directly.
class ToastManager {
  constructor(container) {
    this.bus = container.get('bus');
    this._toasts = new Map();
    this._container = null;
    this._initContainer();
    this._subscribe();
  }

  _initContainer() {
    this._container = document.createElement('div');
    this._container.className = 'toast-container';
    document.body.appendChild(this._container);
  }

  _subscribe() {
    this.bus.on(EVT.TOAST_SHOW, (data) => this._show(data));
    this.bus.on(EVT.TOAST_UPDATE, (data) => this._update(data));
    this.bus.on(EVT.TOAST_DISMISS, (data) => this._dismiss(data.id));
  }

  _show({ id, message, type = 'info', progress, persistent = false, duration = 5000 }) {
    if (this._toasts.has(id)) {
      this._update({ id, message, progress, type });
      return;
    }

    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.dataset.toastId = id;

    const content = document.createElement('div');
    content.className = 'toast__content';

    const msg = document.createElement('span');
    msg.className = 'toast__message';
    msg.textContent = message;
    content.appendChild(msg);

    const close = document.createElement('button');
    close.className = 'toast__close';
    close.innerHTML = '&times;';
    close.addEventListener('click', () => this._dismiss(id));
    content.appendChild(close);

    el.appendChild(content);

    if (progress !== undefined) {
      const bar = document.createElement('div');
      bar.className = 'toast__progress';
      const fill = document.createElement('div');
      fill.className = 'toast__progress-fill';
      fill.style.width = `${progress}%`;
      bar.appendChild(fill);
      el.appendChild(bar);
    }

    this._container.appendChild(el);

    let timer = null;
    if (!persistent) {
      timer = setTimeout(() => this._dismiss(id), duration);
    }

    this._toasts.set(id, { el, timer });
  }

  _update({ id, message, progress, type }) {
    const entry = this._toasts.get(id);
    if (!entry) return;

    const { el } = entry;

    if (message !== undefined) {
      const msg = el.querySelector('.toast__message');
      if (msg) msg.textContent = message;
    }

    if (progress !== undefined) {
      let fill = el.querySelector('.toast__progress-fill');
      if (fill) {
        fill.style.width = `${progress}%`;
      } else {
        const bar = document.createElement('div');
        bar.className = 'toast__progress';
        fill = document.createElement('div');
        fill.className = 'toast__progress-fill';
        fill.style.width = `${progress}%`;
        bar.appendChild(fill);
        el.appendChild(bar);
      }
    }

    if (type !== undefined) {
      el.className = `toast toast--${type}`;
    }
  }

  _dismiss(id) {
    const entry = this._toasts.get(id);
    if (!entry) return;

    const { el, timer } = entry;
    if (timer) clearTimeout(timer);

    el.classList.add('toast--exiting');
    el.addEventListener('animationend', () => {
      el.remove();
      this._toasts.delete(id);
    }, { once: true });

    // Fallback removal if animation doesn't fire
    setTimeout(() => {
      if (this._toasts.has(id)) {
        el.remove();
        this._toasts.delete(id);
      }
    }, 400);
  }
}
