// Two kinds of [tag] cues: delivery (modal — [whisper], [loud], [fast])
// switches mode for everything that follows until another delivery cue or
// reset(), persisting across plan() calls within a turn; emotion (momentary —
// [laugh], [sigh]) applies only to the span being assembled and flushes with
// it. Call reset() at the start of each new turn. Unknown cues are dropped
// silently; [pause] becomes a spoken comma/beat.

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

  reset() {
    this.delivery = 'normal';
  }

  // instruct is null when delivery is 'normal' and there are no emotion cues
  // — the daemon then falls back to the voice's configured default.
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
