# Top bar redesign: design brief (draft for review)

Status: draft, 2026-11-05. Nothing is built until the operator approves this brief.

## Why

The operator, 2026-11-05:

- "i hate lightshow webfrontend design. where is my visualizer to select? also what sense has programme on top?"
- "visualizer colour and effect should be part of top bar? the whole new top bar design don't really like"
- "why do we show colours if we dont have the option? like visualizer or we follow visualizer colour?"

The current header came from PR #96 (merged 2026-11-02). Its design followed the operator's rulings of
2026-10-28: "the main controls should stay same place all the time, so we dont need to search for them.
also they should not be duplicated elsewhere? nor be indirectly used" (12:31), "make sure blackout and
freeze are not activated unwanted" (11:33) and "much simpler doesnt mean better" (11:32). Those rulings
stay; the layout that implemented them is what failed.

## What is there now (Effects view, 1915 × 1367 desktop)

| Band above the content | Height | Contents |
| --- | --- | --- |
| Header | 120 px | brand, seven status pills, theme/awake/fullscreen; Programme select, Start, Stop, Freeze, Blackout, Arm, Master slider, status text; "Main effect" line |
| Command bar | 84 px | tempo, TAP, divisions, pads bank A |
| View tabs | 55 px | ten views |
| Picture source row | 59 px | Effects / Colour + motion / Visualizer and a hint line |

That is 318 px of chrome before any content. Specific failures:

- **The visualizer is hard to find.** Choosing it is a 26 px segmented control in the fourth band. Its
  effect (Active/Mellow) lives in the effect editor in Effects; its colours are a card in Perform that only
  appears for one preset kind. Three places for one thing.
- **Programme is unexplained.** It is what Start starts (Look, Auto show or Sequence). It replaced the
  separate Auto show switch and Sequence play button so there would be one Start; the label does not
  say that.
- **Controls that do nothing stay visible.** The Colours card stays live while the visualizer picture
  paints the room with its own colours.
- **Duplicates.** The Master pill repeats the Master slider beside it.
- **A stale fault.** "The renderer did not acknowledge this change. Refresh before trying again." stays in
  the header until the next control change applies (seen with revision 6 against applied 5).

## Goals

1. One header row on desktop, at most 64 px, holding what a party reaches for: what paints the room,
   play/stop, Freeze, Blackout, Arm, Master.
2. The picture source is the first control. Choosing Visualizer shows its effect and colours right there.
3. Nothing is shown that does nothing in the current state: colour controls say what drives the colour
   instead.
4. The 2026-10-28 rulings hold: same place on every tab, no duplicates, nothing changes Freeze or
   Blackout as a side effect.

Non-goals: the views' own content; the control protocol of PR #96 (sessions, revisions, acknowledgements
stay); the command bar (tempo, pads), which keeps its current rules.

Anti-goals, a failure even if it works: Blackout or Disarm behind a menu; a second play button elsewhere;
a colour picker that changes nothing; a header that wraps to three rows on a laptop.

## Proposal (the author's calls, for review)

Desktop, one sticky row:

```text
[mark] [Effects: Swirl ▾ | Colour + motion | Visualizer: Splotch ▾ ●●●●]  [▶ Look ▾] [Freeze] [Blackout] [Arm]  Master ━━━●━ 100 %  [● 143.8] [⋮]
```

- **Source first.** The three sources are one segmented control. The active one shows what it plays
  ("Effects: Swirl"). Its ▾ opens a small panel: for Effects the effect picker shortcut; for Visualizer
  the Active and Mellow choices, the colour chips and the "colours follow the picture" switch. The
  picture-source band under the tabs goes away.
- **Play names its target.** Programme becomes a split button: "▶ Look ▾", with Auto show and Sequence
  in its menu. Stop is the same button while playing ("■ Stop Look"). One Start, and it says what it
  starts.
- **Safety stays visible.** Freeze, Blackout and Arm keep their own buttons at fixed positions, with the
  current 44 px touch targets.
- **Status collapses.** One chip shows the connection dot and BPM; its popover holds Energy, Strobes,
  Flash, Auto and the rest. The Master pill goes (the slider shows the value). Theme, Keep awake and Full
  screen move to ⋮.
- **Colours say why.** When the visualizer or Colour + motion drives the colours, the Colours card
  shrinks to one line, "Colours follow the picture", with the switch to take them back.
- **Faults are toasts.** A control fault shows once as a toast with Refresh, and clears when a later
  revision applies.

Phone (680 px and below), two rows:

```text
[Effects | C+M | Visualizer ▾]                         [⋮]
[▶ Look ▾] [Freeze] [Blackout] [Arm]   Master ━━●━
```

Target: header 56–64 px on desktop, chrome above the Effects content at most 200 px.

## Open questions for the operator

1. When the room looks wrong at a party, what do you reach for first? This decides the left-to-right
   order.
2. Play target: the split button above, or no Auto show/Sequence in the header at all (they would start
   from their own views, which breaks the one-place rule)?
3. Which status, if any, must stay visible without a tap: BPM, Online, Armed?

## Left to the builder

Icons, exact spacing, keyboard shortcuts and accessible names (keep every current label reachable),
browser-suite coverage for the header at 1915, 1024 and 390 px, unchanged performance budgets. Never
name the apps the lightshow was ported from.
