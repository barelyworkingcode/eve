// "Remote sessions": the persistent (tmux) terminals a host project has left
// running on its host, listed by relay (GET /api/projects/:id/persistent-sessions,
// ../relay/docs/ssh-hosts.md). Shared by the shell launcher and the New
// Terminal picker; each open builds a fresh instance.
class RemoteSessionsSection {
  // onReattach(session) launches session.template_id with persistSession =
  // session.name; the caller owns the create path and closing its dialog.
  constructor({ api, bus, state, modalManager, projectId, onReattach }) {
    this.api = api;
    this.bus = bus;
    this.state = state;
    this.modalManager = modalManager;
    this.projectId = projectId;
    this.onReattach = onReattach;
    this._fetchSeq = 0;

    this.el = document.createElement('div');
    this.el.className = 'remote-sessions';
    this.el.dataset.testid = 'remote-sessions';

    const header = document.createElement('div');
    header.className = 'remote-sessions__header';
    const title = document.createElement('div');
    title.className = 'shell-launcher__section-title';
    title.textContent = 'Remote sessions';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'remote-sessions__refresh';
    refreshBtn.title = 'Refresh remote sessions';
    refreshBtn.dataset.testid = 'remote-sessions-refresh';
    refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
    refreshBtn.addEventListener('click', () => this.refresh());
    header.appendChild(title);
    header.appendChild(refreshBtn);

    // Action errors (a failed Kill) sit above the list so the rows stay put.
    this._error = document.createElement('div');
    this._error.className = 'remote-sessions__error';
    this._error.dataset.testid = 'remote-sessions-error';
    this._error.hidden = true;

    this._list = document.createElement('div');
    this._list.className = 'remote-sessions__list';

    this.el.appendChild(header);
    this.el.appendChild(this._error);
    this.el.appendChild(this._list);

    this._sessions = [];
    this._hostId = this.state.getProject(projectId)?.host?.id || '';
    this._lastHostStatus = this._hostId ? this.state.hostStatus?.(this._hostId) : '';

    // The instance lives as long as its element; a listener that finds the
    // element detached unsubscribes itself.
    this._unsubs = [
      this.bus.on(EVT.HOST_STATUS, ({ hostId }) => this._onHostStatus(hostId)),
      this.bus.on(EVT.TERMINAL_TEMPLATES_LOADED, () => {
        if (this._detachIfGone()) return;
        this._render();
      }),
    ];
  }

  _detachIfGone() {
    // Not yet mounted is not gone: the caller appends after construction.
    if (!this._mounted) {
      if (this.el.isConnected) this._mounted = true;
      return false;
    }
    if (this.el.isConnected) return false;
    for (const off of this._unsubs) off();
    this._unsubs = [];
    return true;
  }

  // A host coming back (ssh reconnect, relay restart) is when sessions that
  // were unreachable become listable again, so re-fetch without a click.
  _onHostStatus(hostId) {
    if (this._detachIfGone() || !this._hostId) return;
    if (hostId && hostId !== this._hostId) return;
    const status = this.state.hostStatus?.(this._hostId);
    const cameBack = status === 'connected' && this._lastHostStatus !== 'connected';
    this._lastHostStatus = status;
    if (cameBack) this.refresh();
  }

  async refresh() {
    const seq = ++this._fetchSeq;
    this._loaded = false;
    this._setError('');
    this._setMessage('Loading…');
    try {
      const list = await this.api.getPersistentSessions(this.projectId);
      if (seq !== this._fetchSeq) return;
      this._sessions = Array.isArray(list) ? list : [];
      this._loaded = true;
      this.el.hidden = false;
      this._render();
    } catch (err) {
      if (seq !== this._fetchSeq) return;
      this._sessions = [];
      // 404: not a host project (or gone) — nothing to show at all.
      if (err.status === 404) {
        this.el.hidden = true;
        return;
      }
      this.el.hidden = false;
      const detail = err.body?.error;
      this._setMessage(err.status === 409
        ? (detail || 'tmux is not available on this host.')
        : `Couldn't reach the host${detail ? `: ${detail}` : '.'}`);
    }
  }

  _setError(text) {
    this._error.textContent = text;
    this._error.hidden = !text;
  }

  _setMessage(text) {
    this._list.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'remote-sessions__message';
    msg.textContent = text;
    this._list.appendChild(msg);
  }

  _templateName(templateId) {
    const tmpl = (this.state.terminalTemplates || []).find(t => t.id === templateId);
    return tmpl?.name || templateId || 'Terminal';
  }

  _render() {
    if (!this._loaded) return;
    if (this._sessions.length === 0) {
      this._setMessage('No remote sessions.');
      return;
    }
    this._list.innerHTML = '';
    for (const s of this._sessions) this._list.appendChild(this._renderRow(s));
  }

  _renderRow(s) {
    const row = document.createElement('div');
    row.className = 'shell-launcher__resume-item remote-sessions__row';
    row.dataset.testid = `remote-session-${s.name}`;

    const info = document.createElement('div');
    info.className = 'remote-sessions__info';
    const name = document.createElement('span');
    name.className = 'shell-launcher__resume-name';
    name.textContent = `${this._templateName(s.template_id)} #${s.n}`;
    info.appendChild(name);

    const age = typeof relativeTime === 'function' && s.created ? relativeTime(s.created * 1000) : '';
    if (age) {
      const ageEl = document.createElement('span');
      ageEl.className = 'remote-sessions__age';
      ageEl.textContent = age === 'now' ? 'just now' : `${age} ago`;
      info.appendChild(ageEl);
    }
    if (s.attached_here || s.attached > 0) {
      const badge = document.createElement('span');
      badge.className = 'shell-launcher__resume-badge shell-launcher__resume-badge--running';
      badge.textContent = 'attached';
      badge.title = s.attached_here ? 'Attached from this eve' : `${s.attached} client(s) attached`;
      info.appendChild(badge);
    }

    const reattach = document.createElement('button');
    reattach.className = 'dialog__btn dialog__btn--secondary remote-sessions__btn';
    reattach.textContent = 'Reattach';
    reattach.addEventListener('click', () => this.onReattach(s));

    const kill = document.createElement('button');
    kill.className = 'dialog__btn dialog__btn--secondary remote-sessions__btn remote-sessions__btn--danger';
    kill.textContent = 'Kill';
    kill.addEventListener('click', () => this._confirmKill(s));

    row.appendChild(info);
    row.appendChild(reattach);
    row.appendChild(kill);
    return row;
  }

  _confirmKill(s) {
    const label = `${this._templateName(s.template_id)} #${s.n}`;
    this.modalManager.showConfirmModal(
      `Kill remote session "${label}"? Anything running in it on the host stops.`,
      async () => {
        try {
          await this.api.deletePersistentSession(this.projectId, s.name);
        } catch (err) {
          // Leave the list as it was; the session may well still be there.
          this._setError(`Couldn't kill "${label}": ${err.body?.error || err.message}`);
          return;
        }
        this.refresh();
      }
    );
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RemoteSessionsSection;
}
