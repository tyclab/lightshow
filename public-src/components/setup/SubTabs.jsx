import { useCallback, useEffect, useState } from 'preact/hooks';
import { resolveRoute } from '../../views.js';

/**
 * A view's own tabs, under the main ones: the ARIA tabs pattern (one stop in
 * the tab order, arrow keys between them), remembered per view, and named in
 * the address after the view's own — /#rig/outputs opens the Rig view on its
 * outputs. An address that names a panel wins over the remembered one.
 */

function fromHash(view, ids) {
  const route = typeof window === 'undefined' ? null : resolveRoute(window.location.hash);
  return route?.view === view && ids.includes(route.sub) ? route.sub : null;
}

/** The address names `tab`, while it names this view: written when the page picks a tab, never after a navigation. */
function nameTab(view, tab) {
  if (typeof window === 'undefined') return;
  const want = `#${view}/${tab}`;
  if (resolveRoute(window.location.hash)?.view === view && window.location.hash !== want) window.history.replaceState(null, '', want);
}

// A panel opened by name from outside its view (a digit key, main.jsx). The view on the page hears of it through its
// setter here, since an address the page writes fires no hashchange; a view that is not on the page yet takes `wanted`
// as it mounts. Not read from the address: a navigation may have rewritten that before the view mounts.
const mounted = new Set();
let wanted = null;

/** Every view switch reports here: with `tab`, that panel of `view` opens; without, an earlier wish is dropped. */
export function showPanel(view, tab = null) {
  wanted = tab ? { view, tab } : null;
  if (tab) for (const show of mounted) show(view, tab);
}

export function useSubTab(view, tabs) {
  const ids = tabs.map((t) => t.id);
  const key = `lightshow.${view}.tab`;
  // Remembered when it is chosen, not after the view renders: a view left within a frame of the choice keeps it.
  const remember = (next) => { try { localStorage.setItem(key, next); } catch { /* private mode */ } };
  const [tab, setTab] = useState(() => {
    let opened;
    if (wanted?.view === view && ids.includes(wanted.tab)) {
      opened = wanted.tab;
      wanted = null;
    } else {
      opened = fromHash(view, ids);
    }
    if (!opened) {
      opened = ids[0];
      try {
        const saved = localStorage.getItem(key);
        if (ids.includes(saved)) opened = saved;
      } catch { /* private mode */ }
      nameTab(view, opened);
    }
    remember(opened);
    return opened;
  });
  useEffect(() => {
    const open = (next) => { remember(next); setTab(next); };
    const onHash = () => { const linked = fromHash(view, ids); if (linked) open(linked); };
    window.addEventListener('hashchange', onHash);
    const show = (named, next) => {
      if (named !== view || !ids.includes(next)) return;
      wanted = null;
      open(next);
    };
    mounted.add(show);
    return () => { window.removeEventListener('hashchange', onHash); mounted.delete(show); };
  }, []);
  // The page's own choice names itself at once, as a view switch does (main.jsx rememberView).
  const choose = useCallback((next) => { remember(next); setTab(next); nameTab(view, next); }, [view]);
  return [tab, choose];
}

export function SubTabs({ view, tabs, tab, setTab, label }) {
  const onKeyDown = (e) => {
    const at = tabs.findIndex((t) => t.id === tab);
    const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(tabs[to].id);
    document.getElementById(`subtab-${view}-${tabs[to].id}`)?.focus();
  };
  return (
    <div class="sub-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`subtab-${view}-${t.id}`} aria-selected={tab === t.id}
          aria-controls={`subpanel-${view}`} tabIndex={tab === t.id ? 0 : -1}
          class={`sub-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The tab panel a SubTabs strip controls. */
export function SubPanel({ view, tab, children }) {
  return (
    <div id={`subpanel-${view}`} role="tabpanel" aria-labelledby={`subtab-${view}-${tab}`} class="sub-panel">
      {children}
    </div>
  );
}
