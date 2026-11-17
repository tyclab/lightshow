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
    "polygon": [[-3, -2], [3, -2], [3, 2], [-3, 2]]
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
A beam's haze, the cone drawn from its lamp to where it lands, shows only where the
lamp's light is: inside the room's bounds, on the lamp's side of the floor and of the
ceiling, in the room the lamp stands in and the one its pool lies in, and not past a
wall from the lamp, hidden or not. A lamp outside every room polygon belongs to the
room whose edge is nearest; a wall a lamp is set into stops neither its beam nor its
haze. A wall stops haze and clips a pool by its box, whatever its shape: where a beam
passes a mesh wall's opening, its haze ends at that wall. Furniture does not cut haze.
Optional `rotation` contains `x`, `y`, `z` Euler angles in radians. A cylinder's
local axis is Y; X/Z sizes are diameters. A prism also needs a local X/Z polygon
within its width/depth. Room polygons use world X/Z coordinates. Colours are
optional `#RRGGBB` values. IDs must be unique within each collection.

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
pan/tilt in this room while keeping its beam spread, with a 100° wash for lamps
without a beam spread. The first wall, opaque furniture surface or room boundary
receives the pool, as for any beam.
Physical positions, output addressing and effect sampling remain unchanged.

Every light gives the room one pool. An aimed lamp's and a beam fixture's lies where the beam
lands. Any other light's lies on the room's floor under it, whatever furniture stands between.
It reaches 0.7 m around a light lying on the floor and 0.45 m more for each metre the light
stands above it, up to 2.6 m:

- A lamp throws a round pool.
- A strip with a surveyed `path` throws a band under each section of the path: a lamp's pool at
  that height, longer by half the section either way. An upright section throws a round pool
  from the height of its middle.
- A fixture bound pixel by pixel (a panel, a cube, a ball, a strip without a path) throws one
  band for all those pixels, in their mean colour, under their centre. It runs along their
  longest level extent, longer by half of it either way and wider by half their extent across.
  A strip that turns corners needs a `path` to be lit along its run.

Such a pool is clipped like any other, to the room its light stands in; a light outside every
room polygon, such as one hung in the line of a wall, belongs to the room whose edge is nearest.
A light under the floor or above the ceiling throws none. Room objects drawn for a light
(`lightBindingId`) change nothing about its pool, with one exception: a beam fixture they draw
throws a beam only when it is aimed, and without an aim has the floor pool.

How strongly a pool is drawn follows its light's lumen at full white. A Hue lamp has the lumen
of the product its bridge names (a GU10 spot 350 lm, a candle 470 lm, a Play bar 500 lm, a light
strip 800 lm a metre; `HUE_LUMEN` in `src/shared/emission.ts`, the maker's figures at 4000 K,
rounded), any other strip 484 lm a metre of surveyed run and a pixel 8 lm. A panel's pixels
closer than a 60-per-metre strip's are smaller LEDs and count by the area each has (a 5.6 mm
pitch gives 0.9 lm a pixel); that figure is an estimate. A pool is drawn at the lumen it spreads
over each square metre, full strength at 97 lm/m² (a 350 lm, 36° spot on the floor 2.45 m
below), so a wide wash from a small lamp is faint. A beam of unknown lumen (a DMX par) keeps a
full-strength pool. Any other light of unknown lumen counts as an 806 lm bulb, except the one
light of a fixture sent as LED data (DDP, OpenRGB) for which nobody chose a **Light shape** or
typed a **Lumen**: it is a single LED and counts as a pixel. The generic venue is drawn as before.

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
120° of a pendant, a ceiling fitting or a Centris ceiling panel, the 90° of a wall fitting, the
55° of spots combined on one channel and the 100° wash of an aimed lamp without a spread are
assumptions, as is the 484 lm a metre of a strip that is not Hue.
The 97 lm/m² of a full-strength pool is what 350 lm spreads over the foot of a 36° cone 2.45 m
long; Hue's 43° spot pointing straight down from that height is drawn at 0.68 of it.

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
An off frame removes emission while leaving the physical shell visible. Multiple
object parts may share one binding; unbound parts remain ordinary scenery. This is
preview rendering only and never moves or changes an output fixture.

A bound furniture object can optionally set `lightTint: "#c4dbea"` to model a
coloured translucent material. Stage converts both the tint and live RGB to linear
light and multiplies them before shading; the default white tint preserves existing
rendering. The tint filters illumination without adding light to black frames or
changing output colours. The object's base `color` remains its appearance when off.

Objects may set `opacity` from 0 (invisible) to 1 (opaque), for example `0.4`
for glass. Omitted opacity preserves the opaque default. Transparent objects
blend with the scenery behind them without writing depth; this affects only Stage.
