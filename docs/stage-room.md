# Rooms in Stage

Stage can draw a private room model instead of the generic venue. Open Stage's
room controls to import a room JSON file, place fixtures, and edit or remove
bindings. Room data lives in `config/stage-room.json`, served through the same
authenticated API as the lighting controls. It is not part of a public source
checkout.

Use Download room JSON to preserve saved placements before replacement. Replacing
or clearing a room with saved positions asks for confirmation, as does discarding
changed placement fields.

Room geometry changes the preview and the room form of the Spatial effects, which
sample each light's bound position in metres. It does not move fixtures in the
engine's Rig plot, alter any other effect or arm outputs. Keep those placements consistent
when commissioning the room. Estimated dimensions and bindings remain marked
as estimates; a detailed model does not prove measured optical timing.

An imported room displays explicit fixture bindings. A fixture without a binding
remains listed for placement; when it has a Rig plot position, Stage draws it where the
effects sample it (`plotPosition` in `src/shared/space.ts`: plot x and y percent of the
room's width and depth, height percent of its height), each cell of an explicit cell map at
its own point inside a dark, see-through body spanning its pixels, and the list says so. A fixture with no position anywhere is not drawn, so no
location is invented. Cells left unbound in a partly bound fixture (a pixel map's gaps) are
not drawn either; the effects sample each at the nearest bound cell of its fixture.
One output unit can have several visual bindings when a shared channel drives
several physical lights. `unit` is the zero-based light/cell within a fixture,
not a DMX channel or an index in the entire rig. On a panel whose grid has places
without a cell (a WLED read with its ledmap), `unit` counts the cells there are, in
row-major order, not the grid's places; reading such a WLED again in Rig → Outputs
moves the room's bindings for it to the cells at their columns and rows.

## Room format

Version 1 uses metres and radians. The floor is centred on the origin: `x` is
left/right, `y` is height, and `z` is floor depth. Apply the same transform to
walls, furniture and fixture positions when exporting a floor plan. A source's
revision and measurement confidence can be retained in the model.

```json
{
  "version": 1,
  "name": "Example room",
  "source": { "name": "Room survey", "revision": "1", "confidence": "estimated" },
  "bounds": { "width": 6, "depth": 4, "height": 3 },
  "rooms": [{
    "id": "main", "label": "Main room",
    "polygon": [[-3, -2], [3, -2], [3, 2], [-3, 2]],
    "color": "#9a8a78", "ceiling": "#e8e8e8",
    "floorPattern": { "kind": "planks", "width": 0.0615, "length": 0.45, "lengthSpread": 0.055,
      "angle": 90, "bond": "random", "tone": 0.17, "grain": 0.15, "joint": 0.4, "jointWidth": 0.0006 }
  }],
  "objects": [{
    "id": "back-wall", "kind": "box", "role": "wall",
    "position": { "x": 0, "y": 1.5, "z": -2 },
    "size": { "x": 6, "y": 3, "z": 0.1 }
  }],
  "bindings": [{
    "id": "lamp", "fixtureId": 17, "unit": 0,
    "position": { "x": -1, "y": 2.2, "z": 0 },
    "confidence": "estimated"
  }]
}
```

Objects are `box`, `cylinder`, `prism` or `mesh`, with role `wall` or `furniture`.
Position is the object's centre; size is its local width, height and depth.
Every wall, hidden or not, and opaque furniture (opacity 0.9 or more, not bound to a
light) stop a directional beam and take its pool: a box by its sides, a prism or
cylinder by its outline, a mesh by its triangles, so a beam passes a mesh wall's
openings. The bounds' floor, ceiling and walls stop the rest. A pool shows only on
the surface it lands on, inside the room polygon that holds its centre, and not
past a wall from its centre.
A pool shows from the side its surface faces, which is the side its light comes from:
light on a wall's face is not drawn for a view from behind that wall, whether the wall
stands at full height, is cut away or is hidden. A pool on a ceiling shows from above as
well: the room's ceiling is never drawn, so nothing else would show the light on it. A
pool is on a ceiling when the surface it lies on faces down within 45° of straight down:
the room's own ceiling, and the underside of furniture or of a wall. An object drawn
opaque hides the pool on its underside from above, as it hides that underside; under an
object drawn see-through (opacity below 1), under a hidden wall and under the part of a
wall that Cutaway takes away, the pool shows from above too.
A beam's haze, the cone drawn from its lamp to where it lands, shows only where the
lamp's light is: inside the room's bounds, on the lamp's side of the floor and of the
ceiling, in the room the lamp stands in and the one its pool lies in, and not past a
wall from the lamp, hidden or not. So none shows in a gap between two room polygons, or
in a room the beam only passes through. A lamp outside every room polygon belongs to the
room whose edge is nearest; a wall a lamp is set into stops neither its beam nor its
haze. A wall stops haze and clips a pool by its box, whatever its shape: where a beam
passes a mesh wall's opening, its haze ends at that wall. Furniture does not cut haze.
Optional `rotation` contains `x`, `y`, `z` Euler angles in radians. A cylinder's
local axis is Y; X/Z sizes are diameters. A prism also needs a local X/Z polygon
within its width/depth. Room polygons use world X/Z coordinates. Colours are
optional `#RRGGBB` values: an object's `color`, a room's `color` for its floor and its
`ceiling` for its ceiling. Stage takes a surface's colour as what it reflects of the light
that lands on it (see the pools below). IDs must be unique within each collection.

A room's optional `floorPattern` lays its floor as boards or tiles, with its `color` their
mean, so the floor returns as much light as without it (`public-src/stage3d/floor-pattern.js`).
`kind` is `planks`, `tiles` or `deck`; `width` and `length` are a piece's size across and along in
metres (a deck: square click tiles `length` a side of planks `width` wide, one along an edge, the
rest beside it and one across their ends, every other tile turned a quarter), `lengthSpread` how far each end joint moves either way at random, `angle` the degrees
from x toward z the pieces' length runs at, `bond` the share of a length each row is shifted by
(0–1) or `random`, `origin` the [x, z] a piece's corner lies on, `tone` the spread of the pieces'
light (a share of the mean), `grain` their streaks, and `jointWidth` (metres) and `joint` (a share
of the mean, up to 3 for light grout) the joints between them. Stage paints the floors as one
picture over the bounds, up to 5 mm a texel; a pool on the floor takes its colour from that
picture where it lands, so the boards show under the light.

A `mesh` contains `mesh: { vertices: [[x, y, z], ...], triangles: [[i, j, k], ...] }`.
Vertices are normalized local coordinates in −0.5…0.5, scaled by the object's
`size`, then rotated and placed at `position`. Centre the geometry around its
local origin when exporting. Triangle indices are zero-based and must refer to
three different existing vertices enclosing a nonzero area; winding determines
the outside face. Near-zero triangles (cross-product squared length ≤ 1e-20) are
rejected. Meshes support furniture and walls; screen meshes need texture coordinates
and are not accepted. Stage draws each mesh with an index of its own, 32-bit where
it needs one, so only the request limit below bounds mesh geometry; decimate detailed
source models and round exported coordinates to stay within it. Downloads use compact JSON so valid detailed rooms can be imported again. Stage computes smooth surface normals and uses fixed neutral lighting
to show relief without drawing triangle outlines. Object colours affect the preview
only; they do not change fixture output colours. Mesh data is inline and private,
with no external model URL or source asset needed by the public application.

A physical light driven by several output units can use `aggregation: "weightedMean"`
and `sources: [{ "fixtureId": 17, "unit": 0, "weight": 1 }, ...]` instead of
`fixtureId`/`unit`. It draws one marker whose linear RGB is the weighted mean of
the sources. Weights must be positive and their sum finite; a binding accepts up
to 64 unique source units. Missing sources count as black and appear as incomplete
coverage. This estimates the whole lamp's colour, without inventing segment
positions. The placement editor can add, change or remove source units and weights.
Shared source units are listed explicitly: changing one output can affect several
physical lights, regardless of their separate preview markers.

A room binding may include a surveyed `path` of 2–128 points in room metres. Stage draws
its corners as a continuous strip using that binding's source colour, including weighted
sources. Moving its position translates the whole path. Point-only imports remain markers;
re-export known strip geometry to give them their physical shape. Room imports accept at most
8192 strip edges and reject zero-length edges and paths outside the room bounds.

A binding's optional `lightTarget: { x, y, z }` aims its preview at a lit surface.
It uses the room coordinate frame and must differ from the emitter (the path
midpoint for strips). Optional `lightTargetConfidence` is `estimated` or
`measured`; photo-derived directions are estimates. The target overrides fixture
pan/tilt in this room while keeping its beam spread; a light without a beam lights
the surface it is aimed at in place of the floor under it. The first wall, opaque
furniture surface or room boundary receives the pool, as for any beam.
Physical positions, output addressing and effect sampling remain unchanged.

Every light gives the room one pool, where its light lands, drawn by the lux (lumen a square
metre) it throws there as the surface there reflects it:

- A lamp with a beam (a **Light shape** of directional beam, or a Hue spot, pendant, ceiling or
  wall fitting its bridge names) throws it where it is aimed, else by its own pan and tilt, onto
  the first surface that meets, with its cone in the haze. Its intensity falls to half at half
  its beam angle, so its lumen and that angle give the candela on its axis: 567 cd for Hue's
  350 lm, 43° GU10, where its maker states 570. What lands at the pool's centre is that over
  the square of the throw, turned by the angle the beam strikes at.
- Any other lamp shines all round, its lumen over the sphere at that distance. Its pool lies on
  the surface it is aimed at, else on its room's floor under it, whatever furniture stands
  between.
- A strip with a surveyed `path` throws a band for each section of the path, level along the
  section. Aimed, it faces its surface with its LEDs' 120° (what Hue states for its strips) and
  lights it by the section's lumen; without an aim it shines all round onto the floor under
  it, where an upright section's pool is round.
- A fixture bound pixel by pixel (a panel, a cube, a ball, a strip without a path) throws one
  band for all those pixels, in their mean colour, on the floor under their centre, as a line
  of light that shines all round. It is level along their longest level extent and across
  their extent the other way. A strip that turns corners needs a `path` to be lit along its run.

A surface of colour c lit with E lux shows c × E / E_white, in linear light, where E_white is
108 lx (`E_WHITE` in `public-src/stage3d/world.js`): a white surface lit with 108 lx shows
display white. 108 lx is the scale every pool was drawn at before pools took their surface's
colour (full at 97 lx, at 0.9 of that), so on a white surface a pool shows what it did and a
darker one less. A pool's level, the lux at its centre over E_white, has no cap, and it is at
half that level where half as much lands, however bright: 0.77 of its height to the side under
a lamp, 0.34 of its throw to the side for a 43° beam. From 2.45 m, Hue's spot throws 94 lx
(level 0.87) with its half level 0.83 m out, and an 806 lm bulb 11 lx (0.10) with its half
level 1.88 m out; a 900 lm a metre strip 5 cm off a wall lands about 9,000 lx along it, 83 times
what shows white, and half of that 0.04 m to either side. A beam's cone in the haze is as strong
as the light its pool takes, and full from the 97 lx a beam of unknown lumen lands. No light
counts as nearer a surface than a bulb's own 3.5 cm.

The colour of the surface is its reflectance, channel by channel. A pool on the floor takes its
room's `color`, one on the ceiling the room's `ceiling`, one on a wall or on furniture that
object's `color`. A floor or an object the model gives no colour reflects as Stage draws it
(#3a3e48 for a room's floor, #2a2d35 for the floor outside every room, #747985 for an object); a
surface Stage does not draw (a ceiling without `ceiling`, the walls and ceiling of the room box)
reflects the light whole, as every pool was drawn before. The room panel lists the lit surfaces
the model gives no colour. The generic venue has no surfaces: its pools reflect their light whole.

The room's surfaces shade under a fill of 7 lx on a level surface (`E_FILL`) through the same
exposure: unlit, a level surface shows its colour × 7 / 108. 7 lx makes a floor of reflectance
0.22 (oak) show unlit what the default floor showed under the fill before pools took their
surface's colour (sRGB 29, 32, 39 read back). The fill keeps its sky and its key light in their
shares; three.js shades a surface lit with intensity I as its colour × I / π (read back: 0.97 to
1.02 of that, with its specular share), and the two are scaled by that.

Stage adds light in a linear half-float buffer, so pools, beams and glows add as light: four
pools of 0.05 of white on one spot show 0.2 (sRGB 124), where adding them as encoded values
showed 252. The output encodes once, and a pixel past white is divided by its largest channel,
so it keeps its hue and saturation: orange at three times white stays orange, not yellow. A GPU
multisamples the buffer; a software renderer (SwiftShader, llvmpipe) draws it without, since
multisampling a half-float buffer costs one about three times the frame.

What a light shows is the light its bytes make (`lightRGB` in `public-src/unit-light.js`, one
function for the 3D room and the 2D plot). The engine renders every output as linear light
(`src/shared/color.ts`), and a DMX dimmer, an LED driver or a WLED board running realtime data
without gamma (its "Disable realtime gamma correction", `live.no-gc`, on) turns the byte into duty.
So on a DMX output over Art-Net or sACN, on DDP and on OpenRGB a byte is that share of full light:
128 is 0.502. The 3D room takes that light as it is; the 2D plot paints it encoded for the display,
128 as sRGB 188. Every output's byte is drawn as the linear light the engine renders, a Hue
bridge's too: for Hue lamps this is the operator's choice of 2026-11-24, not a measurement of the
bridge's curve from the streamed RGB to the lamp's light. A WLED board with realtime gamma correction
on, or any driver with a curve of its own, gives less light at mid levels than Stage draws.

A pool is clipped like any other: the one under a light to the room its light stands in, where
a light outside every room polygon, such as one hung in the line of a wall, belongs to the room
whose edge is nearest. A light under the floor or above the ceiling throws none under it. Room
objects drawn for a light (`lightBindingId`) move neither its pool nor its cone; a `lightTint` on
them filters both (see the end of this page).

How strongly a pool is drawn follows its light's lumen at full white. A Hue lamp has the lumen
of the product its bridge names (a GU10 spot 350 lm, a candle 470 lm, a Play bar 500 lm, a light
strip 800 lm a metre; `HUE_LUMEN` in `src/shared/emission.ts`, the maker's figures at 4000 K,
rounded), any other strip 484 lm a metre of surveyed run and a pixel 4.1 lm. A panel's pixels
closer than a 60-per-metre strip's are smaller LEDs and count by the area each has (a 5.6 mm
pitch gives 0.46 lm a pixel); that figure is an estimate. A pixel's 4.1 lm (`PIXEL_LUMEN`) is a
WS2812B's at full white, from the luminous intensity Worldsemi's datasheets give each colour: the
original sheet red 390–420, green 660–720 and blue 180–200 mcd, the V5 sheet at 12 mA red
300/310/500, green 600/780/1000 and blue 200/215/300 mcd (min/typical/max). A Lambertian emitter
gives π times its axial intensity, Φ = π·ΣIv: 4.1 lm at the V5 sheet's typical figures, 3.5 to
5.7 lm over its range. It stays an estimate, since neither sheet states the viewing angle. One
such LED 2.6 m up lands 0.048 lx on the floor under it. A beam of unknown lumen (a DMX par)
lands 97 lx at its centre, 0.9 of E_white (`PAR_LEVEL`), as such a pool was drawn before, at
half its level where half of its own centre's light lands; aimed in a room it counts as an
806 lm bulb. Any other light of unknown lumen counts as an 806 lm
bulb too, except the one light of a fixture sent as LED data (DDP, OpenRGB) for which nobody
chose a **Light shape** or typed a **Lumen**: it is a single LED and counts as a pixel. The
generic venue knows no lumen: its beams land by the same rule, each pool as a beam of unknown
lumen's.

A fixture's own figure comes first: the **Lumen** of its light shape (`emission.lumen`, set in
the fixture inspector) is what the whole fixture gives at full white, for any output. Its units
share it; where its markers lie along surveyed paths, it is spread over their metres of run.
Without one, a Hue lamp takes the row of the product its bridge names, and a lamp no row names
counts as the E27 bulb. The rows are the maker's figures at 4000 K (its product pages, and the EU
product registry EPREL where a lamp is entered there):

