const { Director } = require('../../tts-director');

describe('Director — plain text', () => {
  it('produces a single span with null instruct, gain 1.0, speed 1.0', () => {
    const d = new Director();
    const spans = d.plan('Hello there, how are you?');
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('Hello there, how are you?');
    expect(spans[0].instruct).toBeNull();
    expect(spans[0].gain).toBe(1.0);
    expect(spans[0].speed).toBe(1.0);
  });
});

describe('Director — delivery + emotion cues', () => {
  it('splits on delivery cues and applies emotion to the right span', () => {
    const d = new Director();
    const spans = d.plan("[whisper] I have a secret. [loud] But I'll never tell! [laugh]");
    expect(spans).toHaveLength(2);

    const [first, second] = spans;
    expect(first.text).toBe('I have a secret.');
    expect(first.gain).toBe(0.55);
    expect(first.speed).toBe(0.97);
    expect(first.instruct).toContain('whispering');

    expect(second.text).toBe("But I'll never tell!");
    expect(second.gain).toBe(1.40);
    expect(second.instruct).toContain('loudly');
    expect(second.instruct).toContain('while laughing warmly');
  });
});

describe('Director — delivery persistence across plan() calls', () => {
  it('carries delivery forward until reset()', () => {
    const d = new Director();
    d.plan('[whisper] tell me a secret.');

    const spans = d.plan('still hidden.');
    expect(spans).toHaveLength(1);
    expect(spans[0].gain).toBe(0.55);
    expect(spans[0].speed).toBe(0.97);

    d.reset();
    const after = d.plan('normal again.');
    expect(after[0].instruct).toBeNull();
  });
});

describe('Director — [normal] resets delivery within a turn', () => {
  it('switches back to null instruct after [normal]', () => {
    const d = new Director();
    d.plan('[whisper] shh.');
    const spans = d.plan('[normal] back to normal.');
    expect(spans).toHaveLength(1);
    expect(spans[0].instruct).toBeNull();
  });
});

describe('Director — emotion-only cue in a normal span', () => {
  it('produces a non-null instruct that mentions the emotion', () => {
    const d = new Director();
    const spans = d.plan("[laugh] that's funny.");
    expect(spans).toHaveLength(1);
    expect(spans[0].instruct).not.toBeNull();
    expect(spans[0].instruct).toContain('while laughing warmly');
    expect(spans[0].gain).toBe(1.0);
    expect(spans[0].speed).toBe(1.0);
  });
});

describe('Director — unknown cue', () => {
  it('drops [sparkle] silently and does not crash', () => {
    const d = new Director();
    const spans = d.plan('hello [sparkle] world.');
    expect(spans).toHaveLength(1);
    expect(spans[0].text).not.toContain('[sparkle]');
    expect(spans[0].text).toBe('hello world.');
    expect(spans[0].instruct).toBeNull();
  });
});

describe('Director — [pause] cue', () => {
  it('inserts a comma into the spoken text', () => {
    const d = new Director();
    const spans = d.plan('hello [pause] world.');
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('hello, world.');
  });
});

describe('Director — emotion deduplication', () => {
  it('joins distinct emotions with " and " and does not repeat duplicates', () => {
    const d = new Director();
    const spans = d.plan('[laugh] [giggle] [laugh] so funny.');
    expect(spans).toHaveLength(1);

    const instruct = spans[0].instruct;
    expect(instruct).toContain('while laughing warmly and giggling playfully');

    // 'laughing warmly' must appear exactly once
    const count = (instruct.match(/laughing warmly/g) || []).length;
    expect(count).toBe(1);
  });
});
