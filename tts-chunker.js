/**
 * TTS text chunking — shared by the streaming voice path (relay-client.js) and
 * the read-aloud play button (ws-handler.js handleTtsSpeak).
 *
 * The daemon synthesizes one text per request, so to start audio before the
 * whole message is generated we split text at sentence boundaries and feed the
 * daemon one chunk at a time. This module owns the boundary detection, the
 * markdown/code cleaning applied before synthesis, and the min-length merge
 * rules — keeping both callers byte-identical.
 */

const TTS_MIN_FIRST_CHUNK = 20;
const TTS_MIN_CHUNK = 40;
const TTS_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr',
  'vs', 'etc', 'approx', 'dept', 'est', 'govt',
  'eg', 'ie', 'al',       // e.g., i.e., et al.
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

/**
 * Find the first sentence boundary in text.
 * Returns { sentence, remainder } or { sentence: null, remainder: text }.
 * Skips abbreviations (Mr., Dr., e.g.), decimal numbers (3.14),
 * and boundaries inside code blocks or think tags. Operates on raw text —
 * cleaning (strip markdown, code blocks) is deferred to cleanChunkText.
 */
function extractNextSentence(text) {
  // Don't split inside an unclosed code block or think tag
  if (text.includes('```') && (text.match(/```/g) || []).length % 2 !== 0) {
    return { sentence: null, remainder: text };
  }
  if (text.includes('<think>')) {
    const opens = (text.match(/<think>/g) || []).length;
    const closes = (text.match(/<\/think>/g) || []).length;
    if (opens > closes) return { sentence: null, remainder: text };
  }

  const hasBlocks = text.includes('```') || text.includes('<think>');
  const pattern = /([.!?]+)(\s+|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const endIdx = match.index + match[0].length;
    const punct = match[1];
    const before = text.slice(0, match.index);

    // Skip boundaries inside code blocks or think tags
    if (hasBlocks) {
      const fenceCount = (before.match(/```/g) || []).length;
      if (fenceCount % 2 !== 0) continue;
      const thinkOpens = (before.match(/<think>/g) || []).length;
      const thinkCloses = (before.match(/<\/think>/g) || []).length;
      if (thinkOpens > thinkCloses) continue;
    }

    // Skip decimal numbers (3.14) and abbreviations (Mr., Dr., e.g.)
    if (punct === '.') {
      const charBefore = match.index > 0 ? text[match.index - 1] : '';
      const charAfter = text[endIdx] || '';
      if (/\d/.test(charBefore) && /\d/.test(charAfter)) continue;
      const wordMatch = before.match(/(\w+)$/);
      if (wordMatch && TTS_ABBREVIATIONS.has(wordMatch[1].toLowerCase())) continue;
    }

    const sentence = text.slice(0, endIdx).trim();
    const remainder = text.slice(endIdx);
    return { sentence, remainder };
  }

  return { sentence: null, remainder: text };
}

/**
 * Strip markdown / code / URLs / think tags from a chunk so the synthesizer
 * never speaks formatting. Returns '' when nothing speakable remains.
 */
function cleanChunkText(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`#>]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

/**
 * Split a complete message into ordered, raw (uncleaned) chunks at sentence
 * boundaries, merging short sentences forward until each chunk reaches the
 * minimum length (TTS_MIN_FIRST_CHUNK for the first, TTS_MIN_CHUNK after).
 *
 * Unlike the streaming flusher in relay-client.js — which waits for more text
 * when a sentence is below the minimum — this operates on a fully-known message,
 * so a short opener is merged with following sentences rather than stalling the
 * whole message into one chunk. Any trailing text without a terminal boundary
 * (or stuck behind an unclosed fence) becomes the final chunk.
 *
 * Callers should run each returned chunk through cleanChunkText before synthesis.
 */
function splitIntoChunks(text) {
  const chunks = [];
  let buffer = '';
  let remaining = text;
  let first = true;

  while (true) {
    const result = extractNextSentence(remaining);
    if (!result.sentence) break;
    buffer = buffer ? `${buffer} ${result.sentence}` : result.sentence;
    remaining = result.remainder;
    const minLen = first ? TTS_MIN_FIRST_CHUNK : TTS_MIN_CHUNK;
    if (buffer.length >= minLen) {
      chunks.push(buffer);
      buffer = '';
      first = false;
    }
  }

  const tail = `${buffer} ${remaining}`.trim();
  if (tail) chunks.push(tail);
  return chunks;
}

module.exports = {
  TTS_MIN_FIRST_CHUNK,
  TTS_MIN_CHUNK,
  TTS_ABBREVIATIONS,
  extractNextSentence,
  cleanChunkText,
  splitIntoChunks,
};
