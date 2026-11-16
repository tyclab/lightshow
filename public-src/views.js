// Show and Perform are the strip's tabs; the other five views are the Setup menu's entries, in its three groups.
// A view keeps the digit it had among the ten former views.
export const VIEWS = [
  { id: 'show', key: '1', icon: '◉', label: 'Show', hint: 'Room · Looks · Arm', strip: true },
  { id: 'perform', key: '3', icon: '⊞', label: 'Perform', hint: 'Pads · Strobe · Matrix', strip: true },
  { id: 'rig', key: '7', icon: '▦', label: 'Rig', hint: 'Plan · Room · Profiles · Outputs', group: 'Rig' },
  { id: 'effects', key: '2', icon: '◧', label: 'Effect settings', hint: 'Effects · Cues', group: 'Content' },
  { id: 'sequence', key: '6', icon: '▤', label: 'Sequence', hint: 'Lanes · Patterns · Record', group: 'Content' },
  { id: 'sources', key: '8', icon: '♫', label: 'Music', hint: 'Live input · Auto show', group: 'System' },
  { id: 'settings', key: '9', icon: '⚙', label: 'Settings', hint: 'Show · MIDI · Check · System', group: 'System' },
];
export const VIEW_IDS = VIEWS.map((v) => v.id);
export const STRIP_VIEWS = VIEWS.filter((v) => v.strip);
export const SETUP_VIEWS = VIEWS.filter((v) => !v.strip);
/** The Setup menu's groups in its order, each with its entries. */
export const SETUP_GROUPS = [...new Set(SETUP_VIEWS.map((v) => v.group))]
  .map((name) => ({ name, views: SETUP_VIEWS.filter((v) => v.group === name) }));

/** The panels of the views that have them, the first the one a view opens on. Perform's are its instruments (Perform.jsx). */
export const PANELS = {
  rig: [{ id: 'plan', label: 'Plan & patch' }, { id: 'room', label: 'Room' }, { id: 'profiles', label: 'Profiles' }, { id: 'outputs', label: 'Outputs' }],
  sources: [{ id: 'live', label: 'Live input' }, { id: 'auto', label: 'Auto show' }],
  settings: [{ id: 'show', label: 'Show' }, { id: 'midi', label: 'MIDI' }, { id: 'check', label: 'Check' }, { id: 'system', label: 'System' }],
};

/** The digits of the three former views that are panels now: each opens its panel, whichever its view remembers. */
export const PANEL_KEYS = [
  { key: '4', id: 'rig', sub: 'room' },
  { key: '5', id: 'sources', sub: 'auto' },
  { key: '0', id: 'settings', sub: 'check' },
];

/** The view a digit opens, and the panel when the digit names one: `{ id, sub }`, or null for a key that is no shortcut here. */
export function viewShortcut(event) {
  if (event.repeat || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable) return null;
  const view = VIEWS.find((v) => v.key === event.key);
  if (view) return { id: view.id, sub: null };
  const panel = PANEL_KEYS.find((p) => p.key === event.key);
  return panel ? { id: panel.id, sub: panel.sub } : null;
}

// Every address a view or a panel had before, and the place it opens now. One that names a panel drops what followed it:
// #auto/timeline opens Music's Auto show.
const ALIASES = {
  manual: 'effects', matrix: 'perform/matrix', stage: 'rig/room', auto: 'sources/auto', timeline: 'sources/auto',
  preflight: 'settings/check',
};

export function resolveRoute(hash) {
  const path = String(hash || '').replace(/^#/, '');
  const [head, ...tail] = path.split('/');
  const alias = ALIASES[head];
  const canonical = (alias?.includes('/') ? [alias] : [alias || head, ...tail]).filter(Boolean).join('/');
  const [view, sub] = canonical.split('/');
  return VIEW_IDS.includes(view) ? { view, sub: sub || null, canonical } : null;
}
