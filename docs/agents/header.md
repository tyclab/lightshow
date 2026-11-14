# Header (top bar), view strip and Show rulings

Read before changing the header, the picture source control, play/stop, Freeze,
Blackout, Arm or the master, the view strip under the header, or the Show view. The
header was built from the 2026-11-05 brief (#108, revised in #113 and #126), the Show
view and the strip from the 2026-11-14 draft (#204 to #210); their full text is in git
history. The rulings below stay.

## The operator's words

2026-10-28, the rulings the header keeps:

- "the main controls should stay same place all the time, so we dont need to search for them.
  also they should not be duplicated elsewhere? nor be indirectly used" (12:31)
- "make sure blackout and freeze are not activated unwanted" (11:33)
- "much simpler doesnt mean better" (11:32)

2026-11-05, why the header was redone:

- "i hate lightshow webfrontend design. where is my visualizer to select? also what sense has programme on top?"
- "visualizer colour and effect should be part of top bar? the whole new top bar design don't really like"
- "why do we show colours if we dont have the option? like visualizer or we follow visualizer colour?"

2026-11-07, on the Arm button: "armed we see on the button itself right?"

2026-11-08: "the visualizer button doesnt make sense for me. why does it has effects to select?"

2026-11-14 (UTC), on the Show v3 draft:

- "why do i need to stop playback for the change from look to auto? any technical reson at all?=" (02:30)
- "why do we have look an auto show? shoudlnt we not only need a toggle for auto show on off? look is
  bascially the are called picture?" (03:11)
- "the removal of look dropdown button. thats for sure"
- "the rest seem alright" (03:11), on the draft that showed Show, Perform and Setup in the strip,
  with the sequence shelf and Stop pads on Perform and one Play/Stop in the header.

## Decisions

- Same place on every tab, no duplicates, nothing changes Freeze or Blackout as a side effect.
- Nothing is shown that does nothing in the current state: colour controls say what drives the
  colour instead.
- Anti-goals, a failure even if it works: Blackout or Disarm behind a menu; a second play button
  elsewhere; a colour picker that changes nothing; a header that wraps to three rows on a laptop.
- When the room looks wrong the operator changes the effect first (2026-11-07). The picture source
  control stays first; its Effects and Colour + motion segments name the main effect with its
  picker one tap away. Switching effects must be the fastest action in the header.
- One Play/Stop button and one Auto show switch (2026-11-14). Switching the programme never starts
  or stops playback, and keeps pads, Freeze, Blackout and Arm. Stop is offered whenever it would
  clear something: a programme playing or paused, or pads over a stopped programme (the control's
  `layers`). Play's name says what it starts. A sequence is selected on Perform; no Look button,
  no programme menu.
- A stage previews by itself (2026-11-14): "also what is the reasdon to have the preview look bnutton
  and the look play button?" and "so to preview i need to klick look an preview? why? also preview runs
  local in browser right?". No view has a Preview look button. Disarmed and stopped, with no layer and
  no Freeze, the stage draws the selected look in the browser on the built-in demo beat, tagged
  "Preview · demo beat", with the look's own flash limit; it sends nothing and never gives the
  photosensitivity acknowledgement. Playing, a layer or Freeze shows the server's feed as "Preview
  (disarmed)"; armed, only the feed, and arming drops the demo beat at once, in 3D and 2D. Blackout
  outranks both; an idle page draws nothing until Resume preview.
- A disarmed show nobody attends stops after 60 minutes (2026-11-14): "if not we should make sure it
  stops automatically, lets say 60min or somethign?? i mean if show is not arm and page is idel or
  closed". `outputs.idleStopMin` (60, 0 never) without a control action or page input ends it with the
  header's Stop; an idle page releases its feeds and says "Preview paused after 60 minutes without
  input." with Resume preview, which starts nothing. Armed, neither runs.
- The strip under the header has two tabs, Show and Perform, and a Setup menu that holds every
  other view (2026-11-14). Every view keeps its hash, alias and digit key. Perform carries the
  sequence shelf and Stop pads. A view switch writes its hash once, at the switch: nothing writes
  it again after a navigation the page did not cause.
- Visible without a tap: BPM and Online, in the one status chip. Armed is shown by the Arm button
  itself, so its armed state must be unmistakable, not a status pill (2026-11-07).
- Visualizer names only the picture source (2026-11-09). The effect family `ldj.visualizer.*` is
  called Audio-reactive; its ids stay, because saved shows, cues and Home Assistant scripts name
  them. Visualizer Flow and Visualizer Drift keep their names.
- The Visualizer segment names no effect and opens nothing (2026-11-09). It reads "Visualizer",
  with the picture's hint line as its tooltip; E does nothing while it is chosen, and choosing it
  closes an open picker. The main effect, which still shows while no picture arrives, is chosen
  under Effects or Colour + motion.
- Freeze, Blackout and Arm keep their own buttons at fixed positions with 44 px touch targets.
  Keep every current label reachable, and never name the apps the lightshow was ported from.
- Show (2026-11-14, 02:29): "the hole color wheel inclusive colour orcder should collapse and just leave
  the colour pallets, which then could be 2 nex to each other?, but i think would be better to move color
  pallets to the rtight top and the colour wheel below backround stays and we have effects behind preview 3d
  window 1-5 next to each other scaling with page width?" The stage over the effects on the left; Palettes,
  the "Edit colours" fold and Background on the right; on a phone Stage, Effects, Palettes, Edit colours,
  Background. Effects are name-only tiles, one to five columns by the card's width and the text size, in a
  contained, searchable list with the chosen effect pinned beside the search; the description is the tile's
  tooltip, and tiles that share a name show their family on a second line.
  It says Current effect only while the show plays unfrozen, Selected effect otherwise. While the Visualizer
  source has a picture arriving, the card shows one sentence about it and nothing to choose. Palettes names
  the selected palette over its list, two columns where readable; one button folds the colour wheel and the
  colour order together, folded until it is opened. An effect with a palette per band keeps its Bands card.
  A cue row under the stage recalls a cue or saves the look as one. The stage opens in 3D; 2D remains
  selectable. Detailed effect controls stay in Effect settings. Show scales with the window, "we scale
  dynamic" and "we donnt do hardoced shit": its block in style.css has no px and no script sizes it, widths
  step only at 35, 47.5, 68.75 and 120em, the columns follow the view's own width at 68.75em, and in two
  columns a list keeps four rows of tiles and the preview 15rem and a third of its width; when those floors
  do not fit, the page scrolls.
- The open colour editor makes the page longer; it does not take the palettes' room (2026-11-14, 15:17: "the
  colour wheel should move or resize the panel not go over it"; asked which, the operator chose "Push down").
  In two columns the palette list is what the window leaves, so an editor inside that share shrank the list
  and cut its last row. A style sheet cannot add a box's own height to the window's share, so the editor
  publishes its height as the bars do (`--show-editor-height`) and the style sheet adds it: the palettes and
  the stage keep their height, Background moves down and the effects list takes the added height. That is
  the one height a script reports to Show; no script sets a size.
- The utility effects (the catalogue's `own.energy` family: the strobes, Blinder, UV Wash, Kill, Glow and
  the strobe overlays) are not offered on Show or in the header's effect picker (2026-11-14, 02:39: "uv wash
  is brocken effect? dop we need it at all? we have button for that right?"). Pads, cues, sequences and the
  API still play them, a look whose effect is one of them is still named, and Effect settings lists them.
