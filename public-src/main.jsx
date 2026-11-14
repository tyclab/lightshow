import { Background } from './components/Background.jsx';
import { render } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'preact/hooks';
import { field } from './state.js';
import { setUpDevice } from './device.js';

import { Header } from './components/Header.jsx';
import { CommandBar } from './components/CommandBar.jsx';
import { Bands } from './components/Bands.jsx';
import { AutoMode } from './components/AutoMode.jsx';
import { Warm } from './components/Warm.jsx';
import { Effects } from './components/Effects.jsx';
import { Cues } from './components/Cues.jsx';
import { Fixtures } from './components/Fixtures.jsx';
import { StagePreview } from './components/StagePreview.jsx';
import { BottomDrawer } from './components/BottomDrawer.jsx';
import { ConnectionVeil } from './components/ConnectionVeil.jsx';
import { ShortcutsOverlay } from './components/Shortcuts.jsx';
import { Perform } from './components/Perform.jsx';
import { Show } from './components/Show.jsx';
import { TimelineView } from './components/TimelineView.jsx';
import { StageView } from './components/StageView.jsx';
import { Sequence } from './components/Sequence.jsx';
import { SubTabs, SubPanel, useSubTab } from './components/setup/SubTabs.jsx';
import { Transport } from './components/Transport.jsx';
import { useTapShortcut } from './keys.js';
import { RigView } from './components/setup/RigView.jsx';
import { SourcesView } from './components/setup/SourcesView.jsx';
import { SettingsView } from './components/setup/SettingsView.jsx';
import { PreflightView } from './components/setup/PreflightView.jsx';

import { VIEWS, VIEW_IDS, STRIP_VIEWS, SETUP_VIEWS, viewShortcut, resolveRoute } from './views.js';
import { useDismiss } from './popover.js';
import { pageTitle } from './brand.js';

const viewOfHash = () => resolveRoute(window.location.hash)?.view;

function initialView() {
  let route = resolveRoute(window.location.hash);
  if (!route) {
    try { route = resolveRoute(localStorage.getItem('lightshow.mode')); } catch { /* private mode */ }
  }
  const canonical = route?.canonical || 'show';
  window.history.replaceState(null, '', `#${canonical}`);
  return route?.view || 'show';
}

// Stored when chosen, not after the view renders: a reload during a slow first render keeps it.
function rememberView(mode) {
  try { localStorage.setItem('lightshow.mode', mode); } catch { /* private mode */ }
  // A view with tabs of its own keeps its part of the hash (/#rig/outputs).
  const route = resolveRoute(window.location.hash);
  const path = route?.view === mode ? route.canonical : mode;
  if (window.location.hash !== `#${path}`) window.history.replaceState(null, '', `#${path}`);
}

// The tabs are one stop in the tab order: the arrow keys, Home and End move between
// them (the ARIA tabs pattern). With a Setup view open no tab is selected and the first is the stop.
function ModeTabs({ mode, setMode }) {
  // Subscribes here rather than in Root, so an auto-show status change re-renders
  // this strip alone instead of the whole tree.
  const autoShow = field('autoShow').value;
  const autoActive = !!(autoShow && autoShow.status && autoShow.status !== 'idle');
  const stop = STRIP_VIEWS.some((v) => v.id === mode) ? mode : STRIP_VIEWS[0].id;

  const onKeyDown = (e) => {
    const at = STRIP_VIEWS.findIndex((v) => `tab-${v.id}` === e.target.id);
    const n = STRIP_VIEWS.length;
    const to = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n
      : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (at < 0 || to < 0) return;
    e.preventDefault();
    setMode(STRIP_VIEWS[to].id);
    document.getElementById(`tab-${STRIP_VIEWS[to].id}`)?.focus();
  };

  return (
    <>
      <div class="mode-tabs" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
        {STRIP_VIEWS.map((v) => (
          <button
            key={v.id}
            id={`tab-${v.id}`}
            role="tab"
            type="button"
            aria-selected={mode === v.id}
            aria-controls={`panel-${v.id}`}
            tabIndex={stop === v.id ? 0 : -1}
            class={`mode-tab ${mode === v.id ? 'active' : ''}`}
            onClick={() => setMode(v.id)}
          >
            <span class="mode-tab-icon" aria-hidden="true">{v.icon}</span>
            <span class="mode-tab-label">{v.label}</span>
          </button>
        ))}
      </div>
      <SetupMenu mode={mode} setMode={setMode} autoActive={autoActive} />
    </>
  );
}

