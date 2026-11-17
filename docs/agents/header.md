# Header (top bar), view strip and Show rulings

Read before changing the header, the picture source control, play/stop, Resume,
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

2026-11-15 (UTC), on Show v3:

- "also why on the top effects open the list? also when going to cm and visuilizer and squid?"
- "also why do we have plkay and freese? both very close connected?"
- "also i dont like the defauilt that the scene just playing until conditions for the visulaisizter
  or shquid are matched. that is bullshit and confusion way to basically say precondidtions not met."
- "Build all" (02:19), the answer to building, among the other fixes, the header's effect picker
  removed so effects are chosen only in Show's list, the Freeze button out of the header with
  Resume shown only while frozen, and Visualizer and Squid with unmet preconditions dark with a
  yellow reason instead of playing the scene. The explanation it answered included the same rule
  for Stems in Space, and that Home Assistant's party start keeps the stored source, so a stored
  Visualizer with no sender gives a dark room and the yellow line on the deck.

## Decisions

- Same place on every tab, no duplicates, nothing changes Freeze or Blackout as a side effect.
- Nothing is shown that does nothing in the current state: colour controls say what drives the
  colour instead.
- Anti-goals, a failure even if it works: Blackout or Disarm behind a menu; a second play button
  elsewhere; a colour picker that changes nothing; a header that wraps to three rows on a laptop.
