/**
 * "Ask about this" (docs/design-workbench.md, S5a-A4): hands one item (a file, a
 * diff, search results) to Today's Ask as a removable attachment. This only sets
 * state.askAbout, shows Today and says so on the bus; AskPart owns the chip, the
 * project override and the send.
 */
const AskAbout = {
  MAX_BYTES: 256 * 1024,
  TOO_LARGE: "That's too large to attach (over 256 KB).",

  // attachment: { kind: 'file'|'diff'|'search', name, label, content }. An item over
  // the limit (or a `note` with no attachment) becomes a line under Ask, not a chip.
  start(container, { projectId, attachment = null, note = '' }) {
    const tooLarge = attachment && new TextEncoder().encode(attachment.content).length > AskAbout.MAX_BYTES;
    container.get('state').askAbout = { projectId, attachment: tooLarge ? null : attachment, note: tooLarge ? AskAbout.TOO_LARGE : note };
    container.get('tabManager').showToday();
    container.get('bus').emit(EVT.ASK_ABOUT, { projectId });
  },

  // A project file: fetch its text first, so a big or binary file never gets as far as a chip.
  async startFile(container, projectId, path) {
    const name = path.replace(/^\/+/, '');
    try {
      const content = await container.get('api').getFileText(projectId, path, AskAbout.MAX_BYTES);
      AskAbout.start(container, { projectId, attachment: { kind: 'file', name, label: name, content } });
    } catch (err) {
      const note = err.tooLarge ? AskAbout.TOO_LARGE : err.binary ? "That isn't a text file." : "Couldn't read that file.";
      AskAbout.start(container, { projectId, note });
    }
  },
};
