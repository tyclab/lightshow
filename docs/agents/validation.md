# Validation and Nix troubleshooting

Read for this topic; paths below are relative to the repository root unless stated otherwise.

Run `npm run check` and `npm run build:client` for JavaScript/TypeScript changes.
For browser behavior, run `npm run test:e2e` with Playwright Chromium installed.
For Python changes, run `python -m unittest discover -s tests/python -v` using the
analysis environment; report missing dependencies, skipped models and failures.
Validate comment edits with parser/AST comparisons as well as relevant tests.
Do not update golden outputs merely to make a failing check pass.

- Without WebGL (Playwright's headless shell from Nix has none) Stage falls back
  and every motion test reads zero. Run e2e with a config whose desktop project
  sets `channel: 'chromium'` and `launchOptions.args` `--use-gl=angle
  --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, after
  `npm i --no-save @playwright/test@<version of the installed browsers>`. Some
  Chromium builds give no WebGL with those SwiftShader flags; `--use-gl=angle
  --use-angle=vulkan --enable-features=Vulkan` does. Check that the configured
  browser creates a `webgl2` context before trusting a motion test.
- Stage motion is `stageMotion` in `tests/e2e/stage-image.js`. A stopped show is
  not dark: disarmed, the stage draws the selected look on the demo beat. The zero
  control is armed and stopped with Background off and no Freeze, voices or fixture
  overrides; every darkness or zero-motion test clears those first, since a stopped
  show still renders Background (`src/server/renderer.ts`) and a frozen picture.
- On Nix, `npm run check` fails the MIDI tests with libasound `ERR_DLOPEN_FAILED`
  unless `LD_LIBRARY_PATH` holds
  `$(nix build --no-link --print-out-paths nixpkgs#alsa-lib)/lib`.
- `npm audit fix --omit=dev` prunes dev dependencies; run `npm install` after it.
- A flaky test is a race until proven otherwise. Reproduce it on `main`
  deterministically (`page.clock.install()` with `pauseAt` between action and
  reload, `page.routeWebSocket` delaying server frames, `kill -STOP` with the code's
  own accounting) and `git blame` the cause before touching assertions; repeated
  runs prove nothing. Tests that mock timers inject `now`. Timings inflate under
  the parallel suite and on a saturated host: measure rates on an idle one.
