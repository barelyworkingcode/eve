const {
  TTS_MIN_FIRST_CHUNK,
  TTS_MIN_CHUNK,
  extractNextSentence,
  cleanChunkText,
  splitIntoChunks,
} = require('../../tts-chunker');

describe('extractNextSentence', () => {
  it('splits at the first sentence boundary', () => {
    const { sentence, remainder } = extractNextSentence('Hello world. How are you?');
    expect(sentence).toBe('Hello world.');
    expect(remainder).toBe('How are you?');
  });

  it('returns null when there is no terminal boundary', () => {
    const { sentence, remainder } = extractNextSentence('an unfinished clause without');
    expect(sentence).toBeNull();
    expect(remainder).toBe('an unfinished clause without');
  });

  it('skips single-token abbreviations (Dr., etc.)', () => {
    expect(extractNextSentence('Dr. Smith arrived early today.').sentence)
      .toBe('Dr. Smith arrived early today.');
    expect(extractNextSentence('We brought chips, dip, etc. and then left.').sentence)
      .toBe('We brought chips, dip, etc. and then left.');
  });

  it('does NOT protect multi-dot abbreviations like e.g. (known limitation)', () => {
    // `(\w+)$` before the boundary only captures "g", not "eg", so the dot after
    // "e.g" is treated as a sentence end. Documenting actual behavior, not ideal.
    expect(extractNextSentence('Bring snacks, e.g. chips and dip.').sentence)
      .toBe('Bring snacks, e.g.');
  });

  it('skips decimal numbers (3.14)', () => {
    expect(extractNextSentence('Pi is roughly 3.14 in value here.').sentence)
      .toBe('Pi is roughly 3.14 in value here.');
  });

  it('does not split inside an unclosed code fence', () => {
    expect(extractNextSentence('Run this. ```\ncode here').sentence).toBeNull();
  });

  it('splits before a balanced code fence', () => {
    expect(extractNextSentence('Run this code now. ```\ncode\n``` done.').sentence)
      .toBe('Run this code now.');
  });

  it('does not split inside an unclosed think tag', () => {
    expect(extractNextSentence('<think>still reasoning here').sentence).toBeNull();
  });

  it('ignores boundaries inside a closed think tag but splits after it', () => {
    const { sentence } = extractNextSentence('<think>hmm.</think> Hello there world.');
    expect(sentence).toBe('<think>hmm.</think> Hello there world.');
  });
});

describe('cleanChunkText', () => {
  it('strips markdown emphasis and inline code markers', () => {
    expect(cleanChunkText('**bold** _italic_ `code`')).toBe('bold italic code');
  });

  it('keeps link text and drops the URL', () => {
    expect(cleanChunkText('See [the docs](https://example.com) now')).toBe('See the docs now');
  });

  it('strips bare URLs', () => {
    expect(cleanChunkText('Visit https://foo.com/bar today')).not.toContain('http');
  });

  it('removes think tags and code blocks entirely', () => {
    expect(cleanChunkText('<think>secret</think>Hello')).toBe('Hello');
    expect(cleanChunkText('```code block```visible')).toBe('visible');
  });

  it('strips a dangling unterminated think tag (half-streamed reasoning)', () => {
    // Mid-stream the closing </think> may not have arrived yet. The
    // /<think>[\s\S]*$/ branch must drop everything from the open tag to
    // end-of-string so partial reasoning is never spoken; real text before
    // the tag survives.
    expect(cleanChunkText('Here is the answer. <think>now let me reason about'))
      .toBe('Here is the answer.');
    expect(cleanChunkText('<think>reasoning with no close')).toBe('');
  });

  it('returns empty string when nothing speakable remains', () => {
    expect(cleanChunkText('```only code```')).toBe('');
    expect(cleanChunkText('   ')).toBe('');
  });
});

describe('splitIntoChunks', () => {
  it('returns no chunks for empty or whitespace input', () => {
    expect(splitIntoChunks('')).toEqual([]);
    expect(splitIntoChunks('    ')).toEqual([]);
  });

  it('emits the first chunk once it reaches the first-chunk minimum', () => {
    // "Okay sure thing now." is exactly TTS_MIN_FIRST_CHUNK (20) chars.
    const opener = 'Okay sure thing now.';
    expect(opener.length).toBe(TTS_MIN_FIRST_CHUNK);
    const chunks = splitIntoChunks(`${opener} This is a much longer following sentence here.`);
    expect(chunks[0]).toBe(opener);
    expect(chunks).toHaveLength(2);
  });

  it('merges a short opener forward instead of stalling the whole message', () => {
    const chunks = splitIntoChunks('Hi. How are you doing today my good friend?');
    expect(chunks).toEqual(['Hi. How are you doing today my good friend?']);
  });

  it('merges short subsequent sentences up to the subsequent minimum', () => {
    const first = 'This is a normal first sentence here.'; // 37 chars >= first min
    expect(first.length).toBeGreaterThanOrEqual(TTS_MIN_FIRST_CHUNK);
    const chunks = splitIntoChunks(`${first} Ok two. Three is here now ok.`);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe('Ok two. Three is here now ok.');
    // The merged tail is below TTS_MIN_CHUNK but flushes at end of message.
    expect(chunks[1].length).toBeLessThan(TTS_MIN_CHUNK);
  });

  it('flushes trailing text with no terminal punctuation as the final chunk', () => {
    const chunks = splitIntoChunks('First complete sentence goes here now. Then trailing words');
    expect(chunks).toEqual([
      'First complete sentence goes here now.',
      'Then trailing words',
    ]);
  });

  it('streams a long multi-sentence message — first chunk far smaller than the whole', () => {
    const text = 'The first sentence is reasonably long here. '
      + 'The second sentence is also reasonably long. '
      + 'The third sentence continues the pattern nicely. '
      + 'The fourth sentence wraps everything up well now.';
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    // This is the latency property: read-aloud starts after the first sentence,
    // not the whole message.
    expect(chunks[0].length).toBeLessThan(text.length / 2);
  });
});