- The picture source control stays first and only chooses the source (2026-11-15, replacing the
  2026-11-07 effect picker one tap from the header). Each segment is a plain choice: another source is
  one tap, the chosen one names no effect, shows no ▾ and opens nothing; its tooltip is the source's
  hint line, or its unmet line. Every segment is as wide as its label, by one rule, chosen or not (2026-11-15, "fix all
  bugs" on the milestone review's list). Effects are chosen in Show's Effects list, and E on any view opens Show with its search
  ready, except while typing in a field, under a modal dialog or while Show's card offers nothing to
  choose (the Visualizer source). Effect settings keeps the catalogue and its editor.
- An unmet picture source is shown, not masked (2026-11-15). The server reports `picture.unmet`, the
  facts it observes, each set by one condition and cleared by one event (README, Unmet picture source);
  the page adds no reason of its own. While the show plays, the units the source owns are dark, never
  the main effect as a stand-in: the dark takes the picture's place, the Background does not fill it,
  voices, pads, overrides, Identify, Freeze and Blackout stay above it, and it goes through the outputs'
  transitions. The chosen segment turns amber with the line as its tooltip, Show's card and the stage
  say it, and the demo beat draws the owned units dark. Squid without an LED panel is refused (409);
  every other source is accepted while unmet. Home Assistant's party start never sets the source.
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
- A preview can be paused (2026-11-15): "explain to me why the button top stop preview is removed." While
  disarmed and drawing either preview, the stage toolbar in 3D and 2D shows one "Pause preview". It is the
  idle pause entered by hand: this page lets its own `dmx` and `picture` feeds go and says "Preview
  paused."; Resume or Arm ends it. It sends nothing, leaves the show and other pages as they are, works
  with `outputs.idleStopMin` 0 and is not stored, so a reload previews again. Paused, by the button or by
  idleness, the toolbar shows "Resume preview" in Pause preview's box, and the note lies over the stage as
  the Blackout note does, so neither the toolbar nor the stage moves ("fix all bugs", 2026-11-15). The
  preview's three tags share one box for the same reason. The Rig view's plan, which has no such toolbar,
  carries the note and its Resume over the plan; a view without a stage (the DMX monitor's fallback) keeps
  its line and its own Resume.
- A disarmed show nobody attends stops after 60 minutes (2026-11-14): "if not we should make sure it
  stops automatically, lets say 60min or somethign?? i mean if show is not arm and page is idel or
  closed". `outputs.idleStopMin` (60, 0 never) without a control action or page input ends it with the
  header's Stop; an idle page releases its feeds and says "Preview paused after 60 minutes without
  input."; Resume preview, in Pause preview's place, starts nothing. Armed, neither runs.
- The strip under the header has two tabs, Show and Perform, and a Setup menu that holds the other
  five views in three groups: Rig; Effect settings and Sequence; Music and Settings (2026-11-14, G7
  2026-11-16). Stage, Auto Show and Preflight are panels (Rig's Room, Music's Auto show, Settings'
  Check). Every hash, alias and digit key that opened a view opens its place (`public-src/views.js`),
  an address that names a panel wins over the remembered one, and the digits 4, 5 and 0 open their
  panel whichever its view last showed. Perform carries the
  sequence shelf and Stop pads. A view switch writes its hash once, at the switch: nothing writes
  it again after a navigation the page did not cause.
- Visible without a tap: BPM and Online, in the one status chip. Armed is shown by the Arm button
  itself, so its armed state must be unmistakable, not a status pill (2026-11-07).
- Visualizer names only the picture source (2026-11-09). The effect family `ldj.visualizer.*` is
  called Audio-reactive; its ids stay, because saved shows, cues and Home Assistant scripts name
  them.
- The Visualizer segment reads "Visualizer" (2026-11-09), as every segment reads only its source's
  name. The main effect is chosen in Show's list; under Visualizer it does not show while no picture
  arrives.
- Colour + motion is gone (2026-11-15), with the effect kind only it fed and its looks Visualizer
  Flow and Visualizer Drift. Asked what it plays when the chosen look ignores the picture, the
  operator answered: "this never was correctly implemented. that is the real issue. the idea was to
  have the colour and the effect matched to visualizer output without having directly mirro the
  output. so this means at least colour should follow the visualizer colour. open is here if aferage
  max or whatever. how much code/compleity is only for this feature? if it is not much and easily
  repromted. i would suggest to just drop it. if it is a lot of code and not easly removed, we should
  investigate what is needed to imlement propper and build it and rollout". It was about 115 lines,
  so it went. The idea stays for a later build: the effect and at least its colour follow the
  visualizer's output without mirroring it; how the colour is taken (average, maximum or another
  rule) is open. Saved looks, clips, pads and cues that named it are migrated when they load, one
  warning each, and a stored `inspired` source loads as Effects.
- Blackout and Arm keep their own buttons at fixed positions with 44 px touch targets. Freeze has no
  button (2026-11-15): while the picture is frozen, one Resume shows after the master, at the end of the
  global controls, on every tab, so a hold is never hidden. Nothing is kept for it between Play and
  Blackout, and its appearing moves nothing: Play, Blackout, Arm and the master keep their positions and
  sizes ("fix all bugs", 2026-11-15). On a phone the second row has no free width, so its end stays for
  Resume. `freeze` and `resume` stay in `/api/control` with their behaviour (pads refused
  while frozen, Stop and a programme switch keep Freeze, Home Assistant's party start leaves it). Keep
  every current label reachable, and never name the apps the lightshow was ported from.
- Show (2026-11-14, 02:29): "the hole color wheel inclusive colour orcder should collapse and just leave
  the colour pallets, which then could be 2 nex to each other?, but i think would be better to move color
  pallets to the rtight top and the colour wheel below backround stays and we have effects behind preview 3d
  window 1-5 next to each other scaling with page width?" The stage over the effects on the left; Palettes,
  the "Edit colours" fold and Background on the right; on a phone Stage, Effects, Palettes, Edit colours,
  Background. Effects are name-only tiles, one to five columns by the card's width and the text size, in a
  contained, searchable list with the chosen effect pinned beside the search; the description is the tile's
  tooltip, and tiles that share a name show their family on a second line. It is one list: with an empty
  search the quick deck the header's picker had leads it, in its order (`quickDeck`: the favourites starred in
  Effect settings, the presets saved here, the party looks), then the rest A to Z, each effect once; a search
  shows matches only, A to Z ("fix all bugs", 2026-11-15; "One list", 2026-11-17).
  It says Current effect only while the show plays unfrozen, Selected effect otherwise. Under the Visualizer
  source the card shows one sentence about it and nothing to choose, met or not, with the amber unmet line
  while it cannot paint; under Squid, and under Effects for Stems in Space, that line sits above the list. Palettes names
  the selected palette over its list, two columns where readable; one button folds the colour wheel and the
  colour order together, folded until it is opened. An effect with a palette per band keeps its Bands card.
  With an Audio-reactive effect selected, playing, frozen or stopped, the Effects card shows its Active and
  Mellow looks and its colour wells between the search and the list (what only the header's picker had).
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
  the strobe overlays) are not offered on Show (2026-11-14, 02:39: "uv wash
  is brocken effect? dop we need it at all? we have button for that right?"). Pads, cues, sequences and the
  API still play them, a look whose effect is one of them is still named, and Effect settings lists them.
