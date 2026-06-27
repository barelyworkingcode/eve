/**
 * TTS Director — turns emotion/delivery cue tags embedded in a sentence into
 * an array of spoken spans ready for the TTS daemon.
 *
 * Two kinds of cues (written as [tag]):
 *   - Delivery (modal)   — e.g. [whisper], [loud], [fast].  Switches the delivery
 *     mode for everything that follows until another delivery cue or reset().
 *     Persists from one plan() call to the next within a turn.
 *   - Emotion (momentary) — e.g. [laugh], [sigh].  Applies only to the span being
 *     assembled right now; flushes with that span and does not carry forward.
 *
 * The Director is stateful across a turn: delivery persists from one plan() call
 * to the next.  Call reset() at the start of each new turn to return to 'normal'.
 *
 * Unknown cues are dropped silently.  [pause] becomes a spoken comma/beat.
 * When delivery is 'normal' and there are no emotion cues, instruct is null —
 * the daemon falls back to the voice's configured default instruct, preserving
 * per-voice character for ordinary speech.
 */

const BASE_VOICE = 'Warm, mature and composed';

const EMOTION = {
  laugh:   'laughing warmly',
  giggle:  'giggling playfully',
  chuckle: 'chuckling',
  sigh:    'sighing',
  gasp:    'gasping in surprise',
  groan:   'groaning',
  yawn:    'sounding sleepy',
  sniffle: 'sounding tender and tearful',
  cry:     'voice trembling, on the edge of tears',
  gulp:    'sounding nervous',
};

const DELIVERY = {
  whisper: ['whispering, soft and breathy',           0.55, 0.97],
  soft:    ['speaking softly and gently',             0.80, 1.00],
  normal:  ['speaking naturally',                     1.00, 1.00],
  loud:    ['speaking loudly and boldly',             1.40, 1.00],
  shout:   ['shouting, full of force',                1.75, 1.05],
  fast:    ['speaking quickly and eagerly',           1.00, 1.18],
  slow:    ['speaking slowly, drawing the words out', 1.00, 0.85],
  excited: ['bursting with bright, excited energy',   1.20, 1.08],
  flat:    ['deadpan, flat and dry',                  0.95, 0.98],
};

const CUE_SPLIT = /(\[[a-zA-Z_]+\])/;
const CUE_MATCH = /^\[([a-zA-Z_]+)\]$/;

/** Collapse whitespace and fix space-before-punctuation. */
function tidy(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/ ([,.!?])/g, '$1');
}

class Director {
  constructor(baseVoice = BASE_VOICE) {
    this.base = baseVoice;
    this.delivery = 'normal';
  }

  /** Reset delivery to 'normal'; call at the start of each new turn. */
  reset() {
    this.delivery = 'normal';
  }

  /**
   * Parse a sentence containing cue tags and return an array of spans.
   * Each span: { text, instruct, gain, speed }.
   * instruct is null when delivery is 'normal' and there are no emotion cues.
   */
  plan(sentence) {
    const spans = [];
    let buf = [];
    let moods = [];

    const flush = () => {
      const text = tidy(buf.join('')).trim();
      buf = [];
      if (text) spans.push(this._span(text, this.delivery, moods));
      moods = [];
    };

    const tokens = sentence.split(CUE_SPLIT).filter(Boolean);

    for (const tok of tokens) {
      const m = tok.match(CUE_MATCH);
      const name = m ? m[1].toLowerCase() : null;

      if (name !== null) {
        if (name in DELIVERY) {
          flush();
          this.delivery = name;
        } else if (name in EMOTION) {
          moods.push(EMOTION[name]);
        } else if (name === 'pause') {
          buf.push(', ');
        }
        // unknown cue: drop silently
      } else {
        buf.push(tok);
      }
    }

    flush();
    return spans;
  }

  _span(text, delivery, moods) {
    if (delivery === 'normal' && moods.length === 0) {
      return { text, instruct: null, gain: 1.0, speed: 1.0 };
    }

    const [manner, gain, speed] = DELIVERY[delivery];
    const parts = [this.base, manner];

    if (moods.length > 0) {
      parts.push('while ' + [...new Set(moods)].join(' and '));
    }

    return { text, instruct: parts.join(', ') + '.', gain, speed };
  }
}

module.exports = { Director, BASE_VOICE, EMOTION, DELIVERY };