| Product name holds | Lumen | Per metre of run | From |
|---|---|---|---|
| gradient tube | 1800 | 1300 | the large tube, 1,800 lm over 1.377 m; the compact one gives 1,540 lm over 0.877 m |
| play gradient lightstrip | 1100 | 430 | 1,100 lm whatever the size; per metre the 65 inch strip's 2.54 m (55 inch 2.165 m, 75 inch 3.04 m) |
| gradient lightstrip | 1800 | 900 | the 2 m strip |
| lightstrip | 1600 | 800 | Lightstrip Plus, the 2 m base; its later model gives 1,700 lm |
| Centris ceiling | 2500 | | the panel of the three-spot bar: the fixture's 3,550 lm less three 350 lm spots |
| spot, GU10 | 350 | | the 5.7 W colour GU10 (EPREL 1508900); the 4.2 W lamp of 2024 gives 400 lm (EPREL 1805047) |
| candle | 470 | | the E14 candle (EPREL 1522893) |
| Play | 500 | | the Play light bar |
| Go table | 530 | | the Go portable table lamp |
| Go | 300 | | the first Go; its second model gives 530 lm |
| any other | 806 | | the E27 bulb, all round (EPREL 1522885) |

The three sizes of the play gradient lightstrip give the same 1,100 lm, so a per-metre row holds
for a product at its own length; a run of another length is better stated as its own Lumen.
The registry gives a beam angle for directional lamps only. Hue's GU10 has 43° (the 5.7 W
colour lamp, 570 cd on its axis; EPREL 1508900 and 387862), which is the spread a spot is
drawn with; the white ambiance GU10 has 42° (EPREL 391948) and the 4.2 W colour lamp 40°. The
120° of a pendant, a ceiling fitting or a Centris ceiling panel, the 90° of a wall fitting and
the 55° of spots combined on one channel are assumptions, as are the 484 lm a metre and the
120° of a strip that is not Hue; a pixel's 4.1 lm is the datasheet estimate above. The beam's
shape is one too: against the candela the registry states for twelve of the maker's GU10 lamps,
lumen and beam angle give 0.77 to 1.44 times as much. Light that walls and ceiling throw back is not drawn.

