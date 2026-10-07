// Chief of Staff thread: one main-area tab. A pill with a breathing
// dot, posts the server writes (alerts with one card, replies, "Sent to"
// lines), and a composer that tells an agent something. Everything from a post
// reaches the DOM through textContent: post text is agent-derived, so it is
// never markup. Collaborators are reached through the container at call time.
class ChiefOfStaffPage {
  static OFF_LINES = {
    disabled: "Chief of Staff is off in eve's settings.",
    scope_refused: "Relay won't let the Chief of Staff read sessions.",
    no_project: 'No project can run the Chief of Staff. Set chiefOfStaff.projectId.',
    project_unsuitable: 'No project can run the Chief of Staff. Set chiefOfStaff.projectId.',
    tools_present: "The model has tools, so it's off. Alerts still post.",
    tools_unverified: "The model has tools, so it's off. Alerts still post.",
    authentication_failed: "The model can't log in, so it's off. Alerts still post.",
  };

  static STATE_LABEL = {
    asking: 'Waiting on you',
    question: 'Asked you a question',
    errored: 'Stopped with an error',
    stalled: 'Gone quiet',
  };

  static ACTION_LABEL = { answer: 'Answer', drop_in: 'Drop in', open: 'Open' };

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.posts = [];
    this.status = null;
    this._built = false;
    this._subscribed = false;
    this.bus.on(EVT.COS_SNAPSHOT, (d) => this._onSnapshot(d));
    this.bus.on(EVT.COS_POST, (d) => this._onPost(d));
    this.bus.on(EVT.COS_STATUS, (d) => this._onStatus(d));
    this.bus.on(EVT.CONNECTION_CHANGED, (c) => {
      if (c?.browser) this.subscribe();
      else this._subscribed = false;
    });
    if (this.state.connection?.browser) this.subscribe();
  }

  get el() { return document.getElementById('chiefOfStaffPane'); }

  // Ask the server for the thread and join its fan-out. Idempotent per connection.
  subscribe() {
    if (this._subscribed) return;
    const ws = this.container.has('ws') ? this.container.get('ws') : null;
    if (ws && ws.send({ type: 'cos_subscribe' })) this._subscribed = true;
  }

  // Open or focus the one Chief of Staff tab.
  open() {
    this.container.get('tabManager').openPane('chief-of-staff', {});
  }

  show() {
    this.subscribe();
    this._build();
    this._scrollToEnd();
  }

  // ---- inbound ----

  _onSnapshot(d) {
    this.posts = Array.isArray(d?.posts) ? d.posts.slice() : [];
    this.status = d?.status || null;
    this._renderFeed();
    this._renderStatus();
  }

  _onPost(d) {
    const post = d?.post;
    if (!post || !post.id || this.posts.some(p => p.id === post.id)) return;
    this.posts.push(post);
    if (this._feed) {
      this._clearEmpty();
      this._feed.appendChild(this._renderPost(post));
      this._scrollToEnd();
    }
  }

  _onStatus(d) {
    this.status = d?.status || null;
    this._renderStatus();
  }

  // ---- build ----

  _div(cls, testid) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    if (testid) el.dataset.testid = testid;
    return el;
  }

  _build() {
    const root = this.el;
    if (!root || this._built) return;
    this._built = true;
    const page = this._div('cos-page', 'cos-page');

    const top = this._div('cos-top');
    const pill = this._div('cos-pill', 'cos-pill');
    const avatar = this._div('cos cos--pill', 'cos-avatar');
    avatar.appendChild(document.createElement('i'));
    const name = document.createElement('span');
    name.textContent = 'Chief of Staff';
    pill.append(avatar, name);
    this._subline = this._div('cos-subline', 'cos-subline');
    this._off = this._div('cos-off', 'cos-off');
    this._off.hidden = true;
    top.append(pill, this._subline, this._off);

    this._feed = this._div('cos-feed');
    this._feed.setAttribute('role', 'log');
    this._feed.setAttribute('aria-live', 'polite');

    const form = document.createElement('form');
    form.className = 'cos-composer';
    this._input = document.createElement('input');
    this._input.type = 'text';
    this._input.className = 'cos-composer__input';
    this._input.dataset.testid = 'cos-input';
    this._input.placeholder = 'Tell an agent…';
    this._input.setAttribute('aria-label', 'Tell an agent');
    this._input.maxLength = 2000;
    this._input.autocomplete = 'off';
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'cos-composer__send';
    send.dataset.testid = 'cos-send';
    send.textContent = 'Send';
    form.append(this._input, send);
    form.addEventListener('submit', (e) => { e.preventDefault(); this._send(); });

    page.append(top, this._feed, form);
    root.textContent = '';
    root.appendChild(page);
    this._renderFeed();
    this._renderStatus();
  }

  _send() {
    const text = this._input.value.trim();
    if (!text) return;
    const ws = this.container.has('ws') ? this.container.get('ws') : null;
    // Keep the text when the socket is down so a retry loses nothing.
    if (ws && ws.send({ type: 'cos_message', text })) this._input.value = '';
  }

  // ---- status ----

  _renderStatus() {
    const s = this.status;
    // Every avatar (pill, rail button) breathes exactly while the model works.
    for (const a of document.querySelectorAll('[data-testid="cos-avatar"]')) {
      if (s && s.busy) a.setAttribute('data-busy', ''); else a.removeAttribute('data-busy');
    }
    if (!this._subline) return;
    const reason = s?.off?.reason;
    if (!s) {
      this._subline.textContent = 'Connecting…';
    } else if (reason === 'disabled' || reason === 'scope_refused') {
      this._subline.textContent = 'Not watching';
    } else {
      const n = s.watching | 0;
      const m = s.needYou | 0;
      this._subline.textContent = `Watching ${n} ${n === 1 ? 'agent' : 'agents'} · ${m} ${m === 1 ? 'needs' : 'need'} you`;
    }
    const line = reason ? this._offLine(s.off) : '';
    this._off.hidden = !line;
    this._off.textContent = line;
  }

  _offLine(off) {
    if (off.reason === 'launch_failed') return `Couldn't start the model: ${off.detail || 'unknown error'}.`;
    return ChiefOfStaffPage.OFF_LINES[off.reason] || '';
  }

  // ---- feed ----

  _renderFeed() {
    if (!this._feed) return;
    this._feed.textContent = '';
    if (this.posts.length === 0) {
      const empty = this._div('cos-empty', 'cos-empty');
      empty.textContent = "Nothing yet. I'll post here when an agent needs you.";
      this._feed.appendChild(empty);
      return;
    }
    for (const post of this.posts) this._feed.appendChild(this._renderPost(post));
    this._scrollToEnd();
  }

  _clearEmpty() {
    this._feed?.querySelector('[data-testid="cos-empty"]')?.remove();
  }

  _scrollToEnd() {
    if (this._feed) this._feed.scrollTop = this._feed.scrollHeight;
  }

  _renderPost(post) {
    if (post.kind === 'person') {
      const me = this._div('cos-me', `cos-post-${post.id}`);
      me.dataset.kind = post.kind;
      me.textContent = String(post.text || '');
      return me;
    }
    const article = document.createElement('article');
    article.className = 'cos-post';
    article.dataset.testid = `cos-post-${post.id}`;
    article.dataset.kind = post.kind;
    const dot = this._div('cos');
    dot.appendChild(document.createElement('i'));
    const body = this._div('cos-post__body');

    if (post.kind === 'alert') {
      const meta = document.createElement('p');
      meta.className = 'cos-post__meta';
      meta.textContent = this._meta(post);
      body.appendChild(meta);
      if (post.headline) body.appendChild(this._text('h3', post.headline));
      if (post.body) body.appendChild(this._text('p', post.body));
      if (post.card) body.appendChild(this._card(post));
    } else if (post.kind === 'sent') {
      const p = document.createElement('p');
      p.append('Sent to ');
      p.appendChild(this._sessionLink(post.sessionId, post.label));
      p.append('.');
      body.appendChild(p);
      if (post.text) body.appendChild(this._text('p', post.text, 'cos-post__sent-text'));
      const chip = this._text('span', 'Sent by Chief of Staff · in audit log', 'cos-sent-chip');
      chip.dataset.testid = 'cos-sent-chip';
      body.appendChild(chip);
    } else if (post.kind === 'send_failed') {
      body.appendChild(this._text('p', post.error || "Couldn't send that."));
    } else {
      // reply, notice
      if (post.headline) body.appendChild(this._text('h3', post.headline));
      body.appendChild(this._text('p', post.body || post.text || ''));
    }
    article.append(dot, body);
    return article;
  }

  _text(tag, text, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = String(text);
    return el;
  }

  _meta(post) {
    const parts = [this._clock(post.at)];
    if (post.card?.project) parts.push(post.card.project);
    return parts.filter(Boolean).join(' · ');
  }

  _clock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  _age(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 60000) return 'just now';
    const min = Math.floor(ms / 60000);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`;
  }

  _sessionLink(sessionId, label) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'cos-ref';
    a.textContent = String(label || 'the session');
    if (sessionId) a.addEventListener('click', () => this._open(sessionId));
    return a;
  }

  _card(post) {
    const card = post.card;
    const el = this._div('cos-card', `cos-card-${post.id}`);
    el.dataset.sessionId = card.sessionId;
    el.dataset.state = card.state;

    const hd = this._div('cos-card__hd');
    const small = document.createElement('small');
    const phrase = ChiefOfStaffPage.STATE_LABEL[card.state] || card.state;
    small.textContent = `${phrase} · ${this._age(card.since)}`;
    const title = this._div('cos-card__title');
    const dot = document.createElement('span');
    dot.className = 'agent-row__dot';
    // 'question' is an idle session whose last turn eve's isQuestion rule reads as a question; no dot of its own.
    dot.dataset.state = card.state === 'question' ? 'idle' : card.state;
    const label = document.createElement('b');
    label.textContent = String(card.label || '');
    title.append(dot, label);
    hd.append(small, title);
    el.appendChild(hd);

    if (card.quote) {
      const q = document.createElement('blockquote');
      q.className = 'cos-card__quote';
      q.dataset.testid = 'cos-card-quote';
      q.textContent = String(card.quote);
      el.appendChild(q);
    }

    const acts = this._div('cos-card__acts');
    const wanted = Array.isArray(card.actions) ? card.actions : [];
    for (const action of wanted) {
      const name = ChiefOfStaffPage.ACTION_LABEL[action];
      if (!name) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cos-btn' + (action === 'answer' ? ' cos-btn--primary' : '');
      b.dataset.testid = `cos-${action === 'drop_in' ? 'drop-in' : action}-${post.id}`;
      b.textContent = name;
      b.addEventListener('click', () => this._act(action, card));
      acts.appendChild(b);
    }
    if (acts.childNodes.length) el.appendChild(acts);
    return el;
  }

  // ---- card actions ----

  _act(action, card) {
    if (action === 'drop_in') this._dropIn(card);
    else if (action === 'answer') this._answer(card.sessionId);
    else this._open(card.sessionId);
  }

  // Same as a #session/<id> link: reuse the tab, else join. A join is what loads
  // the thread and subscribes to it; opening a bare tab would show neither.
  _open(sessionId) {
    const tabs = this.container.get('tabManager');
    if (tabs.tabs.some(t => t.id === sessionId)) tabs.switchToTab(sessionId);
    else this.container.get('app').joinSession(sessionId);
  }


  _answer(sessionId) {
    this._open(sessionId);
    // A join is async; focus now and again once the thread has rendered.
    const focus = () => document.getElementById('userInput')?.focus();
    focus();
    setTimeout(focus, 400);
  }

  // The board's Drop in, for the sessions it offers it to (headless Claude);
  // any other session is opened instead.
  _dropIn(card) {
    if (card.headless === true && AgentBoard.isClaude({ model: card.model })) {
      AgentBoard.dropIn(this.container, card.sessionId);
      return;
    }
    this._open(card.sessionId);
  }
}

if (typeof features !== 'undefined') {
  features.register({
    id: 'chiefOfStaffPage',
    init: (container) => new ChiefOfStaffPage(container),
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChiefOfStaffPage;
}
