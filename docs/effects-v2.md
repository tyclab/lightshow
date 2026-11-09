# Effects v2

This document keeps the framework's implementation decisions, its target, the
consolidation steps and the decisions still open. The [README](../README.md#spatial-effects)
describes current controls. Line numbers in the target and the steps refer to `4d4837f`;
they are not the current catalogue.

## Implementation status (2026-10-22)

The operator authorized the full build after reviewing Phase A. There are now 41
named spatial looks, each in room and plan forms, over twelve generators (the nine
planned fields plus Neural, visualizer-derived animation and Globe). Pickers show one entry
per look; the plan form (`v2.<name>.2d`) is a hidden variant that saved shows, aliases
and the editor's Mapping choice (Across layout / Through room, offered only when the
settings use positions) still reach. The additions include
particles, stems in space, diagonal endpoints, build/drop/breakdown choreography,
local Audition and colour sliders. All new-show workflows hide retired rows.

- **Geometry:** room x/z are floor coordinates; y is height in metres. Sweep and
  particle paths accept named anchors or explicit endpoints, including diagonals.
  Plan mode maps explicit x/z continuously into the room's normalized width/depth;
  named anchors use their nearest lamp's plot position. Diagonal plan paths omit
  height; coincident projections use `1 - y / room height` for bottom-to-top motion.
  Room paths retain all three coordinates. An explicit Fireworks launch in Plan
  uses X across and Y from bottom to top, ignoring Z; anchor launches retain their
  nearest lamp's plot position. Dense surfaces still sample individual physical pixels.
- **Selection:** Scatter Strobe/Fade/Grow and Frequency Burst choose places,
  fixtures and physical segments, so cell count does not dominate the random draw.
  Whole-fixture and legacy cell selection remain explicit options. New WLED imports
  use pixels; existing patches are not migrated behind the operator's back.
- **Rest and rotation:** backgrounds and Neural idle default to zero. Explicit
  backgrounds have an independent colour. Rotation has soft sector transitions.
  Popcorn ids resolve to Scatter Fade and are absent from the picker.
- **Composition and safety:** one output-guard owner retains device, lamp and room
  histories across voice changes. White/colour/palette energy strobes use the
  acknowledged overlay. Legacy output adapters retain their hardware semantics.
- **Compatibility:** the old golden files remain unchanged. Version-2 saved specs
  use `compat.*` adapters to preserve authored legacy parameters. Selected old
  preset ids intentionally resolve to modern plan looks; `scripts/effects-v2-alias-diff.js`
  measures their frame differences. Unmapped ids remain hidden compatibility rows.
  **Step 9 is implemented as retirement from the active catalogue, not deletion of
  every legacy renderer or clock:** deleting those would break saved specs whose
  parameter richness has no exact field equivalent. No claim of byte identity is
  made for the explicitly changed aliases.
- **Palettes:** the chooser is curated and includes a hue-pair generator; every
  old palette id remains available through Show all and integrations.
- **Audition:** a typed, deterministic demo source supplies beat, bands, sections,
  stems and picture features to a browser-only Stage sampler. It never sends a
  live look, room, master or arm mutation.
