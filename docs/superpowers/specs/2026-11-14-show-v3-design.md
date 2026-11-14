# Show v3: design

Written 2026-11-14 on the operator's "build v3". Base: main at `14930d49`. The operator reviewed
an interactive draft that day (kept outside this repository); it is a mock with a simplified state
machine, so it fixes arrangement, controls and texts, and this document fixes behaviour against the
real runtime. This file and its plan are dropped once v3 is live and README describes it; the
rulings move to `docs/agents/header.md`.

## The operator's words

All 2026-11-14, times in UTC.

1. 00:24 "that i like biold it dont forget that 3d should be dfault"
2. 02:29 "the hole color wheel inclusive colour orcder should collapse and just leave the colour
   pallets, which then could be 2 nex to each other?, but i think would be better to move color
   pallets to the rtight top and the colour wheel below backround stays and we have effects behind
   preview 3d window 1-5 next to each other scaling with page width?"
3. 02:29 "also what is the reasdon to have the preview look bnutton and the look play button?"
   02:32 "so to preview i need to klick look an preview? why? also preview runs local in browser
   right?"
4. 02:30 "also why do i need to stop playback for the change from look to auto? any technical reson
   at all?="
5. 02:33 "if not we should make sure it stops automatically, lets say 60min or somethign?? i mean if
   show is not arm and page is idel or closed"
6. 02:39 "uv wash is brocken effect? dop we need it at all? we have button for that right?"
7. 03:11 "why do we have look an auto show? shoudlnt we not only need a toggle for auto show on off?
   look is bascially the are called picture?"
8. 03:11 "the rest seem alright" (on the draft that showed Show, Perform and Setup, with the
   sequence shelf and Stop pads on Perform and one Play/Stop in the header)
9. "the removal of look dropdown button. thats for sure"
10. "we donnt do hardoced shit" and "we scale dynamic"

## What v3 replaces

- `docs/agents/header.md`, "Play is one split button, '▶ Look ▾' with Auto show and Sequence in its
  menu": replaced by words 4, 7 and 9.
- `docs/agents/header.md`, the last bullet (effects beside the stage, Colours under the stage, only
  the wheel folds): replaced by words 2.
- "Outputs off means the lamps are drawn off, Preview look shows them" (the stage's disarmed
  rule since the commit that drew a disarmed rig off): replaced by words 3. What that rule
  protected stays a goal: nobody may take a preview for light in the room (G6).
- Ten top-level views: replaced by words 8.

Everything else in `header.md` stays: same place on every tab, no duplicates, Freeze and Blackout
never change as a side effect, Blackout and Disarm never behind a menu, the picture source control
first, Armed shown by the Arm button, 44 px touch targets, the Visualizer segment naming no effect.

## One new state key the goals share

`control.layers` (additive, boolean): true while a layer that only Stop clears is on, which is a
lit voice (pad), a held energy effect or Identify; the three things `stop` ends beside the
programme (`src/server/control-runtime.ts`). G4, G6 and G7 read it, so the browser never rebuilds
"something plays" from its own fields.
Test: unit, "`layers` is true for a raw or pending voice, a held energy effect and Identify, and
false after Stop".

## Goals and the test that proves each

