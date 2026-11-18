// The old settings page's tabs, and the places that hold them now.
(() => {
  const moved = {
    check: 'settings/check',
    rig: 'rig/plan',
    output: 'rig/outputs',
    control: 'settings',
    music: 'sources/live',
    server: 'settings/system',
  };
  const tab = window.location.hash.slice(1);
  window.location.replace(`./${window.location.search}#${moved[tab] || 'rig'}`);
})();