- **Catalogue (2026-11-02):** the Effects view lists every current look once, A to Z,
  with the tags its code states: what it reacts to and where that input comes from
  (analysed track, live input or the screen), whether it covers the whole rig, is
  placed in the room or draws on bars and panels, whether it plays its own colours,
  and whether it is an energy voice or a rapid flash. Multi-select chips filter by
  them; the Spatial, Own and Classic sections are gone. `src/shared/effects/tags.ts`
  derives the tags from kind and params and holds a table for the 59 classic
  patterns; MIDI and Companion browse by the same tags. See the
  [README](../README.md#effects-catalogue-and-tags).

Verification covers original legacy goldens, a separate new-preset snapshot,
room/plan parity, dense-fixture fairness, dark rest, rotation continuity, overlay
permits, stored-library migration, browser isolation and a 3,000-unit benchmark.
The original steps and open questions below explain the design history; the
implementation decisions above supersede the old proposed deletion and blocking
questions. Installation data is never part of these fixtures.

## Deferred physical-rig observations

Moved here from the finished Phase A plan (2026-10-26). Keep these here, not in an
issue tracker. No firmware or wiring experiment is part of the effects work.

- **Curtain blip:** videos show an isolated colour flash just ahead of the wave,
  approximately one camera frame. A later sender capture was clean but was not
  simultaneous with the video, so it does not exclude the sender. WLED output
  timing and signal integrity remain hypotheses, not a confirmed root cause.
  Firmware already includes the older ESP32 RMT priority fix. A future investigation
  needs a simultaneous capture and a controlled output/wiring comparison.
- **Wave onset:** the shallow rising wave moves rapidly across vertical rows;
  coarse couch zones and palette brightness changes can make the onset look
  stepped. Tune against the real rig in a separate operator session; do not change
  saved looks or claim a hardware fix from preview smoothness.
- **Pale colour step:** the current palette's cyan-to-magenta RGB blend passes
  through pale lavender. This is not an explicit white flash. Palette tuning is
  separate from the isolated curtain blip.

## Target

There will be nine field generators and one strobe overlay. Each generator
combines a space selector, motion, an envelope, a colour mapping, modulation
and a background. Every one of these parameters is shared by all generators.

Every generator runs in two spaces, and both are first-class looks chosen per
preset: `room`, the metric 3D space below, and `plan`, the classic 2D stage
plot and patch order that today's patterns use. A classic chase, wave or
sweep across the plot stays a look of its own, not a fallback for a missing
room.

| Generator | Space | Absorbs |
|-----------|-------|---------|
| Wash | none: every unit at once | solid, fade, hit, color-cycle, breathe; `hd.simpleAdsr` presets, `hd.breathingFade`; ldj Glow, Drip, Trance, BeatPulse1/4, QuickFlash, CrossFade, America, MatrixSolid, TriPulse; energy glow, blinder, kill, UV wash |
| Sweep | a plane by azimuth and elevation (90° runs floor to ceiling). Profile is crest, line, comet, gradient or stripe; motion is loop, bounce, random or a turn per lap | wave, ribbon, gradient, comet, room-wave, spatial-wash, bounce-scan, streak, volume-gate (as gate modulation); `hd.spatialWash`, `volumeGateWash`, `bouncingScan`, `streak`; ldj GrooveWave, BigRoomWave, Ascent, DoubleWave, Swagger; the 22 bitmap presets |
| Shell | distance from an origin: the listener, room centre, an anchor or a random unit. A ring, fill or ramp, outward or inward | radial-pulse, burst, impact (sparks as a parameter), flash-fill, ramp, fireworks; `hd.radialPulse`; ldj Impact, Vortex, SceneMakerFirework, MatrixFirework, Cauldron, the Studio fireworks |
| Orbit | azimuth around a vertical axis through the listener. Sectors, gradient or beacon | swirl; ldj Swirl, Rotation, Beacon |
| Step | an order: orbit azimuth, an axis, the unit's own strip path, height or random. Takes a window, trail, direction, envelope (flash, fade, grow, flare), a background (off or a palette slot), stages (1, 3 or 5) and a score | chase, chase-rev, ping-pong, runner, pairs, stack-up, position-chase, flash-chase, flash-alternate, ring-strobe, ring-backlit; about 45 ldj iteration rows |
| Zones | a partition: left/right, front/back, floor/ceiling, near/far from the listener, technology or object role. Alternates, fills or rotates | split, sections, halves, flip, anchor-fill; ldj Split, Flip, FrontBack, RotatingHalfs, TwoCorners, FillCycle, DoubleFill, DoubleDrip |
| Scatter | random units with a density, an envelope (flash, ramp up, ramp down, swell), a cluster radius in metres and optional band triggers | twinkle, sparkle, random-flash, starlight, confetti, flashes, flash-scatter, ramp-scatter, decay-scatter; `hd.twinkle`, `hd.frequencyBurst`; ldj matrix modes, Popcorn; Disco Spectrum and Peak |
| Noise | a 3D noise field drifting through the room | plasma; ldj Perlin, NorthernLights; Fire and Ice |
| Particles | objects in continuous space: sparks on ballistic paths under gravity, drops falling from the ceiling, soft light orbs on splines with trails. Units light by distance to each particle through the spatial hash, so an object moves across every technology in the room | new; fireworks and rain stop being per-unit tricks |
| Strobe overlay | not a look: a deck voice over any base. Selection is all, step, scatter or zone; rate is a beat fraction or Hz under the device cap; shape is flash, ramp, random or burst; colour is palette or white | the eight strobe implementations; the `flash-*` strobe looks; ldj TrueStrobe, PaletteTrueStrobe |

Fill is a profile, not a ninth space: Sweep, Shell and Step fill up to a
threshold that a band level or section progress drives through the shared
modulation (height is Sweep at 90° elevation, listener distance is Shell, a
strip is Step along its path). It absorbs rise, meter, bars, fire, rain, core,
stems, drums, ensemble and Disco Neural.

About forty named presets sit on top of the generators as parameter sets. The
catalogue already resolves aliases (`catalogue.ts:23, 150`), so every retired
id stays playable as an alias. Saved cues, pads, sequences, the MIDI map
(`src/server/midi-map.ts:140-170`) and Home Assistant all refer to ids: an
integration sends `pattern/<id>` and palette ids over REST and reads the
pattern back from the state, so the REST routes must resolve aliases too.

Aliases do not cover saved effects. The effect library
(`src/server/effect-library.ts`) stores `{kind, params}` specs and validates
them against the registered kinds, so retiring a kind would stop its saved
effects from loading. Each retired kind needs a versioned spec migration to
v2 generator parameters, tested on a stored library file.

Presets are parameter sets on a few generators with shared modifiers. They take
the essence of the ported kinds, never their ids, row tables, frame clock or
numeric quirks, and never collapse an effect family into one fixed look: every
generator exposes its parameters. Old ids survive as aliases of the nearest v2
preset.

Macro (Scene Maker), bundle (pad pattern) and sequence remain the show layer.
The Entertainment Visualizer and Studio become a base and accent voice pair and
a pad launch mode instead of kinds.

## Steps

Each step is its own pull request. Every step keeps `npm run check`,
`npm run build:client` and the golden tests green. AGENTS.md's safety
invariants hold throughout: disarmed startup, blackout, the flash limits, the
photosensitivity acknowledgement, output shutdown and preview/output parity.

| # | Step | Look risk | Verification |
|---|------|-----------|--------------|
| 0 | Golden harness: extend `scripts/golden-party-looks.js` (18 looks and 8 effects on synthetic pars) to every catalogue id, base pattern and strobe function, at fixed BPM, seed and beats. Add a committed synthetic rig with pars, Hue channels, pathed strips and a vertical grid. Record per-unit frames, not only hashes, and define the frame diff (the largest channel difference per frame) that later steps use as their tolerance. Add an optional local run against an installation's own config, never committed | none | deterministic frames in CI; the frame diff reports per id |
| 1 | Byte-identical dedupe: one body for solid/fade/hit/strobe; `ldj.PartyStrobe` becomes an alias of `ldj.MatrixPulse`; `ramp-scatter`, `decay-scatter` and `flash-burst` call the strobe programs; the 32 non-effect rows leave the runtime catalogue | none while golden output is equal | frame diff is zero |
| 2 | One flash limiter in the output path, replacing the four. A large-area flash is counted by the share of the room lit, so any selection that lights most of the room stays at three flashes a second when enabled | timing; safety-relevant | golden; a rise-count probe shows no lamp exceeds today's admitted rate (5 Hz Hue cap, every fourth flash at full speed; 20 Hz RGB default; `hd.*` per-lamp interval; three large-area flashes a second when enabled); preview while disarmed |
| 3 | Space plumbing, unused by effects: binding resolver in `src/shared/`, plan fallback, optional listener and anchors in the room schema with a show override, sampling by emitter size, preview parity, disagreement report | none | unit tests; the report on a real room through a read-only GET |
| 4 | Vertical slice and first showpieces: Sweep and Shell, end to end, each in its `room` and classic `plan` version, delivering the shockwave from the speakers and the rising wall. wave, ribbon, gradient and room-wave become Sweep presets beside the old ids | none (additive) | golden for the new ids; Stage preview while disarmed; the operator on the rig; a frame-time check on a rig of a few thousand lights |
| 5 | The other seven generators as new ids beside the old ones, each in `room` and classic `plan` versions, and the remaining showpieces: light objects, 3D fireworks and rain, surround, stems in space, the pixel wall as a window | none (additive) | golden for the new ids; Stage preview while disarmed; the operator on the rig |
| 6 | One strobe overlay kind over the generators' selection spaces. Energy strobes, `palette-strobe` and the hold strobe become overlay presets, and the overlay's rate cap follows step 2's lit-area count | timing; safety-relevant | golden; the step 2 rise-count probe; preview while disarmed |
| 7 | Re-express old ids as v2 presets in `plan` mode. Ids within the step 0 tolerance become aliases, the REST routes resolve them, and the effect library migrates stored specs; the rest are listed | none for aliases; listed ids need an operator decision | frame diff report per id; migration test on a stored library file |
| 8 | 3D defaults and choreography: the look picker, director pools and default pads move to the showpieces and the height, listener and orbit presets; the director plays build, drop and breakdown arcs with contrast between sections. Waits on the decision whether the room is authoritative for effect sampling | look change | Stage preview while disarmed, then the operator on the rig |
| 9 | Retire the `hd.*`, `ldj.*` and legacy engines and their clocks onto the conductor's beat clock; about forty named presets remain | look change for any id that is not aliased | golden for aliases, preview for the rest |
| 10 | Palettes: 54 built-ins to a curated set plus a hue-pair generator, in step with the Home Assistant palette selection | depends on the Home Assistant integration | catalogue check against the integration; palette golden |

## Open operator decisions

- Whether step 8 may change what the auto show and the default pads look like.
- Which ids that fail step 7's tolerance are kept as approximations and which
  are dropped at step 9.
- Whether step 10 may remove palettes, given that Home Assistant selects
  palettes by id.
- Whether the nine Party Looks merge into their `hd.*` twins. The twins already
  sweep different planes.
- Whether Disco folds into Scatter, the fill profiles and the strobe overlay, and whether
  the Entertainment Visualizer and Studio fold into voice pairs and a launch
  mode.
- Whether the room becomes authoritative for effect sampling. Today it is
  preview-only by design; until this is decided, generators default to `plan`
  mode, a room is sampled only when it is chosen explicitly, and step 8 waits.
- One listening position or several, and whether facing is part of the room or
  of the show.
