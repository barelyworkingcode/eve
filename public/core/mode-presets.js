/**
 * ModePresets: a mode's Ask and voice presets. A chat template lists the modes
 * it is the preset for (`presetFor`); a voice template is the mode's voice
 * preset, any other is its Ask preset. A label only, never a grant: relay does
 * not read it. Pure, so unit tests and journeys can require it.
 */
const ModePresets = {
  MODES: ['home', 'work'],
  RESUME_MS: 30 * 60 * 1000,

  label(mode) { return mode === 'home' ? 'Home' : 'Work'; },

  other(mode) { return mode === 'home' ? 'work' : 'home'; },

  // Filter to known modes, deduplicate, MODES order.
  normalize(list) {
    if (!Array.isArray(list)) return [];
    return ModePresets.MODES.filter(m => list.includes(m));
  },

  kind(template) { return template && template.mode === 'voice' ? 'voice' : 'ask'; },

  _inMode(project, mode) {
    const m = project && project.mode;
    return m !== 'home' && m !== 'work' ? true : m === mode;
  },

  // The mode's project: the local project whose defaultFor includes the mode,
  // else the only local project visible in the mode, else none.
  projectFor(projects, mode) {
    const local = (projects || []).filter(p => p && !p.hostId && !p.host && ModePresets._inMode(p, mode));
    const def = local.find(p => (p.defaultFor || []).includes(mode));
    if (def) return def;
    return local.length === 1 ? local[0] : null;
  },

  // First template of each kind that lists the mode.
  presetsOf(project, mode) {
    const out = { ask: null, voice: null };
    for (const t of (project && project.chatTemplates) || []) {
      if (!ModePresets.normalize(t.presetFor).includes(mode)) continue;
      const k = ModePresets.kind(t);
      if (!out[k]) out[k] = t;
    }
    return out;
  },

  forMode(projects, mode) {
    const project = ModePresets.projectFor(projects, mode);
    return { project, ...ModePresets.presetsOf(project, mode) };
  },

  // New array. Turning a mode on at `index` clears it from every other template of the same kind.
  withPreset(templates, index, mode, on) {
    const kind = ModePresets.kind(templates[index]);
    return templates.map((t, i) => {
      const has = ModePresets.normalize(t.presetFor);
      let next = has;
      if (i === index) next = on ? ModePresets.normalize([...has, mode]) : has.filter(m => m !== mode);
      else if (on && ModePresets.kind(t) === kind) next = has.filter(m => m !== mode);
      return next.length === has.length && next.every((m, j) => m === has[j]) ? t : { ...t, presetFor: next };
    });
  },

  // The create_session frame for an Ask, before applyChatDefaults.
  askFrame({ project, template, model, text }) {
    const title = String(text || '').trim().split('\n')[0].slice(0, 48);
    const frame = {
      type: 'create_session',
      projectId: project.id,
      model: template && template.model ? template.model : model,
      settings: null,
      name: `${project.name} - ${title}`,
    };
    if (template && template.systemPrompt) frame.systemPrompt = template.systemPrompt;
    return frame;
  },

  _ms(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const t = v ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? 0 : t;
  },

  // Latest of lastMessageAt, createdAt and this device's last open; 0 when none is known.
  lastActive(session, lastOpenedAt) {
    const s = session || {};
    return Math.max(ModePresets._ms(s.lastMessageAt), ModePresets._ms(s.createdAt), ModePresets._ms(lastOpenedAt));
  },

  // A7: a voice thread, visible in the current mode, active within 30 minutes (strictly younger).
  resumable(session, { now, inMode, isVoice, lastOpenedAt } = {}) {
    if (!session || !isVoice || !inMode) return false;
    const at = ModePresets.lastActive(session, lastOpenedAt);
    return at > 0 && now - at < ModePresets.RESUME_MS;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = ModePresets;
