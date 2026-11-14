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

## Goals and the test that proves each

**G1. One Auto show switch (words 7).** The header has one `role="switch"` named "Auto show". It is
on exactly when the programme is `auto`. On sends `select` with programme `auto`, Off sends `select`
with programme `look`. It keeps no state of its own: a refused switch (the server answers 409
without an analysed track or a listening input) leaves it off and the existing fault toast says the
server's sentence. Disabled while a control action is pending.
Test: unit and e2e, "the header has one Auto show switch and it follows the programme".

**G2. No Look button, no programme menu (words 9).** The header has no control named "Look" or
"Programme", no `menuitemradio`, no popover on Play.
Test: e2e, "the header has no Look button and no programme menu", on every view.

**G3. Switching never starts or stops playback (words 4).** With the programme playing, frozen and
a pad lit, flipping the switch changes `control.programme` and nothing else: `playing`, `frozen`,
`blackout`, `armed` and the lit pad are unchanged. Stopped, it stays stopped.
Test: e2e, "the Auto switch changes the programme and nothing else", both directions, playing and
stopped.

**G4. One Play/Stop button.** It reads "Play" and sends `start` while nothing plays, "Stop" and
sends `stop` while `control.playing` is true, a paused sequence included (its Resume is Perform's
Pause toggle, as today). Its accessible name says what it starts: "Play selected picture", "Play
Auto show" or "Play sequence <name>". No second play button anywhere.
Test: unit, "the play button names what it starts and stops whatever plays".

**G5. Sequence is chosen on Perform (words 8).** Perform shows the sequence shelf with "Select
sequence" and, once a sequence is the programme, "Use selected picture". Select loads the sequence
only when its id differs from the loaded one (a reselect never restarts it), then sends `select`
with programme `sequence`; running or stopped stays as it was. Use selected picture sends `select`
with programme `look`. Sequence, then Auto on, then Auto off ends on `look`, never back on the
sequence. A link opens the sequence editor.
Test: e2e, "a sequence is selected on Perform and played from the header", including the reselect
and the Sequence, Auto, Off path.

**G6. The stage previews by itself (words 3).** No view has a Preview look button. Disarmed, a stage
drawing is never dark for want of a click:

| State | The stage draws | Tag |
| --- | --- | --- |
| Armed | the server's feed | Live output |
| Disarmed, something plays, or Freeze holds a picture, or a pad is lit | the server's feed, which is what arming would send | Preview (disarmed) |
| Disarmed, nothing plays, not frozen | the selected effect, sampled in the browser on the built-in demo beat | Preview · demo beat |
| Blackout | dark, with the existing note | Blackout |

The demo-beat preview uses the sampler the effect audition already uses, fed the live look instead
of a demo patch, looping the demo track. It sends nothing to the server, so it cannot start
playback. It takes the show's own flash limit and never acknowledges the photosensitivity warning
for the operator. Arming ends it in the same render: armed and stopped is dark, as the rig is.
An audition or a rehearsal still outranks it.
Tests: e2e with WebGL, "stopped and disarmed, the stage shows the selected effect without a
click" (stage motion at or above the motion floor of `docs/agents/validation.md`, `running` false,
no POST to `/api/control`, tag "Preview · demo beat"); "armed and stopped, the stage is dark";
"no view has a Preview look button". Unit: `stageMode` for every row of the table.

**G7. A disarmed show nobody attends stops after 60 minutes (words 5).** Two halves, one number
(`outputs.idleStopMin`, default 60, 0 never, shown beside the idle disarm setting):

- Server: while disarmed and something plays, 60 minutes without activity end playback with the
  same `stop` the header sends. Activity is any `/api/` request that is not a GET and a page's
  `activity` event. Arming, or nothing playing, clears the count. Never while armed.
- Page: it sends `activity` on deliberate input (pointer down, key, wheel, touch), at most once a
  minute. After 60 minutes without input while disarmed it releases its `dmx` and `picture` feeds,
  stops the demo-beat preview and shows "Preview paused after 60 minutes without input." with
  "Resume preview". Resume brings the feeds and the preview back and starts nothing. Arming also
  resumes. Armed, the page timer does not run.

