# Show v3 fixes: design

Written 2026-11-15 on the operator's "Build all" and revised the same day after an independent review
of this spec and its plan. Base: main at `91d0b405` (the rig runs `a34b1bb5`; `91d0b405` adds only the
live-audio visualizer page). It answers the operator's questions about Show v3 and the regression
review of #204 to #213 and #212. This file and its plan are dropped once the work is live and README
describes it; the rulings move to `docs/agents/header.md`.

## The operator's words

2026-11-15, verbatim:

1. "explain to me why the button top stop preview is removed."
2. "also why on the top effects open the list? also when going to cm and visuilizer and squid?"
   ("cm" is the header's Colour + motion segment.)
3. "also i dont like the defauilt that the scene just playing until conditions for the visulaisizter
   or shquid are matched. that is bullshit and confusion way to basically say precondidtions not met."
4. "also why do walls and floors ceeling not block light? even when invisble they shou.d"
5. "also thing about if setup reiter makes sense in this formn?" ("Reiter" is a tab.)
6. "also why do we have plkay and freese? both very close connected?"
7. "also full regression analyse"
8. "Build all" (02:19 UTC), the answer to: build all the proposed fixes as small pull requests (a
   stage Pause preview button; the header's effect picker removed so effects are chosen only in
   Show's list; Visualizer and Squid with unmet preconditions go dark with a yellow reason instead of
   playing the scene; walls, floors and ceilings block light even when hidden; the Freeze button out
   of the header, Resume shown only while frozen; Setup cut to five entries plus the deletion of the
   planned track show ordered on 2026-11-10; the review's defects R02 to R09 and the config
   recorder's idle stop key).
9. Asked what Colour + motion plays when the chosen look ignores the picture: "this never was
   correctly implemented. that is the real issue. the idea was to have the colour and the effect
   matched to visualizer output without having directly mirro the output. so this means at least
   colour should follow the visualizer colour. open is here if aferage max or whatever. how much
   code/compleity is only for this feature? if it is not much and easily repromted. i would suggest
   to just drop it. if it is a lot of code and not easly removed, we should investigate what is
   needed to imlement propper and build it and rollout". Measured at `91d0b405`: about 115 lines serve
   only it (`src/shared/picture-features.ts`, `src/shared/effects/v2/visualizer.ts`), plus about 25
   lines of wiring in 14 files and 128 lines of its own tests. That is not much, so it is dropped (G9).
10. "Keep on Perform", the answer to: keep the BPM −1/+1 buttons, which only the command bar has, by
    moving them to Perform beside Tap, ÷2 and ×2 (G7).

Words 8 accepted the explanation shown before the question, including: the same unmet rule for
Stems in Space (and for Colour + motion, which words 9 then dropped); Home Assistant's Party start
keeps the stored picture source, so a stored Visualizer with no sender gives a dark room and the
yellow line on the deck; furniture keeps stopping beams and casts no room-light shadow.

## What this replaces

- `header.md`, "its Effects and Colour + motion segments name the main effect with its picker one
  tap away. Switching effects must be the fastest action in the header" (2026-11-07): replaced by
  words 2 and 8 (G3). The v3 draft accepted on 2026-11-14 at 03:11 UTC had plain segments; a patch
  at 05:14, after the acceptance, brought the picker back.
- `header.md`, "The main effect, which still shows while no picture arrives, is chosen under Effects
  or Colour + motion": an agent's sentence (5545f7b6), never a ruling, replaced by words 3 (G5).
  So are README's "two seconds without a frame shows the effects again" and the Squid's "the panel
  shows its effect meanwhile" (#174).
- `header.md` and README, the Colour + motion source: replaced by words 9 (G9). `header.md` keeps
  the operator's idea in their words for a later build.
- `header.md`, "Freeze, Blackout and Arm keep their own buttons at fixed positions": Freeze is
  replaced by words 6 and 8 (G4). Blackout and Arm keep theirs, at the same positions ("the main
  controls should stay same place all the time", 2026-10-28 12:31, `header.md:13-14`).
- `header.md`, G6's "No view has a Preview look button" stays; G1 adds a way to stop the preview,
  which G6 had removed with the button although nobody ruled on it (words 1).
- README, the room lights "no shadows" approximation (#95, README `:290-294`): replaced by words 4
  (G2).
- The 2026-11-10 order "C: delete the planned show with analysis and sources" was never carried out
  (#163 did the rest of C): carried out now (G8).

Everything else in `header.md` stays.

## Goals and the test that proves each

A test that passes with its goal undone is a defect of the test. Where a goal makes something dark,
absent or unchanged, its test also shows the lit, present or changed case.

**G1. A preview can be paused (words 1).** While disarmed and a stage draws a preview, either the
demo beat ("Preview · demo beat") or the server's feed while the show plays, layers hold or Freeze
holds ("Preview (disarmed)", `public-src/utils.js:166-174`), the stage toolbar in 3D and in 2D
(`StageView.jsx`, `StagePreview.jsx`) shows one button, "Pause preview". It enters the state the idle
pause of #207 already has: this page releases its own `dmx` and `picture` subscriptions, the demo beat
stops, the stage shows "Preview paused." with "Resume preview". Resume preview, or Arm, ends it. It
changes nothing on the server: no control action; transport, Freeze, Blackout and Arm stay as they
were; another page keeps receiving and drawing. The pause belongs to the page and is not stored: a
reload previews again (2026-11-14: no click to see a preview). Idle pause and Pause preview are one
state; the note names which started it. Pause preview works with the idle stop off
(`outputs.idleStopMin` 0), which today also turns the idle pause off.
Tests, e2e, each in 3D and in 2D:
- demo beat: Pause preview stops the stage's motion and drops this page's `dmx` and `picture`
  subscriptions (read as `tests/e2e/idle-pause.spec.js:43,70` reads them); Resume preview brings both
  back and the motion resumes;
- server feed: with the show playing disarmed and two pages open, Pause preview on the first page
  drops only its subscriptions; the second keeps receiving frames; `/api/control` (revision,
  `playing`, `frozen`), Blackout and Arm are unchanged;
- exactly one button while disarmed and previewing; none while armed or not previewing;
- Arm while paused ends the pause;
- with `outputs.idleStopMin` 0, Pause preview still pauses;
- a reload after Pause preview previews again.

**G1b. Preview parity and the flash test (review R07, R09).** Audition and rehearsal sample with
`light: true` as the demo beat does, so a fixture with a dimmer channel is drawn as it emits
(`public-src/audition.js:54`, `public-src/rehearsal.js:51`, `src/shared/preview.ts:361`). Audition
also applies the master as the demo beat does, by scaling each fixture's trim
(`public-src/preview-inputs.js:68-75`); today neither path reads the master (`audition.js:39`,
`rehearsal.js:33`). Rehearsal gets only `light: true`, since G8 removes it. The engine half of the
stopped preview's flash test (`tests/e2e/stage-preview.spec.js:211`, today only `changes <= LIMIT`)
gets a positive control: the limited run changes the room's light at least once, and the same effect
with no limit changes it more often than the limit allows, so an all-black feed fails.
Tests: unit, through the real option construction of audition and of rehearsal (not a sampler the
test hands `light: true`): a dimmed fixture is drawn as it emits, and the test fails when either call
site's `light: true` is deleted; unit, audition at masters 255, 128 and 0 matches the engine's frame
for the same look and master; e2e, the strengthened flash test, shown failing against a feed forced
black in the pull request body.

**G2. Walls, floors and ceilings block light (words 4).** In the 3D stage, light stops at walls,
floors and ceilings whether they are drawn full height, cut away or hidden.
- Blockers: one shadow-only mesh built from the room's own geometry in world space at full height:
  every wall of every kind (box, mesh with its openings, prism, cylinder;
  `public-src/stage3d/room-geometry.js:3-18`) and each room's floor and ceiling slab, or the room
  box's floor and ceiling when the room file has no polygons. It is rebuilt when the room changes and
  does not follow the cutaway, which keeps shortening only the drawn walls (`scene.js:201-208`). It
  casts from both faces (`shadowSide` double), so a one-sided mesh wall blocks from either side. It
  sits on a layer only the room lights' shadow cameras render (three 0.187 renders a shadow camera's
  own layers when it has any beyond layer 0, `WebGLShadowMap.js:293`): the main pass never draws it,
  and nothing else casts a room-light shadow, so furniture casts none (words 8). It stays visible to
  three, which skips invisible objects and materials in the shadow pass.
- Room light: the eight room lights (`scene.js:174-179`) cast shadows: maps 256², near 0.05 m, far
  the room box's diagonal, bias set against acne on the test room. Room surfaces receive shadows.
  `shadowMap.autoUpdate` is off; the maps render again when the room, the rig, a light's placement or
  which lights are visible changes (`setRoom`, `placeRoomLights`, `setRoomLight`), never for a colour
  or intensity frame or a camera orbit.
- Cost, as it is: a map refresh renders 8 × 6 = 48 cube faces at 256² (3,145,728 depth texels) of the
  blocker mesh; a steady frame adds the shadow lookups in the room-surface shaders and no draw. With
  the lights' visibility and shadow flags unchanged, a colour or intensity frame links no new program;
  Room light on or off may link once, as today.
- Lights per room: an emitter belongs to the first room in file order whose polygon holds it
  (concave polygons too); one outside every polygon belongs to the room whose polygon is nearest.
  Every occupied room gets one light; with fewer than eight occupied rooms, the remaining lights go to
  the rooms with the most emitters, clustered inside the room. With more than eight, the eight rooms
  with the most emitters get one each (ties in file order) and the rest get no room light: the
  stage's Room light control shows an amber note naming them, and their fixtures' own glow, beams and
  pools still draw. A light sits inside its own room, inset up to 0.3 m from its walls as far as the
  room allows (a room narrower than 0.6 m puts it on its centre line), toward the room's inside, not
  toward the room box's origin (`world.js:339-379`). With no polygons, today's clustering
  over the whole room stays. Room files accepted before stay accepted.
- Beams and pools: one blocker rule for aimed lamps and beam-emission fixtures alike
  (`world.js:47-49`, `:253`, `:275`, `:290`): walls of every kind, floor, ceiling and opaque furniture
  of every kind; a mesh is tested by its triangles after a box test. A pool is clipped to the surface
  and the room it lies in; the pool shaders get the room and surface as data (`scene.js:73-93`).
  Nothing spills under a wall.
- The 2D plot has no room geometry and is unchanged.
Tests:
- unit, allocation: two rooms split by a wall, each light inside the room of its emitters and the
  count eight; nine occupied rooms, eight lit and the ninth named in the note; no polygons, today's
  clustering; a concave room and an emitter outside every polygon placed by the rule; a room 0.2 m
  wide, its light on the centre line;
- unit, a beam stops at a mesh wall, a prism wall, a cylinder, the floor, the ceiling and a mesh
  furniture top, and passes through a mesh wall's opening; a pool beside a wall has no part behind it;
- e2e, rendered on a two-room test room: the far room's floor pixels are the same with the near
  room's lamp lit and unlit while the wall stands, and differ without the wall (the positive control);
  the same with Cutaway walls on, with the wall hidden, and for a lamp 0.1 m from the wall; through a
  mesh wall's doorway the pixels in line with it differ; a lamp just above the ceiling leaves the floor
  as dark as with the lamp off, and just below it lights the floor; a lamp just below the floor leaves
  the walls as dark as with the lamp off, and just above it lights them;
- e2e, after the maps rendered: moving the wall (room edit) or the lamp (rig edit) changes the far
  floor accordingly; a colour-only frame and a camera orbit render no shadow map (counted on the
  renderer);
- e2e, cost: `stage-performance.spec.js` imports `browser-budget.js` (today it measures nothing) and,
  on a room of many walls, measures a rebuild and steady frames apart, both within that budget;
- kept: `tests/e2e/tab-switch.spec.js:308` (no further program links); only the starting number at
  `:295` may change, naming G2. `tests/unit/stage-scene.test.js:89-100` and
  `tests/e2e/stage-mesh.spec.js` stay unless an assertion contradicts G2, which the pull request then
  names.

**G3. The header only chooses the picture source (words 2).** Each segment of the picture source
control (Effects, Visualizer, Squid once G9 is in) is a plain choice: a press on another source
selects it, a press on the chosen one does nothing. No segment names an effect, shows ▾ or opens
anything. The header's effect picker goes. Effects are chosen in Show's Effects list; Setup's Effect
settings keeps its editor. What only the picker had moves into Show's Effects card: the
Audio-reactive Active/Mellow rows and the colour wells (`AudioReactiveColours`), shown while the
selected effect is Audio-reactive, whether stopped, frozen or playing, as in the picker today
(`EffectPicker.jsx:27,45`, `AudioReactiveColours.jsx:43-44`). E switches to Show and focuses its
effects search; it does nothing while typing in a field, under a modal, or while Show's card offers
nothing to choose (Visualizer).
Tests: e2e, for each source, no segment has `aria-haspopup`, a press on the chosen segment sends
nothing and opens nothing, a press on another sends one request and selects it; e2e, E from Perform
shows Show with the search focused, and does nothing while typing, under a modal and under
Visualizer; e2e, the Audio-reactive rows and colour wells show in Show's card for a selected
Audio-reactive look while stopped, frozen and playing, and not for another look. `top-bar.spec.js`
and `performance-workflows.spec.js` stop opening the picker, naming G3, and keep their
photosensitivity and no-latch-change checks (`top-bar.spec.js:143-160`).

**G4. Freeze leaves the header (words 6).** The header is the picture source, Auto show, Play/Stop,
Blackout, Arm and the master. While `control.frozen` is true, one "Resume" button shows after the
master, at the end of the global controls, on every tab, so a hold is never hidden; no slot is kept for
it between Play and Blackout, and its appearing moves nothing (PR 9, the operator's "fix all bugs" on
the milestone review's list, replacing a slot reserved where Freeze was), so Play, Blackout, Arm and the
master keep their positions and sizes (`GlobalControls.jsx:82-94`, `public/style.css:4132,4150,
4211,4253`). `freeze` and `resume` stay in `/api/control` (`src/server/control.ts:103-104`) with
their behaviour: pads refused while frozen, Stop and a programme switch keep Freeze, Home Assistant's
party start leaves it. Nothing else changes about Freeze.
Tests: e2e, no Freeze button while not frozen; frozen through the API, Resume shows on Show, Perform
and a Setup view, and pressing it clears `frozen`; Stop and a programme switch leave `frozen` true;
Blackout and Arm keep their x and width with and without Resume at each viewport (the assertion of
`top-bar.spec.js:79-100`, its Freeze locator adapted); `freeze` and `resume` through `/api/control`
unchanged; hatyc's `test_native_party_start_preserves_freeze_blackout_and_audio_group` stays green.

**G5. An unmet picture precondition is shown, not masked (words 3).**
- Model: the server keeps `picture.unmet`, what keeps the chosen source from painting the units it
  owns; one fact per entry, `{ code, since, detail? }`, `since` in epoch milliseconds (wall clock, for
  display; lease expiry stays on the monotonic clock, `src/server/picture.ts:49`); `[]` when met. It is
  reported whether or not the show plays; the dark below acts while it plays. Each code is a fact the
  server observes, set by one condition and cleared by one event:

  | Source | Code | Set while | Cleared by |
  |---|---|---|---|
  | Visualizer | `disarmed` | outputs disarmed (a lease needs Arm, `picture.ts:53`) | Arm |
  | Visualizer | `unacknowledged` | photosensitivity not acknowledged | the acknowledgement |
  | Visualizer | `no-sender` | no lease; `since` is the last frame's time, or the server's start | a claim |
  | Visualizer | `no-frame` | a lease with no valid frame yet, or its frame expired (2 s) | a valid frame |
  | Visualizer | `rig-changed` | the lease was dropped because the rig changed (kept after the prune, `picture.ts:53-58`) | a new claim |
  | Visualizer | `bad-frame` | the lease owner's last frame was refused (`detail`: why); its earlier frame is dropped, so no frame is held | the owner's next valid frame |
  | Squid | `no-panel` | no DDP grid of at least 2 × 2 (`shared/squid.ts:7-15`) | a rig with one |
  | Squid | `panel-unmapped` | the panel lacks the cell map the renderer needs (`renderer.ts:1101-1102`) | a rig that maps it |
  | Squid | `loading` | the loops decode or resize (`squid-picture.ts:61-70,83-123`) | done |
  | Squid | `loops-failed` | the loops failed to load (`detail`: the error) | a load that succeeds |
  | Squid | `no-beat` | the clock gives no finite beat | a finite beat |
  | Squid | `unacknowledged` | armed and not acknowledged (disarmed counts as acknowledged, `safety.ts:24-25`) | the acknowledgement |
  | Squid | `board-problem` | the panel's board reports it ignores the stream or is unreachable (`detail`: `wled[].problem`, `wled-watch.ts:77-80`) | the report clearing |
  | Effects | `no-stems` | Stems in Space plays with neither stems nor reactive bands | either arriving |

  A frame from a sender without the lease is refused without touching the owner's picture
  (`picture.ts:72-89`). Another sender holding the lease (`BUSY`) is not unmet. A helper that fails
  to capture releases its lease (`tools/browser-visuals/pump.js:83,109`) and shows as `no-sender`;
  its own reason stays on its status page. `board-problem` says what the board reports; the dark is
  sent, but a board that ignores the stream may not show it.
- The rig: while the source is unmet and the show plays, the units it owns emit nothing. Visualizer
  owns every unit without an eligible, valid, unexpired direct pixel stream (an active panel stream
  keeps its panel; an invalid, expired or mismatched one does not, `renderer.ts:1037-1038,1101-1104`);
  Squid owns its panel, and the rest plays the main effect as now; Stems in Space owns every unit it
  draws. The dark takes the picture's place in the order (`renderer.ts:1107-1155`): above the
  sequence, the effect and the Background, which does not fill it as it fills a black picture
  (`shared/background.ts:128`); below voices and pads, overrides, Identify, Freeze's held light and
  Blackout, which keep their order. No frame is held. The base effect is no longer drawn as a
  stand-in (`renderer.ts:1036-1047`). The change to dark goes through the outputs' configured
  transitions like any other change (`shared/hardware-guard.ts:43-58`).
- Stems in Space draws only what arrives: a stem it lacks is zero, not invented
  (`src/shared/effects/v2/zones.ts:73-77` falls back per field; `effects/types.ts:74` lets each stem
  be absent). With neither stems nor reactive bands it draws nothing and `no-stems` names why. Silent
  stems keep their precedence over positive bands (`tests/unit/effects-v2-generators.test.js:183`).
  Bands count only in the reactive audio mode; in tempo mode a left-over band value counts as absent.
- API: `picture.unmet` joins `picture` in `/api/state/live` and `/api/state` (additive). `POST
  /api/picture/source` with `squid` and no LED panel answers 409 with `squid_no_panel` and the
  sentence "Squid needs an LED panel (a DDP grid of at least 2 × 2)", and changes neither the stored
  source nor what renders. Every other choice is accepted while unmet: the sender claims only after
  Visualizer is chosen, so a refusal would never pass.
- Logs: one info line per source change (from, to), per lease claim, release and expiry with its
  reason, and per change of the unmet codes, so Loki shows why a picture was missing.
- The page reads `unmet` and adds no logic of its own (`public-src/picture-source.js:15-21`): the
  chosen segment turns amber with the unmet line as its tooltip ("Visualizer: no picture sender since
  21:03:12", "Squid: no LED panel", "Visualizer: outputs disarmed", "Visualizer: photosensitivity
  not acknowledged"). Under Visualizer, Show's Effects card is one sentence with nothing to choose,
  met or not, and an amber line while unmet; it no longer promises that the main effect shows again.
  Under Squid, and under Effects for `no-stems`, an amber line sits above the list while unmet. The
  stage shows the line beside its tag, and the demo-beat preview draws the owned units dark.
- Home Assistant (hatyc, its own merge request in the same rollout): `sensor.lightshow_picture`
  carries the line as an attribute and the party deck shows it in yellow; a refused Squid toggle
  shows through `sensor.lightshow_last_error` as today. Party start does not set the source
  (words 8).
Tests:
- unit, the codes: each set by its condition and cleared by its event; a foreign frame leaves the
  owner's picture; an owner's bad frame drops its picture until its next valid frame; `rig-changed`
  survives the prune until a new claim; `since` and `lastFrameAt` in epoch milliseconds, and
  `lastFrameAt` survives the lease;
- unit, renderer and engine, room picture, with Fixed Background on and an output transition set: a
  received frame lights the owned units (non-zero bytes); losing the lease leaves them at exactly zero
  once the transition settles, read at the output, not only as the logical colour; a voice, a pad, an
  override and Identify still light their units; Freeze keeps its held light; Blackout wins; a fresh
  valid frame lights them again; switching to Effects plays the selected effect; a unit with a valid
  direct stream keeps it, and one with an expired stream goes dark;
- unit, the same on a Squid panel with a lit non-target lamp that keeps the main effect; each Squid
  code and its recovery; the panel replaced by a rig edit;
- unit, Stems in Space: absent, empty, partial (`{ bass: 0 }`), all-zero and positive stems; bands
  present and absent; tempo mode with a left-over band; no stem invented;
- API: `unmet` in both states; the 409 changes neither the source nor the render; Party start keeps
  the stored source; unit, the log lines;
- e2e: header amber and tooltip, Show's sentence and line, the `no-stems` line under Effects, the
  stage line, and the dark demo-beat units in 3D and 2D. `picture-render.test.js:114,157`,
  `squid-picture.test.js:97,111`, `top-bar.spec.js:143-160` and `show-effects.spec.js:182-235` are
  rewritten naming G5 and keep their feed start, release and expiry, their source transitions and
  Freeze after expiry (`show-effects.spec.js:238` on);
- hatyc, `tests/party_runtime.py` for the attribute and the 409 path.

**G6. Defects from the review.** Each gets a failing test first.
- R02: an idle Stop that throws after `control.ts:102` set `playing = false` is never retried
  (`src/server/idle-stop.ts:38`). The control state changes only after the stop hook succeeded, or
  the watchdog keeps trying while the renderer still plays; the log's "trying again" becomes true.
  Test: the real `GlobalControl` and `createIdleStop` with a stop hook that throws once; the next
  tick stops.
- R03: a sub-tab effect replaces a later navigation inside the same view (`#rig/plan` becomes
  `#rig/outputs`, `public-src/components/setup/SubTabs.jsx:29`). A sub-tab writes its hash only for
  a change the page made, as the view switch does since #210. Test, in the order that fails today:
  a sub-tab change made on the page, then an outside navigation to another panel of the same view
  before the sub-tab's effect runs; the outside navigation wins. Two outside navigations in a row
  pass unfixed and do not count.
- R04: two sequence selections can finish in reverse order (`public-src/components/Transport.jsx`
  `select`): the load and the select are one pending action; the shelf is busy across both, and
  while it is busy the other sequences are disabled, so a press sends nothing. Test: the first load
  delayed; a second selection while busy sends nothing; the first finishes loaded and selected; the
  second then loads; selecting the loaded sequence again loads nothing.
- R05: an earlier cue save closes a reopened Save cue dialog and drops its typed name
  (`public-src/components/ShowCues.jsx:18,65`): a save's result reaches only its own dialog. Test:
  cancel, reopen, type, the first save completes, the second dialog keeps its name.
- R08: a saved palette edited under the same id stays in the list with its old name and colours:
  the memo at `Bands.jsx:105` is keyed by ids only, against the promise at `PaletteLibrary.jsx:62`.
  Test: rename and recolour a saved palette under its id; the list shows the new name and colours,
  and a later selection applies the new colours.
- R06 (the idle pause leaves a rehearsal lit) ends with G8, which removes rehearsal.

**G7. Setup: five entries in three groups (words 5).** #205 moved the eight views 1:1 under their
old names; nobody ruled on the contents. The menu keeps its button and its keyboard behaviour
(arrows, focus, Escape; `public-src/main.jsx:104-177`) and holds:
- Rig: **Rig** (7): Plan & patch, Room, Profiles, Outputs. Room is the Stage view's Room panel with
  the full stage; `#stage` and 4 open it and `/?performance=1#stage` still mounts the full stage.
  The Rig inspector gains Group, Override and Off (from Effect settings' Fixtures card) beside
  Identify; Outputs gains Hardware limits (from Settings).
- Content: **Effect settings** (2, `#effects`, `#manual`): Effects (catalogue and editor) and Cues
  (rename, overwrite, delete; recall and save stay on Show; the names Home Assistant recalls keep
  working). The editor's stage draws the open draft by itself, page-local, and respects Pause preview,
  Arm, Freeze and Blackout; so "Audition on Stage" and its jump to `#stage` go
  (`public-src/components/Inspector.jsx:662-664`), while "Hold on live rig" (`:660-661`) stays.
  **Sequence** (6) unchanged.
- System: **Music** (8; the id and hash stay `sources`): Live input (device, source, room latency,
  status) and Auto show (`#auto`, 5: Follow, Play by ear, its status); bare `#sources` opens the
  panel last used, Live input the first time. **Settings** (9): Show (stop an unattended show, flash
  limit, Hue flash; the Picture source field goes, the header owns it), MIDI, Check (Preflight with
  `#preflight` and 0, the DMX monitor, the log), System (engine, server).
- Leaves the views: Background, Colours, the 2D preview and Stop all voices on Effect settings and
  Stage (Show and Perform have them); the command bar and the bottom drawer. Typed BPM, beat division
  and the BPM −1/+1 buttons (words 10; `CommandBar.jsx:54,83-84`) move to Perform's tempo controls
  beside Tap, ÷2 and ×2.
- Server texts name places that exist (`src/server/preflight.ts:309,320,331,339,362,396`,
  `src/server/apply.ts:213`, `public-src/components/setup/specs.js:258,269`).
- Every hash, sub-hash, alias and digit key keeps opening its place (the full map is in the plan).
  A deep link wins over a remembered tab; reload and back/forward land on the same place; digits 4,
  5 and 0 open their panel, not its remembered sibling.
Tests: `tests/e2e/views.spec.js` rewritten naming G7: the menu shows five entries in three groups;
each old hash, sub-hash, alias and digit opens its new place; a deep link beats a remembered tab;
reload and back/forward; arrows, focus and Escape; unit, the server texts name existing places;
e2e, typed BPM, beat division and ±1 on Perform change the tempo; e2e, Group, Override and Off from
the Rig inspector and Hardware limits from Outputs do what they did; e2e, "Hold on live rig" still
holds a voice.

**G8. The planned track show goes (2026-11-10, "do as proposed", section C).** No track source is
configured in the home this was ordered for, and the live director reads none of the planned show's
settings, so `auto` stays the live director (`src/show/live-director.ts`).
- Removed: the planned show (`src/auto-show.ts`, `src/show/director.ts`), offline track analysis
  (the analyzer worker, its models and the parts of `src/analysis` only it uses), the Auto Show view's
  planned parts (timeline, rehearse, warm, queue, analysis stats, track edits), Sources' track
  services (Spotify, Deezer, playback sources and the DJ link, analysis, models), Perform's Intensity
  and Now/next, the drawer's DJ link, their settings keys and docs.
- Kept, with what they reach, moved out of the planned show's files where they share one:
  - live input: `src/live-input.ts:167,294,523` starts `src/live_input.py`, which imports
    `analysis.live` (`:9`), which needs `config`, `realtime`, `dsp`, `events`, `rhythm.estimate_tempo`
    and `version` (`src/analysis/live.py:68,176`, `realtime.py:8-10`, `rhythm.py:113-115`,
    `__init__.py:1`). This closure stays (it may move, for example to `src/live/`) with
    `tests/python/test_live.py` and `test_realtime.py`. The interpreter setting `analysis.pythonPath`
    (`src/python-env.ts:71`) becomes a live-input key, an old file's value migrating to it; the probe
    stops requiring the offline modules (`python-env.ts:19-20`). No model is downloaded.
  - the live director and its helpers in `src/show/look.ts` and `src/show/score.ts`.
  - transport: `src/server/control-runtime.ts:38,46-57` and `src/server/integrations.ts:408-464` read
    the planned show for Auto's check and for every Stop and switch; they are refactored to the live
    director alone. `src/main.ts:171-173,238-239` keep the live clock and idle disarm; `state.ts:432-488`
    keeps the producers Home Assistant reads; `routes/common.ts:26,31` stops requiring removed types.
  - cues with the live director's 30-second hold of a recalled look (`cues.ts:121` →
    `patch.ts:273` → `integrations.ts:355,457` → `live-director.ts:40`), sequences, pads, MIDI, sACN,
    and every Home Assistant route of the plan.
- Before a module goes, the pull request lists it with its importers, its subprocess and route edges,
  and the proof it is unreachable from the kept set. One commit per subsystem. Deployment changes (the
  analyzer's worker, volumes, environment) go to tycpve in the same rollout.
Tests, on the branch: the live input starts the Python service on a PCM file and lists devices, and
its readings reach the live director and the render; Auto starts, stops and switches with no
analysis present; GET control, Arm, Auto start, cue recall: the cue's look holds 30 s, then the
director continues, with Freeze, Blackout and the picture source unchanged; a sequence plays and
unloads; an old settings file with the removed keys and a non-default `analysis.pythonPath` loads,
drops the removed keys and keeps the interpreter; the Home Assistant routes answer with their shapes
after their mutations (`/api/outputs/arm` and `/api/play` keep refusing under explicit transport);
`tests/e2e/helpers.js:77-83` seeds Auto through a live-input fixture instead of `/api/auto/analyze`.
Tests of removed code go with it; tests of kept code that import `analysis.*` are adapted, not
deleted.

**G9. Colour + motion goes (words 9).** The picture source `inspired` is removed: the header's C+M
segment and its hint (`public-src/picture-source.js:7,17,29`), the Settings option
(`setup/specs.js:261`), `PictureFeatureExtractor` (`src/shared/picture-features.ts`) and its wiring
(`src/server/engine.ts:33,70,255,304,307`, `renderer.ts:52,123,450`, `src/shared/effects/types.ts:10,86`,
`src/shared/preview.ts:119,775`), the effect kind `v2.visualizer` with its two looks Visualizer Flow
and Visualizer Drift, which only work under it (`src/shared/effects/v2/visualizer.ts`,
`v2/presets.ts:104-107`, `effects/controls.ts:255`, `effects/tags.ts:157`, `src/show/look.ts:126`,
`SpatialControls.jsx:95`), the helper's refusal for it (`tools/browser-visuals/state.js:56`), their
tests, the benchmarks' and golden frames' entries (regenerated, not hand-edited) and the docs.
`settings.ts:296` and `validation.ts:34` lose the value. A settings file with `picture.source:
inspired` loads as `effects` with one log line; `POST /api/picture/source` with `inspired` answers
400 like any unknown source. Saved data that names the removed kind or one of the two removed looks
is migrated before its store validates, entry by entry, each with one warning naming it: a saved
look leaves the library; an inline or nested (macro) effect leaves its sequence step, and a step left
with nothing to play leaves its sequence; a pad holding one is emptied; a cue's or the current look's
pattern becomes the default look, its other fields kept. Nothing else in the file changes, and no
store is quarantined: today one invalid entry moves the whole sequence file aside and starts with no
sequences, patterns or pad layouts (`src/server/sequence-store.ts:44-57`, `json-store.ts:45-65`;
validation at `sequencer.ts:155-161,185`, `src/shared/effects/macro.ts:45-51`,
`effects/registry.ts:71`). hatyc, merged before the rig's pin moves:
`lightshow_squid_toggle` drops `inspired` from its sources (`packages/party.yaml:1336`), so a
remembered `inspired` falls back to `effects` as the script already does for unknown values, and the
comment at `:448` loses it.
Tests: unit, an old settings file with `inspired` loads as `effects`; unit, the 400; unit, for each
store (the effect library, sequences with an inline and a nested effect, pads, cues, the current
look), a file mixing removed entries with kept ones loads with the removed ones migrated as above,
one warning each, the kept entries identical and no file moved aside; e2e, the header
shows Effects, Visualizer and Squid; hatyc, leaving Squid with a remembered `inspired` posts `effects`.
Removed with their code: `tests/unit/picture-features.test.js`, `picture-inspired.test.js` and the
cases naming the kind.

## Decisions that are not the operator's words

- G1: the pause is not stored across a reload; idle pause and Pause preview share one state.
- G1b: audition applies the master as the demo beat does (preview parity); rehearsal gets only
  `light: true` because G8 removes it.
- G2: the shadow technique is the house model renderer's (eight 256² maps, near 0.05 m, blockers
  apart from the drawn walls). New here: blockers of every wall kind on a shadow-only layer, the
  per-room allocation, and past eight occupied rooms an amber note instead of a ninth light.
  Furniture stops beams but casts no room-light shadow (words 8 covered it).
- G3: E goes to Show's search; the quick deck of favourites leaves the header with the picker and, since
  PR 9, leads Show's list while the search is empty.
- G4: Resume stands after the master, so Play, Blackout, Arm and the master never move (PR 9; no slot).
- G5: dark, not held; the Background does not fill the dark; a bad frame from the lease owner drops
  its picture; the dark goes through the configured transitions; Squid without a panel refused; the
  codes, their names and their clearing events; only facts the server observes.
- G6: R04 refuses a second selection while the shelf is busy.
- G7: the groups, names and mapping; Override and Off move to the Rig inspector; bare `#sources`
  opens the Music panel last used.
- G8: the live Python closure stays (it may move); the interpreter setting migrates.
- G9: an old `inspired` loads as `effects`; saved entries naming the removed kind or looks are
  migrated one by one with a warning, never by quarantining a store.

## Constraints

- The safety contract of `AGENTS.md`: every start disarmed, Blackout, flash limits, the
  photosensitivity acknowledgement, output shutdown, preview and output parity.
- Home Assistant's contract: every route, method and state key hatyc calls keeps working with its
  shape (list in the plan); additions only, except G9's `inspired`, which hatyc stops sending first.
- Hashes, sub-hashes, aliases and digit keys keep working. Show's style block has no px; sizes scale.
- Public repository: no private address, deployment identity, home's numbers or name of an
  application the lightshow was ported from.
