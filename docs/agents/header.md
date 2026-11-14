# Header (top bar) rulings

Read before changing the header, the picture source control, play/stop, Freeze,
Blackout, Arm or the master. The header was built from the 2026-11-05 brief (#108,
revised in #113 and #126); its full text is in git history. The rulings below stay.

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
- A disarmed show nobody attends stops after 60 minutes (2026-11-14): "if not we should make sure it
  stops automatically, lets say 60min or somethign?? i mean if show is not arm and page is idel or
  closed". `outputs.idleStopMin` (60, 0 never) without a control action or page input ends it with the
  header's Stop; an idle page releases its feeds and says "Preview paused after 60 minutes without
  input." with Resume preview, which starts nothing. Armed, neither runs.
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
- Show also selects effects from a contained, searchable list beside the stage, with the chosen
  effect pinned above it (approved 2026-11-14). It says Current effect only
  while the show plays unfrozen, Selected effect otherwise. While the Visualizer source has a
  picture arriving, the card shows one sentence about it and nothing to choose. Colours sits under the stage; only its
  wheel folds, from the card's top-right button. Background ends the right column. On a phone
  the order is Stage, Effects, Colours, Background. The stage opens in 3D; 2D remains selectable.
  Detailed effect controls stay in Effects. Show scales with the window, no fixed pixel sizes
  (2026-11-14): its block in style.css has no px, the columns follow the view's own width at
  35em and 68.75em, and the page scrolls when the minimums do not fit.