**G1. One Auto show switch (words 7).** The header has one `role="switch"` named "Auto show". It is
on exactly when the programme is `auto`. On sends `select` with programme `auto`, Off sends `select`
with programme `look`. It keeps no state of its own and is disabled while a control action is
pending. The server checks Auto's music input only when Auto would start: switching while a
programme plays is refused without an analysed track or a listening input (the switch stays off,
the existing fault toast says the server's sentence); switching while stopped succeeds and the
refusal comes on Play.
Tests: unit and e2e, "the header has one Auto show switch and it follows the programme"; "a refused
switch while playing leaves the programme and the switch as they were"; "stopped, the switch turns
on and Play says why it cannot start".

**G2. No Look button, no programme menu (words 9).** The header has no control named "Look" or
"Programme", no `menuitemradio`, no popover on Play.
Test: e2e, "the header has no Look button and no programme menu", on every view.

**G3. Switching never starts or stops playback (words 4).** With the programme playing, frozen and
a pad lit, flipping the switch changes `control.programme` and nothing else: `playing`, `frozen`,
`blackout`, `armed` and the lit pad are unchanged. Stopped, it stays stopped.
Test: e2e, "the Auto switch changes the programme and nothing else", both directions, playing and
stopped.

**G4. One Play/Stop button.** It reads "Stop" and sends `stop` while `control.playing` or
`control.layers` is true, so Stop is in reach in every state it clears something: a playing
programme, a paused sequence, pads lit over a stopped programme. Otherwise it reads "Play" and
sends `start`. Its accessible name says what it starts: "Play selected picture", "Play Auto show",
"Play sequence <name>" (the name from the sequence status; "Play sequence" when none is loaded,
and the server's refusal then says to load one). No second play button anywhere.
A paused sequence resumes on Perform: the timeline's Pause becomes a Pause/Resume toggle whose
Resume sends the control's `start`, since the sequencer's pause is one-way.
Tests: unit, "the play button names what it starts"; e2e, "Stop is offered while pads light a
stopped programme and clears them" (replaces the menu's protective-stop test); e2e, "a paused
sequence resumes from Perform and its position moves on".

**G5. Sequence is chosen on Perform (words 8).** Perform shows the sequence shelf with "Select
sequence" and, once a sequence is the programme, "Use selected picture".

- Select sends `select` with programme `sequence`; running or stopped stays as it was. It loads
  the sequence first only when its id differs from the loaded one: a reselect sends no load and
  never restarts it. A loaded sequence that is not saved is selected as it is, with no load. The
  existing confirmation before replacing a loaded sequence stays.
- The server refuses a load while a sequence plays or is paused: the refusal's sentence is shown,
  the programme and the loaded sequence stay unchanged.
- Use selected picture sends `select` with programme `look`. Sequence, then Auto on, then Auto off
  ends on `look`, never back on the sequence.
- Leaving a stopped sequence lets its held picture go without starting anything, so a later Play
  of the selected picture shows that picture and nothing of the sequence.
- A link opens the sequence editor.

Tests: e2e, "a sequence is selected on Perform and played from the header" (with the reselect, the
unsaved loaded sequence and the Sequence, Auto, Off path); "a load refused while the sequence
plays changes nothing"; "after a stopped sequence, Play of the selected picture renders nothing of
the sequence" (rendered frame, not a label).

**G6. The stage previews by itself (words 3).** No view has a Preview look button. Disarmed, a stage
drawing is never dark for want of a click. In order of precedence:

| State | The stage draws | Tag |
| --- | --- | --- |
| Rehearsal, audition | as today (an audition ends on Arm, as today) | as today |
| Blackout | the server's feed, dark, with the existing note | Blackout |
| Armed | the server's feed, whatever plays | Live output |
| Disarmed, and `control.playing`, `control.layers` or Freeze | the server's feed, which is what arming would send | Preview (disarmed) |
| Disarmed, none of those | the selected look, sampled in the browser on the built-in demo beat | Preview · demo beat |

The demo-beat preview uses the sampler the effect audition already uses, with the live look in
place of the audition's demo patch: the selected effect with its effect colours, the palette and
its override, the band colours, master and Background, mapped as `preview-inputs.js` maps them for
the stage today, and the look's own `flashLimit` in the patch. It loops the demo track. It sends
nothing to the server, so it cannot start playback. It never acknowledges the photosensitivity
warning for the operator. Arming drops the sampler in the same render, in 3D and in 2D; armed, the
stage shows only the server's feed.
Rehearsal is unchanged by v3, including that it has no Arm guard today; that is listed under "Not
in v3".
Tests: unit, `stageMode` for every row. E2e with WebGL: "stopped and disarmed, the stage shows the
selected look without a click" (stage motion at or above the motion floor of
`docs/agents/validation.md`, `running` false, no POST to `/api/control`, tag "Preview · demo
beat", in 3D and 2D); "the stopped preview follows an edit of the effect, the palette, a band
colour, the master and Background" (both formats, playback still stopped); "a rapid effect is
limited in the stopped preview as on the rig" (sampled values, not motion); "arming during the
stopped preview and during an audition leaves only the feed" (both formats); "armed and stopped,
with Background off and no layer, the stage is dark, and with Background on it shows Background";
"no view has a Preview look button"; "a stored `lightshow.previewLook` is removed and changes
nothing".

**G7. A disarmed show nobody attends stops after 60 minutes (words 5).** Two halves, one number:
`outputs.idleStopMin`, default 60, 0 never. It is in the settings schema, in the Settings view and
in the live state, so a page that never opens Settings follows a change of it.

- Server: while disarmed and `control.playing` or `control.layers` is true, 60 minutes without
  activity end playback with the same `stop` the header sends. Activity is an accepted control
  action and a page's `activity` event, nothing else: polling clients and status reports that POST
  must not keep a show alive. Arming, or nothing left to stop, clears the count. Never while armed;
  the armed idle disarm is unchanged.
- Page: it sends `activity` on deliberate input (pointer down, key, wheel, touch), at most once a
  minute. After the same number of minutes without input while disarmed it releases its `dmx` and
  `picture` feeds, stops the demo-beat preview and shows "Preview paused after 60 minutes without
  input." with "Resume preview". Resume brings the feeds and the preview back and starts nothing.
  Arming also resumes. Armed, the page timer does not run.

A closed or hidden page holds no feed today and sends no activity, so the server half covers it.
A remote that leaves a disarmed programme running on purpose sets `idleStopMin` to 0; README's
remote and disarm sections say so, and that a sequence stopped this way starts from the top.
Tests: unit, "a disarmed show stops after the limit without activity" on the real predicate
(programme, a raw voice, a paused sequence; armed never stops; activity restarts the count; 0
never stops; a stop that throws runs again; a POST that is not a control action does not count);
integration, "arming after the idle stop works and the armed idle disarm still fires"; unit, the
feed gate with an injected clock; e2e with the page clock, "an idle disarmed page releases its
feeds and Resume brings them back" (`/api/health` lists no `dmx` under `awake`, `control.playing`
unchanged by Resume), and "a changed limit, 0 included, reaches a page that never opened Settings".

**G8. The Show layout (words 2).** Left column: stage, then effects. Right column: Palettes, the
"Edit colours" fold, Background. On a phone: Stage, Effects, Palettes, Edit colours, Background.

- Effects: name-only tiles in one to five columns by the card's width and the text size, in a
  contained scrolling box with search; the description is the tile's tooltip; the rapid-flashing
  mark stays. Current effect / Selected effect and the Visualizer sentence stay as merged in #201.
- Palettes: two columns where readable, one where not, with search and the selected palette named.
- One button folds the colour wheel and the colour order together. It is folded on first open and
  remembers the choice under a new storage key; the old `lightshow.show.colourWheel` is removed
  and its value changes nothing.
- Effects that keep a palette per band keep that form; the split applies to the single effect
  palette.
- A cue row under the stage: recall a saved cue, save the look as a cue. Saving opens a small
  dialog with the name; it uses the save that `Cues.jsx` owns today (extracted, not copied) and
  the existing routes, keeps the typed name when the save fails, and returns focus on close.

Tests: e2e, "Show puts the stage over the effects and the palettes over the fold and Background";
"the effects grid has one to five columns by width" (five widths); "one button folds the wheel and
the colour order, folded on a fresh browser, remembered over a reload, deaf to the old key"; "a
cue is saved and recalled from Show" (with cancel, a failed save keeping the name, and focus).

**G9. Sizes scale (words 10).** The Show block of `public/style.css` keeps no px length (the
existing unit test) and gains two rules: width steps are only 35, 47.5, 68.75 and 120em, and no
script computes a size (the ResizeObserver in `Show.jsx` goes). Columns, list heights and the
preview's height come from CSS. The floors are the final draft's: in two columns a list is never
shorter than four rows of tiles and the preview never flatter than 3:1 of its own width, nor lower
than main's `--show-stage-min`; when they do not fit, the page scrolls, it does not squeeze them.
Tests: unit, `show-css.test.js` extended for the width steps; e2e, "Show does not scroll sideways
at 320 and 390 wide, at 100 % and 200 % text"; "at 1280 by 720 the stage and the effects list keep
their floors".

**G10. The utility effects leave the Show list (words 6).** The Show list and the header's effect
picker omit the catalogue family of utility effects (`own.energy`: the strobes, Blinder, UV Wash,
Kill, Glow and the strobe overlays, eleven rows). The ids keep playing from pads, cues, sequences
and the API, and a look whose effect is one of them is still named on Show and in the header. The
Effects view keeps them. The server catalogue is unchanged (a remote reads it).
Test: e2e, "Show and the header picker omit the utility effects and still name one that is
selected": the excluded ids by name, the exact count of the rest, the retained name in both places.

**G11. A hand pick under Auto says it holds.** The live director's status gains `holding`: true
from a hand pick until the director takes its next look, false while the director is not active.
The hold ends on the first bar after its time is up, not on the clock, so the key is a boolean and
the state message that carries the director's next look clears it. While it is true, Show says
that Auto holds the picked look. Only the live director holds; a planned track show gets no label.
Tests: unit, "the director reports holding until its next look" (a pick, time up before the bar,
the bar, Stop); component test for the label.

**G12. Show, Perform and Setup (words 8).** The strip has two tabs, Show and Perform, and a Setup
menu button. Every other view is an entry of the menu, opens by its present hash, alias and digit
key, and keeps its `#panel-` id. Each panel keeps an accessible name when its tab is gone. Arrow
keys move between the two tabs; the menu opens with Enter, Space and ArrowDown, moves with the
arrows, Home and End, closes with Escape and returns focus to its button. The marker that Auto
Show's analysis or timeline is busy moves from the Auto Show tab to the Setup button, visible with
the menu closed, and stays on the entry. "Stop all voices" on Perform reads "Stop pads".
Tests: e2e, "the strip has Show, Perform and Setup, and every former view still opens" (menu
entry, hash, alias and key for each of the ten); "the Setup menu works from the keyboard";
"a busy Auto Show marks the Setup button"; the accessibility scan of every view stays green.

**G13. 3D stays the default (words 1).** Kept test: the stage opens in 3D, 2D selectable.

## Decisions that are not the operator's words

- G7's server half. The draft only paused the page's preview. The operator's sentence is about the
  show stopping; the answer they got at 02:33 was "stop playback after 60 minutes without activity
  from any Show page, including after all pages close, provided the rig is disarmed".
- G6's demo beat. A stopped show has no music position, so the local preview needs a beat; the
  tag says which. A stage that keeps its `dmx` feed while it previews locally is accepted: pads
  and a start from elsewhere must show at once, and G7 bounds the cost.
- G4's Stop while pads light a stopped programme: one button cannot offer Play and Stop at once,
  and Stop is the protective one. Play is one press later.
- G12's menu contents. The draft named four destinations; every existing view stays reachable, so
  the menu lists them all.
- G9's floors. The draft got them in its last revision, after a measurement at 1280 by 720 showed
  a preview 150 px high and a list of two rows.

## Unchanged contracts

No route a remote calls changes shape: `GET`/`POST /api/control` (`version`, `session`,
`revision`, `action`, `programme` in `look`, `auto`, `sequence`), `GET /api/state/live` (additive
keys only), `GET /api/effects`, the cue, pattern, pad, strobe, voices, outputs, sequence, picture
source, palette override, audio, tempo, tap, master, bpm and safety routes. Every startup stays
disarmed. Flash limits, the photosensitivity acknowledgement and Blackout behave as before.

## Not in v3

- The remote party deck in the home automation repository follows in its own change.
- An effect that draws activity without any audio input is a separate defect.
- Whether UV Wash misbehaves on a rig is unverified and not part of this.
- A rehearsal draws its timeline on the stage while armed, under its own tag. Found in review,
  not changed here.
