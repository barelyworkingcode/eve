# S4 · Research with sources

Slice S4 of Epic #34 (eve #155). Intent: `design/homework/index.html` ("Research with sources", "Citations you can check"). eve only. No change to relay, relayLLM or relayScheduler, and no new route or WS frame.

## What it is
When an answer used web search, a row of source cards (host, number) sits above it. Links in the answer that match a source become numbered chips. A chip or card opens a popover with the title, the excerpt the model read, and Open source. Other links stay ordinary links.

Code: `public/core/sources.js` (pure parser, UMD) and `public/citations.js`, hooked from `message-renderer.js`. Each turn keeps its own row and numbering. A turn runs from one user message to the next.

## A1 rules: what a source is
- A source comes from a tool result in the same turn. The tool name is `brave_web_search` or ends in `__brave_web_search`.
- Each JSON object in the result with an `http:` or `https:` `url` and a string `title` is one source.
- Relay joins an MCP's text blocks with no separator and cuts the result at 8,192 bytes with `\n...(truncated)`. The parser reads concatenated objects and drops an incomplete last one. It also takes a single object, a plain string, or a text-block array (history and Claude shapes).
- Error text such as "No web results found" yields no sources.
- The excerpt is `description` (or `answer`), then `extra_snippets`, joined by a blank line. HTML tags are stripped, the five basic entities are decoded, and it is capped at 600 characters. It is the text the model was given, never the model's prose.
- Sources are deduplicated by normalized URL: host lowercased, fragment and trailing `/` dropped. They are numbered 1..N in first-seen order.

Untrusted text: host, title (capped at 160) and excerpt are set with `textContent`. No `img`, `iframe` or `script` is built from source data. Monograms replace favicons, so no request leaves for another origin and CSP is unchanged.

## Recommended Research template prompt
Citations depend on the model linking its claims. This prompt is a recommendation for a `Research` chat template. eve does not ship it.

> Search the web before you answer. Cite each claim with a markdown link to the result URL you used. Use only URLs the search returned.

A link to a URL the search did not return stays an ordinary link.

## Pasted-URL chips: a read page is a source
- A pasted link is a chip in Ask and the chat box (`SourceUrls`, `public/core/source-urls.js`). On send, eve appends one "Sources to read" block after the typed text; the browser strips it on replay and shows chips.
- A `web_fetch` tool (name `web_fetch` or ending in `__web_fetch`) for an `http:`/`https:` URL whose result starts `HTTP 2xx` adds one source, numbered with search sources in first-seen order and deduplicated by the same normalized URL. Errors, refusals and non-2xx add none.
- Title is the page's `<title>`, else host and path. The excerpt is the visible text of what the tool returned: comments, `<head>`, `<script>` and `<style>` removed (an unclosed one runs to the end), tags stripped, the five basic entities decoded, whitespace collapsed, at most 600 characters. Relay's `\n...(truncated)` and macMCP's `\n\n…[truncated to <n> bytes]` tails are dropped first.
- Live streams give a tool's input only at `content_block_stop`, so `Citations` keeps the input per tool id and updates it from `updateToolInput`.

## Decisions
1. A source is a `brave_web_search` result or a 2xx `web_fetch` page, and its excerpt is exactly what the model saw.
2. Citations are links matched by URL. Other links stay links.
3. `message-renderer.js` gets about five hook lines. Every live, history and Claude path to tool results and answers runs through it. A DOM observer would have to re-read tool output from rendered text.
4. The journey runs against a stub search MCP in devboxWorld that mirrors Brave's tool name, wire shape and `openWorldHint`. Its URLs use `.example`.
5. The test-world `Research` project is set up by hand (setup R1 in `devboxverify/README.md`). The owner's own Brave registration is untouched.

## Cut, and why
- **"Searched 4 · read 6" line and the `+N` card:** not in the acceptance. Tool blocks stay and the row scrolls.
- **Research chip in Ask, per-mode Research presets:** relay grants MCPs per project, not per template, and the entry point is not in the acceptance.
- **Hollow chips for links the search did not return:** they stay plain links. One kind of chip is simpler to read and build.
- **Phone bottom sheet:** one anchored popover kept inside the viewport works on desktop, iPad and phone.
- **Bare `[n]` markers:** the model and eve share no numbering. Links matched by URL are deterministic.
- **Hover popovers:** click and tap work on every device.
- **`brave_llm_context`, Claude's built-in WebSearch and WebFetch:** llm_context returns one blob that relay's 8 KB cap cuts, and the built-ins give titles or a model summary, not an excerpt. Their links stay ordinary.
- **Keep as page, "Make this a routine" from research:** later.

## Open owner questions
1. **The Brave grant shape (owner config, Secrets).** "Research presets only" cannot be expressed in relay today. Recommendation: one Research project per mode with only Brave granted, plus a `Research` template carrying the prompt above. Nothing in S4 depends on it.
2. **Should Ask reach research directly?** That needs a Research chip, or a preset applying in a picked project. It is a follow-up slice.
3. **The quality spike.** The epic puts it first. It cannot gate rendering and needs the owner's Brave registration. Proposal: run it once Brave is registered and record the result here.