Optional `anchors` name points effects can start from, such as speakers:
`[{ "id": "speakerLeft", "position": { "x": -1.5, "y": 1, "z": -1.5 } }]`. Optional
`listeners` are listening positions with a facing in degrees, seen from above: 0 looks
toward −z (the top of the Rig plot) and 90 toward +x:
`[{ "id": "desk", "position": { "x": 0, "y": 1.15, "z": 0 }, "facingDeg": 0 }]`.
Both stay inside the room bounds; a room holds up to 32 anchors and 8 listeners, and their
IDs must be unique across the whole room. A room without them is unchanged.

Models accept up to 128 room polygons, 1,500 objects and 4,096 bindings, with up
to 128 vertices per polygon and 8,192 total source references. A request carries at most
12 MiB of JSON: the server parses, validates and stores an import on its main thread, about
0.1 s per MB, and 12 MiB is three times the largest real room (a whole flat with detailed
furniture, 4.2 MB). External asset URLs, scripts and unrecognised fields are rejected. Keep the original floor-plan
source and measurements separately; this is a rendering format, not an archive
of the floor-plan source.

## WLED's current limit

A WLED limits the current it estimates for its LEDs on every frame, realtime data included,
and the Stage dims a board's light the same way, frame by frame, in the 3D room and the 2D plot
alike (`src/shared/wled-power.ts`; WLED 16.0.1, `wled00/bus_manager.cpp`). Each LED adds
its four channels to its bus's sum after the board's master brightness (`BusDigital::setPixelColor`,
lines 270-292; on an RGBW bus after its auto-white, lines 102-120); the brightest of red, green and
blue alone, times three, on the WS2815 model (`ledma` 255, lines 196-201). A bus's estimate is
that sum times its mA per LED over 3 × 255 (4 × 255 with white), plus 1 mA a LED, in integer steps
(lines 196-206). Without a global limit each bus with mA per LED and a limit takes its limit less
the board's own share (120 mA on an ESP32, 80 on an ESP8266, split over those buses), at least
1 mA a LED (lines 1458-1479); over it the bus shows at `limit × 255 / estimate + 1` of 255, and a
limit not above its LEDs at 1 (lines 208-227). A global limit (`hw.led.maxpwr`) replaces the buses'
own: the board's limit less its share, against the sum of all estimates, dims every bus with mA
per LED alike (lines 1482-1520). What a cell shows is its light times the mean of its LEDs'
`newBri / 255` and the master brightness the board runs realtime data at (`bri`, scaled by
`light.scale-bri`; 255 with "Force max brightness", `if.live.maxbri`). So a dense, bright frame on
a tight limit is dimmed to a fraction and a sparse one not at all, whatever lumen the light has.

