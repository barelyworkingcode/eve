/**
 * TerminalKeybar — mobile accessory key bar for the terminal.
 *
 * Soft keyboards don't produce Esc, Tab, Shift+Tab, Ctrl, Alt/Option or arrow
 * keys, and can't express chords (Ctrl+C, Shift+Tab). This bar supplies those
 * sequences and, for Ctrl/Alt, acts as a sticky modifier applied to the next
 * key — whether tapped here or typed on the system keyboard. Single tap arms
 * for one keystroke then auto-clears; double tap locks until tapped off
 * (matching Termux/Blink).
 *
 * Lives inside #terminal so it hides automatically when the terminal pane is
 * not the active tab. Positioned just above the soft keyboard via the
 * VisualViewport API. Touch devices only.
 */

// Keys that emit a fixed byte sequence. Arrows honour DECCKM at send time.
const KEYBAR_ESSENTIAL = [
  { label: 'Esc',  seq: '\x1b' },
  { label: 'Tab',  seq: '\t' },
  { label: '⇧Tab', seq: '\x1b[Z' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: '←',    arrow: 'D' },
  { label: '↑',    arrow: 'A' },
  { label: '↓',    arrow: 'B' },
  { label: '→',    arrow: 'C' },
];

// Apple keyboards label the ⌥ modifier "Option"; everyone else says "Alt".
// Purely cosmetic — _applyModifiers sends the same ESC-prefix sequence.
const ALT_LABEL = IS_APPLE ? 'Option' : 'Alt';

const KEYBAR_EXTENDED = [
  { label: ALT_LABEL, mod: 'alt' },
  { label: '^C',   seq: '\x03' },
  { label: '^D',   seq: '\x04' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'End',  seq: '\x1b[F' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: '|',    seq: '|' },
  { label: '/',    seq: '/' },
  { label: '-',    seq: '-' },
  { label: '~',    seq: '~' },
];

// Modifier press lifecycle: off -> armed (one shot) -> locked -> off.
const MOD_OFF = 0;
const MOD_ARMED = 1;
const MOD_LOCKED = 2;

class TerminalKeybar {
  /**
   * @param {TerminalManager} terminalManager - owner; provides sendInput() and
   *   the active xterm instance.
   */
  constructor(terminalManager) {
    this.tm = terminalManager;
    this.log = terminalManager.log.child('Keybar');

    this.enabled = IS_TOUCH;
    this.expanded = false;
    this._mods = { ctrl: MOD_OFF, alt: MOD_OFF };
    this._modButtons = {};     // name -> button el
    this._lastModTap = {};     // name -> timestamp, for double-tap detection
    this._bar = null;

    if (this.enabled) this._build();
  }

  // --- DOM construction ---

  _build() {
    const host = document.getElementById('terminal');
    if (!host) {
      this.log.warn('No #terminal host; key bar disabled');
      this.enabled = false;
      return;
    }

    const bar = document.createElement('div');
    bar.id = 'terminal-keybar';
    bar.className = 'terminal-keybar';

    const keys = document.createElement('div');
    keys.className = 'terminal-keybar__keys';
    this._keysEl = keys;

    for (const def of KEYBAR_ESSENTIAL) keys.appendChild(this._makeKey(def));

    // Trailing expand toggle reveals the extended row in place.
    const expand = this._makeButton('⋯', 'terminal-keybar__key terminal-keybar__expand');
    expand.setAttribute('aria-label', 'More keys');
    this._bindPress(expand, () => this._toggleExpanded(expand));
    this._expandBtn = expand;

    bar.appendChild(keys);
    bar.appendChild(expand);
    host.appendChild(bar);
    this._bar = bar;

    this._initViewportTracking();
  }

  _makeKey(def) {
    const btn = this._makeButton(def.label, 'terminal-keybar__key');
    if (def.mod) {
      this._modButtons[def.mod] = btn;
      btn.dataset.mod = def.mod;
      this._bindPress(btn, () => this._onModTap(def.mod));
    } else {
      this._bindPress(btn, () => this._onKeyTap(def));
    }
    return btn;
  }