// A menu button (the ARIA menu button pattern): Enter, Space and ArrowDown open it on its
// first entry, ArrowUp on its last; the arrows, Home and End move; Escape and a choice give focus back.
function SetupMenu({ mode, setMode, autoActive }) {
  const [open, setOpen] = useState(false);
  // A new object per request, so a second ArrowDown on the open menu's button moves focus again.
  const [focusAt, setFocusAt] = useState({ at: 0 });
  const trigger = useRef(null);
  const menu = useRef(null);
  useDismiss(open, () => setOpen(false), trigger, menu);
  useEffect(() => { setOpen(false); }, [mode]);
  // Before the next key arrives: an effect runs after the next frame, and a key pressed right
  // after Enter would still reach the button.
  useLayoutEffect(() => {
    if (open) menu.current?.querySelectorAll('[role="menuitem"]')[focusAt.at]?.focus();
  }, [open, focusAt]);
  const current = SETUP_VIEWS.find((v) => v.id === mode);
  const show = (at) => { setFocusAt({ at }); setOpen(true); };
  const onButtonKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    show(e.key === 'ArrowUp' ? SETUP_VIEWS.length - 1 : 0);
  };
  const onMenuKey = (e) => {
    const items = [...menu.current.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1)
      : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (e.key === 'Tab') setOpen(false);
    if (to < 0) return;
    e.preventDefault();
    items[to].focus();
  };
  const choose = (id) => { setOpen(false); trigger.current?.focus(); setMode(id); };

  return (
    <div class="mode-setup">
      <button
        ref={trigger}
        type="button"
        class={`mode-tab mode-setup-button ${current ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={autoActive ? 'Auto Show: Running' : undefined}
        onClick={() => (open ? setOpen(false) : show(0))}
        onKeyDown={onButtonKey}
      >
        <span class="mode-tab-label">Setup</span>
        {current && <>{' '}<span class="mode-setup-current"><span aria-hidden="true">· </span>{current.label}</span></>}
        {autoActive && <span class="mode-tab-dot" aria-hidden="true" />}
        <span class="mode-setup-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={menu} class="mode-setup-menu" role="menu" aria-label="Setup" onKeyDown={onMenuKey}>
          {SETUP_VIEWS.map((v, i) => [
            i > 0 && SETUP_VIEWS[i - 1].group !== v.group && <div key={`sep-${v.id}`} class="mode-setup-sep" role="separator" />,
            <button
              key={v.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              class="mode-setup-item"
              aria-current={mode === v.id ? 'page' : undefined}
              aria-describedby={`setup-hint-${v.id}`}
              aria-keyshortcuts={v.key}
              onClick={() => choose(v.id)}
            >
              <span class="mode-tab-icon" aria-hidden="true">{v.icon}</span>
              <span class="mode-setup-name">{v.label}</span>
              <span id={`setup-hint-${v.id}`} class="mode-setup-hint" aria-hidden="true">
                {v.id === 'auto' && autoActive ? 'Running' : v.hint}
                {v.id === 'auto' && autoActive && <span class="mode-tab-dot" />}
              </span>
              <kbd class="mode-setup-key" aria-hidden="true">{v.key}</kbd>
            </button>,
          ])}
        </div>
      )}
    </div>
  );
}

function EffectsView() {
  return (
    <div class="manual-view">
      <div class="manual-col col-patterns"><Background /><Cues /><Effects /></div>
      <div class="manual-col col-colors"><Bands /></div>
      <div class="manual-col col-fixtures"><StagePreview /><Fixtures /></div>
    </div>
  );
}

const AUTO_TABS = [{ id: 'show', label: 'Show' }, { id: 'timeline', label: 'Timeline' }];
function AutoView() {
  const [tab, setTab] = useSubTab('auto', AUTO_TABS);
  return (
    <div class="auto-view">
      <Transport prefer="auto" />
      <SubTabs view="auto" tabs={AUTO_TABS} tab={tab} setTab={setTab} label="Auto Show" />
      <SubPanel view="auto" tab={tab}>
        {tab === 'timeline' ? <TimelineView /> : <><AutoMode /><Warm /></>}
      </SubPanel>
    </div>
  );
}

// The bars stacked above a view, whose heights the sticky offsets in style.css read.
const BARS = [['header', '.app-header'], ['commands', '.command-bar'], ['views', '.mode-nav'], ['effects', '.effects-tools']];

const PANELS = {
  show: Show,
  effects: EffectsView,
  auto: AutoView,
  perform: Perform,
  stage: StageView,
  sequence: Sequence,
  rig: RigView,
  sources: SourcesView,
  settings: SettingsView,
  preflight: PreflightView,
};

function Root() {
  // Deliberately reads no signals. Subscribing the root made every component in
  // the tree re-render on every push; each component now subscribes to what it
  // actually needs.
  const [mode, showMode] = useState(initialView);
  const setMode = useCallback((next) => { rememberView(next); showMode(next); }, []);
  const Panel = PANELS[mode];
  // Show uses the header's look controls; Perform also carries its own transport.
  const bare = mode === 'show' || mode === 'perform';
  useTapShortcut();

  // The bars' heights as the ResizeObserver reports them, from the layout the
  // frame computes anyway; measuring them on a switch forced style and layout of
  // the whole view that had just mounted.
  useEffect(() => {
    const root = document.documentElement.style;
    const names = new Map();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize && entry.borderBoxSize[0];
        root.setProperty(`--${names.get(entry.target)}-height`, `${box ? box.blockSize : entry.target.getBoundingClientRect().height}px`);
      }
    });
    for (const [name, selector] of BARS) {
      const element = document.querySelector(selector);
      if (element) {
        names.set(element, name);
        observer.observe(element);
      } else {
        root.setProperty(`--${name}-height`, '0px');
      }
    }
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    document.title = pageTitle(VIEWS.find((view) => view.id === mode)?.label);
    rememberView(mode);
  }, [mode]);

  useEffect(() => {
    const onHash = () => {
      const hash = viewOfHash();
      if (VIEW_IDS.includes(hash)) setMode(hash);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // View shortcuts leave keys handled by the focused control alone.
  useEffect(() => {
    const onKey = (e) => {
      const view = viewShortcut(e);
      if (view) { e.preventDefault(); setMode(view.id); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {/* Focuses the view without touching the hash, which names the view. */}
      <a class="skip-link" href="#main" onClick={(e) => {
        e.preventDefault();
        document.getElementById(`panel-${mode}`)?.focus();
      }}>Skip to the controls</a>
      <Header />
      {!bare && <CommandBar transport={mode !== 'auto' && mode !== 'sequence'} />}
      <nav class="mode-nav" aria-label="Views">
        <ModeTabs mode={mode} setMode={setMode} />
      </nav>
      <main id="main" class={`mode-${mode}`}>
        {/* A view behind the Setup menu has no tab to name its panel, so it names itself; a group,
            not a landmark, so its own landmarks stay top-level and unique. */}
        <div id={`panel-${mode}`} class="view-panel" tabIndex={-1} {...(STRIP_VIEWS.some((v) => v.id === mode)
          ? { role: 'tabpanel', 'aria-labelledby': `tab-${mode}` }
          : { role: 'group', 'aria-label': VIEWS.find((v) => v.id === mode)?.label })}>
          <Panel />
        </div>
      </main>
      <footer class="app-footer">
        {!bare && <BottomDrawer />}
        <ShortcutsOverlay />
      </footer>
      <ConnectionVeil />
    </>
  );
}

setUpDevice();
render(<Root />, document.getElementById('app'));
