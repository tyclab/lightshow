# Show v3 fixes: plan

Spec: `docs/superpowers/specs/2026-11-15-show-v3-fixes-design.md`. Base `91d0b405`; line numbers are
from it, check each before editing.

## Pull requests, lanes and order

| PR | Goals | Lane | Starts after |
|---|---|---|---|
| 1 | G1, G1b | A | this plan's merge |
| 2 | G6 | A | PR 1 open and green |
| 3 | G2 | B | this plan's merge |
| 4 | G9 (+ hatyc merge request) | C | this plan's merge |
| 5 | G3, G4 | C | PR 4 merged |
| 6 | G5 (+ hatyc merge request) | C | PR 5 merged |
| 7 | G8 (+ tycpve and hatyc merge requests where needed) | D | this plan's merge |
| 8 | G7 | D | PR 2 and PR 7 merged |

One lane builds its pull requests in order. When main moves, a lane brings its branch up to date with
a merge commit of main and runs its gates again; a merge from main proves nothing by itself, the
retained contract tests below do. The coordinator records the idle stop key in tycpve's config
recorder (`lightshow-config-git.py:89` has `outputs.idleDisarmMin` and no `idleStopMin`) and moves
the rig's pin after merges.

## Integration order and shared files

- PR 1 before PR 7: PR 1's rehearsal `light: true` and its parity test land first; PR 7 removes
  rehearsal and retires that test in its rehearsal commit, naming G8. Never restore rehearsal to
  settle a merge.
- PR 2 before PR 8: G7's navigation keeps R03's rule and its test.
- PR 6 and PR 7 share the server runtime. Whichever merges second first merges main into its branch
  and runs, on that combined head, the renderer's picture and overlay tests, the control and transport
  tests and the Home Assistant contract tests below.
- Owners of shared files (another lane touching one keeps to what it must, and says so in its body):

| File | Owner and what others may do |
|---|---|
| `src/server/engine.ts`, `src/server/renderer.ts` | G9 removes the features wiring; G5 owns the picture branch and the dark layer; G8 removes the planned show's inputs |
| `src/server/state.ts` | G5 the `picture` block; G8 the extras block (`:432-488`) |
| `src/server/control-runtime.ts`, `integrations.ts`, `src/main.ts`, `routes.ts`, `routes/common.ts`, settings keys | G8 |
| `src/server/picture.ts`, `squid-picture.ts`, `routes/outputs.ts` | G5; G9 only the `inspired` value in `validation.ts` and `settings.ts` |
| `tests/e2e/helpers.js` | G8 (Auto seeding); others only add helpers |
| `public-src/main.jsx` | G7; G3 adds only E's handler |
| `public-src/picture-source.js`, `PictureSource.jsx`, `ShowEffects.jsx` | lane C (G9, G3, G5 in order) |
| `public-src/utils.js`, `StageView.jsx`, `public/style.css` | each lane its own lines; G1 the toolbar, G4 the header, G5 the amber |

## Global constraints

- Failing test first for every goal and defect; the pull request body shows each new test failing
  on main and passing on the branch (command and result line).
- A test rewritten because a ruling changed names the goal in its commit body. A test is not weakened
  unless the pull request names the assertion the goal contradicts.
- Never arm, never talk to a real rig, Home Assistant or a deployment; tests use the repository's
  own isolated server.
- Commits: conventional subject, a prose body that says why, no attribution, nothing about tools.

## Gates

The lanes run on GamerTyc (16 vCPUs; building there is allowed, operator 2026-11-09). tycdev has a
heavy-job admission lock since 2026-11-15, and these lanes are held off it until the coordinator
says otherwise; when allowed, a tycdev run is
`ssh tycdev flock /dev/shm/flakelab-tycdev-heavy.lock <the whole command>`, never nested.