  _makeButton(label, className) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    return btn;
  }

  /**
   * Wire a tap without stealing focus from xterm's hidden textarea — a blur
   * collapses the soft keyboard, which would make the bar unusable. We act on
   * pointerdown and preventDefault so focus never leaves the terminal.
   */
  _bindPress(btn, handler) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handler();
      this.tm.focusActive();
    });
  }

  _toggleExpanded(expandBtn) {
    this.expanded = !this.expanded;
    expandBtn.classList.toggle('terminal-keybar__expand--open', this.expanded);
    if (this.expanded) {
      this._extendedKeys = this._extendedKeys || KEYBAR_EXTENDED.map((d) => this._makeKey(d));
      for (const btn of this._extendedKeys) this._keysEl.appendChild(btn);
    } else {
      for (const btn of this._extendedKeys || []) btn.remove();
    }
  }

  // --- Key handling ---

  _onKeyTap(def) {
    const seq = def.arrow ? this._arrowSeq(def.arrow) : def.seq;
    this.tm.sendInput(this._applyModifiers(seq));
  }

  /** DECCKM (application cursor keys) selects ESC O x vs ESC [ x. */
  _arrowSeq(letter) {
    const term = this.tm.activeTerm();
    const appMode = term?.modes?.applicationCursorKeysMode;
    return (appMode ? '\x1bO' : '\x1b[') + letter;
  }

  _onModTap(name) {
    const now = (window.performance?.now?.() ?? 0);
    const prev = this._lastModTap[name] || 0;
    this._lastModTap[name] = now;

    // Double tap (within 350ms) locks; otherwise cycle off <-> armed.
    if (now - prev < 350) {
      this._mods[name] = MOD_LOCKED;
    } else {
      this._mods[name] = this._mods[name] === MOD_OFF ? MOD_ARMED : MOD_OFF;
    }
    this._renderMod(name);
  }

  _renderMod(name) {
    const btn = this._modButtons[name];
    if (!btn) return;
    btn.classList.toggle('terminal-keybar__key--armed', this._mods[name] === MOD_ARMED);
    btn.classList.toggle('terminal-keybar__key--locked', this._mods[name] === MOD_LOCKED);
  }

  /**
   * Apply any active Ctrl/Alt modifier to a byte sequence and clear the
   * one-shot (armed) state. Called for bar keys and, via transformInput(), for
   * system-keyboard input. Modifiers fold over the first byte only — that's
   * what a real Ctrl/Alt chord targets.
   */
  _applyModifiers(seq) {
    if (!seq) return seq;
    let out = seq;
    if (this._mods.ctrl !== MOD_OFF) out = this._ctrl(out);
    if (this._mods.alt !== MOD_OFF) out = '\x1b' + out;
    this._clearArmed();
    return out;
  }

  /** Ctrl+key -> control byte. Letters and the standard @ [ \ ] ^ _ range map
   *  to 0x00–0x1f; anything else passes through unchanged. */
  _ctrl(seq) {
    const ch = seq.charCodeAt(0);
    // Uppercase A–Z / lowercase a–z and the @[\]^_ block.
    if (ch >= 64 && ch <= 95) return String.fromCharCode(ch & 0x1f) + seq.slice(1);
    if (ch >= 97 && ch <= 122) return String.fromCharCode(ch & 0x1f) + seq.slice(1);
    return seq;
  }

  _clearArmed() {
    let changed = false;
    for (const name of ['ctrl', 'alt']) {
      if (this._mods[name] === MOD_ARMED) {
        this._mods[name] = MOD_OFF;
        this._renderMod(name);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Transform system-keyboard input before it reaches the PTY, folding in an
   * armed/locked Ctrl or Alt. No-op when no modifier is active, so the normal
   * typing path is untouched. Called from TerminalManager.onData.
   */
  transformInput(data) {
    if (this._mods.ctrl === MOD_OFF && this._mods.alt === MOD_OFF) return data;
    return this._applyModifiers(data);
  }

  // --- Keyboard-aware positioning ---

  /**
   * Ride just above the soft keyboard. The VisualViewport shrinks when the
   * keyboard opens; the gap between the layout viewport bottom and the visual
   * viewport bottom is the keyboard height, so we translate the bar up by it.
   */
  _initViewportTracking() {
    const vv = window.visualViewport;
    if (!vv) return; // Older browsers: bar stays pinned to the pane bottom.
    let raf = 0;
    const update = () => {
      raf = 0;
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      this._bar.style.transform = `translateY(${-overlap}px)`;
      // Keep xterm sized to the space left above the keyboard.
      this.tm.fitActive();
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }
}

// Export for use in terminal-manager.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TerminalKeybar;
}
