import { useCallback, useEffect, useState } from 'preact/hooks';
import { resolveRoute } from '../../views.js';

/**
 * A view's own tabs, under the main ones: the ARIA tabs pattern (one stop in
 * the tab order, arrow keys between them), remembered per view, and named in
 * the address after the view's own — /#rig/outputs opens the Rig view on its
 * outputs, which is what the old settings page's links now point at.
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

export function useSubTab(view, tabs) {
  const ids = tabs.map((t) => t.id);
  const key = `lightshow.${view}.tab`;
  const [tab, setTab] = useState(() => {
    const linked = fromHash(view, ids);
    if (linked) return linked;
    let opened = ids[0];
    try {
      const saved = localStorage.getItem(key);
      if (ids.includes(saved)) opened = saved;
    } catch { /* private mode */ }
    nameTab(view, opened);
    return opened;
  });
  useEffect(() => {
    try { localStorage.setItem(key, tab); } catch { /* private mode */ }
  }, [tab]);
  useEffect(() => {
    const onHash = () => { const linked = fromHash(view, ids); if (linked) setTab(linked); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // The page's own choice names itself at once, as a view switch does (main.jsx rememberView).
  const choose = useCallback((next) => { setTab(next); nameTab(view, next); }, [view]);
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