Locally, every heavy command (`npm ci`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build:client`, `npx playwright test …`, the Python tests) runs through the lock the four
lanes share: `flock /tmp/lightshow-heavy.lock nice -n 10 <command>`, one at a time, e2e with WebGL as
`docs/agents/validation.md` describes and the lane's own `E2E_PORT`. A lane runs lint, typecheck, the
unit tests, the build and the e2e specs its pull request touches. The full e2e suite and the
performance budgets are CI's: never wait for the machine's load.

## Review focus

The builders are Opus at xhigh. Their measured weak points come first: a standing rule with no test
on a new path (the safety contract, the HA routes, the hashes), refusal and idempotence untested, a
wide footprint in shared files, an invariant held only by a type, a value nobody ruled. Async input
classes the review found missing before: a newer action overtaken by an older completion, a
same-view navigation, a same-id edit, a frame from a sender that does not own the lease.

## PR 1: G1, G1b (lane A)

- `public-src/idle-pause.js` gains `pause()` beside the idle trigger, working with
  `outputs.idleStopMin` 0; `PreviewPaused.jsx` names the cause; `StageView.jsx` and
  `StagePreview.jsx` show "Pause preview" in the toolbar while `stageMode` (`utils.js:166-174`)
  returns a preview row (demo beat or server feed) and outputs are disarmed.
- `public-src/audition.js:54`, `public-src/rehearsal.js:51`: `light: true`; audition scales fixture
  trims by the master as `preview-inputs.js:68-75` does.
- `tests/e2e/stage-preview.spec.js:211`: the positive control for the engine half.
- Tests first: G1's cases in 3D and 2D, the two-page server-feed case included; G1b's unit test
  through the real option construction; the flash test shown failing on a feed forced black.

## PR 2: G6 (lane A)

R02 `src/server/control.ts:102`, `src/server/idle-stop.ts:30-50`; R03
`public-src/components/setup/SubTabs.jsx:29`, tested in the order that fails today (the review's probe
showed two outside navigations pass unfixed); R04 `public-src/components/Transport.jsx` `select`, the
busy shelf refusing a second selection; R05 `public-src/components/ShowCues.jsx:18,65`; R08 the memo
at `public-src/components/Bands.jsx:105` (the promise is `PaletteLibrary.jsx:62`). One commit per
defect, each with its failing test.

## PR 3: G2 (lane B)

- `public-src/stage3d/scene.js`: `shadowMap.enabled`, `autoUpdate = false`, `needsUpdate` on
  `setRoom`, `placeRoomLights`, `setRoomLight` and a rig change; `castShadow` on the eight lights
  (map 256², near 0.05 m, far the room box's diagonal); the blocker mesh merged from every wall's
  world geometry at full height plus floor and ceiling slabs, double-sided for shadows, on a layer
  only the shadow cameras render, kept visible; `receiveShadow` on room meshes; `setCutaway`
  keeps shortening only the drawn walls.
- `public-src/stage3d/world.js`: room membership, per-room allocation, the over-eight note and
  insets (`:339-379`); one blocker set for beams and pools (`:47-49`, `:253`, `:275`, `:290`), meshes
  by triangle; pool clipping by room and surface in the pool shaders (`scene.js:73-93`; the vertex
  shader must pass the data).
- `tests/fixtures/rigs/`: a two-room test room with a box wall, a mesh wall with a doorway and a lamp
  near the ceiling; a nine-room fixture for the unit test.
- Tests as the spec lists; `tests/e2e/stage-performance.spec.js` imports `browser-budget.js` and
  measures a rebuild and steady frames apart. Kept: `tab-switch.spec.js:308`; only `:295`'s number
  may change. `stage-scene.test.js:89-100` and `stage-mesh.spec.js` stay unless an assertion
  contradicts G2, named in the body.
- README (the room lights paragraph, `:290-294`) and `docs/stage-room.md` (`:65-66`, `:105-108`).

## PR 4: G9 (lane C)

- Remove as the spec lists; golden frames regenerated with `scripts/golden-frames.js`, not edited.
- Settings load: `picture.source: inspired` becomes `effects` with one log line; the effect library
  skips a saved `v2.visualizer` look with one warning.
- `docs/agents/header.md` records words 9 verbatim with the idea for a later build; README and
  `docs/agents/visualizer.md` lose the source.
- hatyc merge request: `packages/party.yaml:1336` and `:448`, with its runtime test; merged before the
  rig's pin carries PR 4.

## PR 5: G3, G4 (lane C)

- `public-src/components/PictureSource.jsx`: plain segments; the picker branch, `pickerOpenSig`,
  `pickerKey` and `namesEffect` go (`public-src/picture-source.js:24`); `EffectPicker.jsx` goes;
  `AudioReactiveColours` and the Active/Mellow rows move into `ShowEffects.jsx`, keyed to the selected
  effect.
- E: a handler that switches to Show and focuses the effects search; `Shortcuts.jsx` text.
- `public-src/components/GlobalControls.jsx:82-94`: no Freeze button; Resume only while
  `control.frozen`, in a reserved slot (`public/style.css:4132,4150,4211,4253`).
- `docs/agents/header.md`: the replaced bullets get today's words and the new rules.
- Rewritten naming G3/G4: `tests/e2e/top-bar.spec.js` (keeping `:79-100`'s geometry and `:143-160`'s
  photosensitivity and no-latch-change checks), `performance-workflows.spec.js`,
  `header-controls.spec.js`, `global-controls.spec.js` and the component tests that open the picker
  or press Freeze.

## PR 6: G5 (lane C)

- Server: new `src/server/picture-state.ts` (the spec's table: each code's condition and clearing
  event); `picture.ts` keeps `lastFrameAt` in epoch milliseconds, drops the owner's frame on its bad
  frame and keeps `rig-changed` after the prune; `squid-picture.ts` reports loading, failed, no beat,
  no panel and unmapped panel; `engine.ts:253-306` passes the owned units; `renderer.ts` puts the dark
  in the picture's place (`:1036-1047`, `:1101-1155`), the Background not filling it; `state.ts:478`
  `picture.unmet`; `routes/outputs.ts:30-34` the 409; the log lines; `src/shared/effects/v2/zones.ts`
  `stemsFrame` per field.
- Page: `picture-source.js` (text from `unmet` only), `PictureSource.jsx` (amber), `ShowEffects.jsx`,
  `Show.jsx`, `utils.js` `stageMode` note, `StageView.jsx`, `audition.js` and `preview-inputs.js`
  (dark owned units in the demo beat), `public/style.css` (existing `--amber`).
- The e2e rig has no LED panel: add one to a test rig for the Squid cases, with a lit lamp beside it.
- Docs: `header.md`, README (`:206-211`, `:1177`, `:1194-1196`, `:1294-1299`),
  `docs/agents/visualizer.md`.
- hatyc merge request: `packages/party.yaml:449-452` (attribute), `dashboards/ui-lovelace-party.yaml`
  (yellow line), `tests/party_runtime.py`; remove the Plan.md row "Stems in Space with nothing to
  follow" in the same request.

## PR 7: G8 (lane D)

- Inventory first (in the pull request body): every module of the planned show and offline analysis,
  its importers, its subprocess and route edges and the state keys it serves, and the proof it is
  unreachable from the kept set of the spec.
- Commits: the live Python closure moved or fenced first, with `test_live.py` and `test_realtime.py`
  passing; the transport refactor (`control-runtime.ts`, `integrations.ts`, `main.ts`,
  `routes/common.ts`, the state producers); planned show and director; offline analysis and the
  analyzer worker; the Auto Show view's planned parts and rehearsal (retiring PR 1's rehearsal parity
  test); Sources' track services; Perform's Intensity and Now/next and the drawer's DJ link; settings
  keys (old files load, keys dropped, the interpreter migrated); `tests/e2e/helpers.js` seeding Auto
  through a live-input fixture; README and docs.
- tycpve and hatyc merge requests for whatever the deployment or Home Assistant held for these
  (analyzer worker, volumes, environment, models; a dashboard or script naming a removed route). The
  image keeps what the live input needs.

## PR 8: G7 (lane D)

- `public-src/views.js`, `public-src/main.jsx` (menu groups, CommandBar and BottomDrawer off the
  Setup views), the view components named in the spec, `Perform.jsx` (typed BPM, beat division,
  −1/+1), `public-src/components/Inspector.jsx` (Audition on Stage at `:662-664` goes, Hold on live rig
  at `:660-661` stays).
- In-app links and texts, where G8 left them: `Transport.jsx:76`, `AutoMode.jsx:312-313`,
  `TimelineView.jsx:149`, `BpmCapture.jsx:43`, `LiveInput.jsx:22`, README `:363-364`,
  `src/main.ts:295`, `src/server/preflight.ts:309,320,331,339,362,396`, `src/server/apply.ts:213`,
  `public-src/components/setup/specs.js:258,269`.

Hash and key map; every row keeps working, from the menu, a reload and back/forward:

| Today | Key | After G7 |
|---|---|---|
| `#show` | 1 | Show |
| `#effects`, `#manual` | 2 | Effect settings |
| `#perform`, `#perform/pads` | 3 | Perform, Pads (bare `#perform` keeps the remembered tab) |
| `#perform/matrix`, `#matrix` | | Perform, Matrix |
| `#stage` | 4 | Rig, Room (`/?performance=1#stage` still mounts the full stage) |
| `#auto`, `#auto/show`, `#auto/timeline`, `#timeline` | 5 | Music, Auto show |
| `#sequence` | 6 | Sequence |
| `#rig`, `#rig/plan`, `#rig/profiles`, `#rig/outputs` | 7 | Rig and the named panel |
| `#sources` | 8 | Music, the panel last used (Live input the first time) |
| `#settings` | 9 | Settings |
| `#preflight` | 0 | Settings, Check |

## Home Assistant contract

Read from hatyc main (`packages/party.yaml`, `tools/gen_party_deck.py`); the lane re-reads hatyc main
before its pull request, and a route that changes gets the hatyc change in the same rollout.

| Method | Routes |
|---|---|
| GET | `/api/state/live`, `/api/control`; the deck generator `/api/state`, `/api/effects`, `/api/sequences` |
| POST | `/api/control`, `/api/outputs/disarm`, `/api/tap`, `/api/cues/by-name/{name}/recall`, `/api/pattern/{id}`, `/api/strobe/on`, `/api/strobe/off`, `/api/strobe/burst/{ms}`, `/api/pads/{bank}/{slot}/once?ms=`, `/api/pads/{bank}/{slot}/toggle`, `/api/picture/source`, `/api/sequence/{pause,next,prev,shuffle}`, `/api/tempo/{mode}`, `/api/safety/acknowledge`, `/api/master/{value}`, `/api/bpm/{value}` |
| PUT | `/api/palette-override`, `/api/sequence`, `/api/audio` |
| DELETE | `/api/voices`, `/api/palette-override`, `/api/sequence` |
| POST, fallback only | `/api/outputs/arm`, `/api/play`: used only when GET control answers 404; under explicit transport they refuse, and keep refusing |

Shapes it reads: from `/api/state/live` `armed`, `bpm`, `pattern`, `palette`, `masterDimmer`,
`masterBlackout`, `running`, `energyOverride`, `tempoMode`, `voices`, `pads`, `paletteOverride`,
`safety`, `clock.source`, `clock.bpm`, `audio.mode`, `audio.listening`, `sequence.loaded.id` (`loaded`
may be null), `sequence.playing`, `paused`, `mode`, `loop`, `picture.source`; from GET control `ok`
and `control.version`, `session`, `revision`, `programme`, `blackout`; action replies keep `ok` and
`control`; the deck needs `effects.builtin`, `effects.user`, `effects.palettes.builtin`,
`effects.palettes.user`, `state.pads.layout` and `sequences.sequences`. The end-to-end contract:
GET control, Arm, Auto start from a fresh snapshot, cue recall; the cue's look holds 30 s, then the
director continues, with Freeze, Blackout and the picture source unchanged.

## Rollout

The coordinator merges each reviewed, green pull request. hatyc merge requests that stop Home
Assistant sending something the lightshow will refuse (G9's `inspired`) merge before the pin moves.
Before the pin carrying PR 4 moves, the coordinator checks the recorded config for `inspired` and
for saved `v2.visualizer` looks. The pin (`ansible/roles/docker_vm/files/voice/lightshow/
docker-compose.yml`, commit and tag together) moves once the rig is disarmed and Party is off
(`sensor.house_mode_code`, `binary_sensor.lightshow_armed`), and the coordinator checks the live page
against the spec.