The server reads each board for it (`src/server/wled-power.ts`): `/json/info` (`arch`),
`/json/cfg` (`hw.led.ins[]`, `hw.led.maxpwr`, `if.live`), `/json/state` (`bri`) and, when realtime
data follows the ledmap (`if.live.rlm`, `FX.h:952-954`), the ledmap. It reads every WLED the patch
sends DDP to and every host a DMX universe goes to (Art-Net nodes that claim it, Art-Net's host
when it is one device, sACN's host), when the server starts, when the patch reaches other hosts,
and when Stage opens; never per frame. The result lives in memory only (`GET /api/stage/supply`):
nothing of it enters `show.json`, an output or the board. Each cell's LEDs are counted from the
step transmit sends them by (the spread and runs of `src/server/ddp-routes.ts`), at their logical
index, plus the board's realtime offset, through its ledmap to the bus whose range holds them;
several fixtures can share a bus and one can span several. A fixture sent as DMX counts on a WLED
in DMX mode 4, one RGB triple per LED (`e131.cpp:308-358`): in the board's first universe LED i
reads from its address on, from channel 1 in each later one, after the first universe's
(512 - address + 1) / 3 LEDs and 170 a universe between.

What stays unmodelled: a board that does not answer draws as before, unlimited, and Stage lists it
with its fixtures under "WLEDs drawn without their current limit", as it lists one that gamma-corrects
its realtime data (`light.gc.col` with "Disable realtime gamma correction" off), its brightness
(`light.gc.bri`), or sends realtime data to its main segment only (`if.live.mso`). A DMX fixture on
a board whose DMX input is on in another mode, or whose cells are not red-green-blue triples on its LEDs, is drawn
unlimited and listed; a DMX host that does not answer as a WLED is not listed, since an Art-Net
node need not be one, and the board's own count of universes is not checked. LEDs no fixture
drives count as dark (WLED clears the strip when realtime data starts, `udp.cpp:410-424`). White
balance, CCT channels, brightness transitions and the rounding of the dimmed bytes are not
modelled, and a ledmap is read only for a board set up as a matrix. The tests' servers read no
board (`LIGHTSHOW_WLED_READS=0`).

## API and concurrent changes

`GET /api/stage/room` returns `{ ok, room, revision }`. With no imported model,
`room` is `null` and `revision` is `empty`. GET supports `If-None-Match` and 304
responses, so clients can check for updates without downloading unchanged
geometry. The browser keeps the room it last loaded or saved
(`public-src/stage-room.js`) and asks with `If-None-Match` whenever a view that
draws it mounts: while the revision stands, Show and Effects keep the same room
object, and the 3D scene keeps the room and rig it built from it.

`PUT /api/stage/room` accepts the room object above. `DELETE /api/stage/room`
returns to the generic venue. Both require `If-Match` with the revision from
GET: missing revisions return 428; an intervening edit returns 412. Reload and
review that edit before replacing it. Failed validation or disk writes preserve
the previously loaded model.

A furniture object may set `lightBindingId` to an existing binding ID. Its surface
retains its base colour while off and emits that binding's current Stage RGB, including weighted
source mixtures and missing-source black contributions. The binding's separate
marker is replaced by the object; its coverage and source data are retained. This
uses the same live/preview frame and power-state semantics as other Stage lights.
Lit surfaces blend their neutral diffuse colour toward 0.35 × the current linear RGB and
add restrained emission (intensity 0.25), preserving hue and directional relief.
An off frame removes the light's emission while leaving the physical shell visible. Multiple
object parts may share one binding; unbound parts remain ordinary scenery. This is
preview rendering only and never moves or changes an output fixture.

A bound furniture object can optionally set `lightTint: "#c4dbea"` to model a
coloured translucent shell around its light. Stage converts both the tint and live RGB
to linear light and multiplies them, on the object's surface before shading and in the
light the shell lets into the room: the light's pool or pools and its beam's cone. A lamp
in a dark shell lights the room as little as the shell lets through. Where several objects
of one binding carry tints other than white, the first of them in `objects` order filters
the room's light. The pixels of a fixture that share one pool each pass their share
through their own binding's shell. A white (`#ffffff`) or missing tint renders as without
one. The tint adds no light to black frames and changes no output colour. The object's
base `color` remains its appearance when off.

A bound furniture object can also set `lightAfterglow: "#2a6040"`, the own light of a
glow-in-the-dark material. Stage shows it as a constant emission at that colour, in
linear light and whatever the emission intensity, whether the binding's light is lit,
off or black; a lit frame adds the light's own emission on top, and the tint does not
filter the afterglow. It lights nothing else: no pool, no cone. Like `lightTint` it needs
a `lightBindingId`, and an object whose binding is removed loses all three.

Objects may set `opacity` from 0 (invisible) to 1 (opaque), for example `0.4`
for glass. Omitted opacity preserves the opaque default. Transparent objects
blend with the scenery behind them without writing depth; this affects only Stage.