A closed or hidden page holds no feed today and sends no activity, so it is covered by the server
half.
Tests: unit, "a disarmed playing show stops after the limit without activity" (injected clock:
armed never stops, activity restarts the count, 0 never stops, a stop that throws runs again);
unit, the feed gate with an injected clock; e2e with the page clock, "an idle disarmed page
releases its feeds and Resume brings them back" (`/api/health` lists no `dmx` under `awake`,
`control.playing` unchanged by Resume).

**G8. The Show layout (words 2).** Left column: stage, then effects. Right column: Palettes, the
"Edit colours" fold, Background. On a phone: Stage, Effects, Palettes, Edit colours, Background.

- Effects: name-only tiles in one to five columns by the card's width and the text size, in a
  contained scrolling box with search; the description is the tile's tooltip; the rapid-flashing
  mark stays. Current effect / Selected effect and the Visualizer sentence stay as merged in #201.
- Palettes: two columns where readable, one where not, with search and the selected palette named.
- One button folds the colour wheel and the colour order together. It is folded on first open and
  remembers the choice under a new storage key; the old wheel key is removed.
- Effects that keep a palette per band keep that form; the split applies to the single effect
  palette.
- A cue row under the stage: recall a saved cue, save the look as a cue. It uses the existing cue
  routes and the existing save dialog.

Tests: e2e, "Show puts the stage over the effects and the palettes over the fold and Background";
"the effects grid has one to five columns by width" (five widths); "one button folds the wheel and
the colour order"; "a cue is saved and recalled from Show".

**G9. Sizes scale (words 10).** The Show block of `public/style.css` keeps no px length (the
existing unit test) and gains two rules: width steps are only 35, 47.5, 68.75 and 120em, and no
script computes a size (the ResizeObserver in `Show.jsx` goes). Columns, list heights and the
preview's height come from CSS: `fr` rows, lists as `flex: 1 1 0` with a floor counted in rows of
touch targets, the preview's floor relative to its own width.
Tests: unit, `show-css.test.js` extended for the width steps; e2e, "Show does not scroll sideways
at 320 and 390 wide, at 100 % and 200 % text".

**G10. Pad effects leave the Show list (words 6).** The Show list and the header's effect picker
omit the family the performance pads use. The ids keep playing from pads, cues, sequences and the
API, and a look whose effect is one of them is still named. The Effects view keeps them. The server
catalogue is unchanged (a remote reads it).
Test: e2e, "the Show list omits the pad effects and still names one that is playing", with the
exact row count.

**G11. A hand pick under Auto says it holds.** The live director's status gains `holdMs`, the
remaining hold when the state message is built, 0 when none. While it runs, Show says that Auto
holds the picked look. The label comes from server state only.
Test: unit, "the director reports the remaining hold"; e2e or component test for the label.

**G12. Show, Perform and Setup (words 8).** The strip has Show, Perform and a Setup menu. Every
other view is an entry of the menu, opens by its present hash and digit key, and keeps its
`#panel-` id. "Stop all voices" on Perform reads "Stop pads".
Test: e2e, "the strip has Show, Perform and Setup, and every former view still opens" (menu entry,
hash and key for each).

**G13. 3D stays the default (words 1).** Kept test: the stage opens in 3D, 2D selectable.

## Decisions that are not the operator's words

- G7's server half. The draft only paused the page's preview. The operator's sentence is about the
  show stopping; the answer they got at 02:33 was "stop playback after 60 minutes without activity
  from any Show page, including after all pages close, provided the rig is disarmed".
- G6's demo beat. A stopped show has no music position, so the local preview needs a beat; the
  tag says which. A stage that keeps its `dmx` feed while it previews locally is accepted: pads
  and a start from elsewhere must show at once, and G7 bounds the cost.
- G12's menu contents. The draft named four destinations; every existing view stays reachable, so
  the menu lists them all.
- G4's Stop for a paused sequence.

## Unchanged contracts

No route a remote calls changes shape: `GET`/`POST /api/control` (`version`, `session`,
`revision`, `action`, `programme` in `look`, `auto`, `sequence`), `GET /api/state/live` (additive
key only), `GET /api/effects`, the cue, pattern, pad, strobe, voices, outputs, sequence, picture
source, palette override, audio, tempo, tap, master, bpm and safety routes. Every startup stays
disarmed. Flash limits, the photosensitivity acknowledgement and Blackout behave as before.

## Not in v3

- The remote party deck in the home automation repository follows in its own change.
- An effect that draws activity without any audio input is a separate defect.
- Whether UV Wash misbehaves on a rig is unverified and not part of this.
